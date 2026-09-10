import http.server
import socketserver
import json
import sys
import os
import time
import subprocess
import hmac
from datetime import datetime

from radios_app.config import ADMIN_PASSWORD, ADMIN_TOKEN, ADMIN_USER, NOTICIERO_SCRIPT, PORT
from radios_app.security import (
    SQLiteRateLimiter,
    basic_auth_matches,
    get_client_ip,
    is_public_http_url,
    is_tailscale_ip,
)
from radios_app.storage import init_db
from radios_app.handlers.admin import AdminMixin
from radios_app.handlers.static import StaticMixin
from radios_app.handlers.search import SearchMixin
from radios_app.handlers.media_info import MediaInfoMixin
from radios_app.handlers.streams import StreamsMixin
from radios_app.handlers.tts_news import TtsNewsMixin
from radios_app.handlers.playlist_feedback import PlaylistFeedbackMixin

RATE_LIMITER = SQLiteRateLimiter()

init_db()


class RadiosHandler(
    AdminMixin,
    StaticMixin,
    SearchMixin,
    MediaInfoMixin,
    StreamsMixin,
    TtsNewsMixin,
    PlaylistFeedbackMixin,
    http.server.BaseHTTPRequestHandler,
):
    def do_GET(self):
        self._strip_radios_prefix()
        try:
            if self.path.startswith("/api/version"):
                self.handle_version()
            elif self.path.startswith("/api/admin/status"):
                if self._reject_if_rate_limited("admin-status", 60):
                    return
                self.handle_admin_status()
            elif self.path.startswith("/api/admin/check"):
                if self._reject_if_rate_limited("admin-check", 60):
                    return
                self.handle_admin_check()
            elif self.path.startswith("/api/curated"):
                if self._reject_if_rate_limited("curated-get", 120):
                    return
                self.handle_get_curated()
            elif self.path.startswith("/api/websearch"):
                if self._reject_if_rate_limited("websearch", 5):
                    return
                self.handle_websearch()
            elif self.path.startswith("/api/songinfo"):
                if self._reject_if_rate_limited("songinfo", 30):
                    return
                self.handle_songinfo()
            elif self.path.startswith("/api/lyrics"):
                if self._reject_if_rate_limited("lyrics", 20):
                    return
                self.handle_lyrics()
            elif self.path.startswith("/api/feedback"):
                if self._reject_if_rate_limited("feedback-get", 60):
                    return
                self.handle_get_feedback()
            elif self.path.startswith("/api/nowplaying-fragment"):
                if self._reject_if_rate_limited("nowplaying-fragment", 30):
                    return
                self.handle_nowplaying_fragment()
            elif self.path.startswith("/api/nowplaying"):
                if self._reject_if_rate_limited("nowplaying", 30):
                    return
                self.handle_nowplaying()
            elif self.path.startswith("/api/news"):
                if self._reject_if_rate_limited("news", 5):
                    return
                self.handle_news()
            elif self.path.startswith("/api/tts"):
                if self._reject_if_rate_limited("tts", 5):
                    return
                self.handle_tts()
            elif self.path.startswith("/api/healthcheck"):
                if self._reject_if_rate_limited("healthcheck", 600):
                    return
                self.handle_healthcheck()
            elif self.path.startswith("/proxy"):
                if self._reject_if_rate_limited("proxy", 30):
                    return
                self.handle_proxy()
            elif self.path in ("/admin", "/admin/", "/admin.html"):
                if self._reject_if_not_admin(allow_admin_page=True):
                    return
                self.handle_static()
            else:
                self.handle_static()
        except Exception as e:
            self.send_json({"error": str(e)}, 500)

    def _strip_radios_prefix(self):
        """Normalize path: strip /radios prefix so the server works both via
        Nginx (which already strips it) and when accessed directly on port."""
        if self.path.startswith("/radios/"):
            self.path = self.path[len("/radios"):]
        elif self.path == "/radios":
            self.path = "/"

    def _resolve_client_ip(self):
        """Return the effective client IP, respecting Nginx trusted proxy headers."""
        return get_client_ip(self.client_address, self.headers)

    def is_tailscale_request(self):
        """Return True if the request originates from Tailscale or loopback."""
        return is_tailscale_ip(self._resolve_client_ip())

    def _reject_if_not_tailscale(self):
        """Send 403 if the request is not from Tailscale; return True if rejected."""
        if not self.is_tailscale_request():
            self.send_json(
                {"error": "Forbidden: admin access restricted to Tailscale network"},
                403,
            )
            return True
        return False

    def _has_admin_credentials(self):
        """Return True if admin auth is disabled or the request carries valid credentials."""
        if ADMIN_TOKEN:
            token = self.headers.get("X-Admin-Token", "")
            if token and hmac.compare_digest(token, ADMIN_TOKEN):
                return True

        if not ADMIN_USER and not ADMIN_PASSWORD:
            return not ADMIN_TOKEN

        return basic_auth_matches(
            self.headers.get("Authorization", ""), ADMIN_USER, ADMIN_PASSWORD
        )

    def _reject_if_not_admin(self, allow_admin_page=False):
        """Tailscale + Basic Auth or X-Admin-Token para rutas admin/mutaciones."""
        if self._reject_if_not_tailscale():
            return True
        if self._has_admin_credentials():
            return False
        # Si se usa token, permitimos cargar /admin para mostrar el login propio.
        if allow_admin_page and ADMIN_TOKEN:
            return False
        body = b'{"error":"Authentication required"}'
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="Radios Admin"')
        self.send_header("Content-type", "application/json")
        self.send_header("Content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return True

    def _rate_limit_allow(self, bucket, limit, window=60):
        """Sliding-window rate limit persistido en SQLite."""
        return RATE_LIMITER.allow(bucket, self._resolve_client_ip(), limit, window)

    def _reject_if_rate_limited(self, bucket, limit, window=60):
        if not self._rate_limit_allow(bucket, limit, window):
            self.send_json({"error": "Too many requests"}, 429)
            return True
        return False

    def handle_admin_status(self):
        if self._reject_if_not_tailscale():
            return
        self.send_json(
            {
                "token_required": bool(ADMIN_TOKEN),
                "basic_required": bool(ADMIN_USER or ADMIN_PASSWORD),
            }
        )

    def handle_admin_check(self):
        if self._reject_if_not_admin():
            return
        self.send_json({"ok": True})

    def _is_public_http_url(self, raw_url):
        """Return True only for http(s) URLs whose hostname resolves exclusively
        to public IPs. This blocks SSRF to localhost, LAN, Tailscale, metadata, etc."""
        return is_public_http_url(raw_url)

    def _reject_unsafe_url(self, raw_url):
        """Send 403 for URLs that could be used as SSRF and return True if rejected."""
        if not self._is_public_http_url(raw_url):
            self.send_json({"error": "URL not allowed"}, 403)
            return True
        return False

    def do_POST(self):
        self._strip_radios_prefix()
        # Bloquea CSRF simple: sin application/json no se procesan APIs de escritura.
        content_type = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if self.path.startswith("/api/") and content_type != "application/json":
            self.send_json({"error": "Content-Type application/json required"}, 415)
            return
        if self.path.startswith("/api/curated") and self._reject_if_rate_limited("curated-write", 60):
            return
        if self.path.startswith("/api/playlist") and self._reject_if_rate_limited("playlist-save", 30):
            return
        if self.path.startswith("/api/feedback") and self._reject_if_rate_limited("feedback-post", 60):
            return
        if self.path.startswith("/api/curated/update"):
            if self._reject_if_not_admin():
                return
            self.handle_update_curated()
        elif self.path.startswith("/api/curated/reorder"):
            if self._reject_if_not_admin():
                return
            self.handle_reorder_curated()
        elif self.path.startswith("/api/curated"):
            if self._reject_if_not_admin():
                return
            self.handle_add_curated()
        elif self.path.startswith("/api/playlist"):
            self.handle_playlist_save()
        elif self.path.startswith("/api/feedback"):
            self.handle_feedback()

    def do_DELETE(self):
        self._strip_radios_prefix()
        if self.path.startswith("/api/curated"):
            if self._reject_if_not_admin():
                return
            self.handle_delete_curated()

    def do_OPTIONS(self):
        self._strip_radios_prefix()
        # No se responde con CORS abierto. Las APIs son same-origin.
        self.send_response(204)
        self.end_headers()

    def handle_version(self):
        try:
            vf = os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "version_check.json"
            )
            with open(vf, "r") as f:
                data = json.load(f)
            self.send_json(data)
        except Exception as e:
            self.send_json({"version": "0.0.0", "error": str(e)})




























    def send_json(self, data, status=200):
        try:
            body = json.dumps(data).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-type", "application/json")
            self.send_header("Content-length", len(body))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            print(f"Error sending JSON: {e}", file=sys.stderr)




    # ── Playlist Management ──





def _noticiero_scheduler():
    """Background thread: runs noticiero.py at :20 and :50 (pre-fetch 10 min before each newscast)."""
    while True:
        try:
            now = datetime.now()
            if now.minute in (20, 50) and now.second < 10:
                subprocess.run(
                    [sys.executable, NOTICIERO_SCRIPT],
                    capture_output=True,
                    timeout=35,
                )
                time.sleep(5)  # avoid re-trigger within same minute
        except Exception:
            pass
        time.sleep(15)


if __name__ == "__main__":
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    handler = RadiosHandler

    # Allow port override via command line args
    port = PORT
    if len(sys.argv) > 2 and sys.argv[1] == "--port":
        port = int(sys.argv[2])

    # Start noticiero scheduler in background — EN STANDBY (comentado, sin eliminar)
    # t = threading.Thread(target=_noticiero_scheduler, daemon=True)
    # t.start()

    with socketserver.ThreadingTCPServer(("", port), handler) as httpd:
        print(
            f"Serving Radios with Deep Search at http://localhost:{port}",
            file=sys.stderr,
        )
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            httpd.shutdown()
            print("\nServer stopped.", file=sys.stderr)
