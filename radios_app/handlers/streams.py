"""Proxy, healthcheck y metadata ICY."""
from __future__ import annotations

import html
import sys

import json
import re
import socket
import ssl
import time
import urllib.parse
import urllib.request


class StreamsMixin:
    def handle_nowplaying_fragment(self):
        """HTMX endpoint: returns an HTML fragment for the 'now playing' bar.
        Polling-friendly — HTMX calls this every 15s and swaps innerHTML.
        """
        parsed_path = urllib.parse.urlparse(self.path)
        query_params = urllib.parse.parse_qs(parsed_path.query)
        target_url = query_params.get("url", [""])[0]
        station_name = query_params.get("name", ["Radio"])[0]
        station_favicon = query_params.get("favicon", [""])[0]

        if target_url and not self._is_public_http_url(target_url):
            self.send_json({"error": "URL not allowed"}, 403)
            return

        title = None

        if target_url:
            # 1) Try ICY peek
            try:
                title = self._peek_icy_metadata(target_url)
            except Exception:
                pass

            # 2) Fallback to HTTP endpoints
            if not title:
                try:
                    parsed = urllib.parse.urlparse(target_url)
                    base = f"{parsed.scheme}://{parsed.netloc}"
                    for ep in [
                        "/7.html",
                        "/currentsong",
                        "/stats?json=1",
                        "/status.xsl",
                    ]:
                        try:
                            req = urllib.request.Request(
                                base + ep,
                                headers={
                                    "User-Agent": "RadiosApp/1.0",
                                    "Icy-MetaData": "1",
                                },
                            )
                            with urllib.request.urlopen(req, timeout=5) as resp:
                                body = (
                                    resp.read()
                                    .decode("utf-8", errors="replace")
                                    .strip()
                                )
                            t = self._parse_metadata(body, ep)
                            if t:
                                title = t
                                break
                        except Exception:
                            continue
                except Exception:
                    pass

        # Build favicon img tag if available
        favicon_html = ""
        if station_favicon:
            fav_parsed = urllib.parse.urlparse(station_favicon)
            if fav_parsed.scheme in ("http", "https") and fav_parsed.netloc:
                safe_favicon = html.escape(station_favicon, quote=True)
                favicon_html = f'<img class="htmx-np-favicon" src="{safe_favicon}" alt="" onerror="this.style.display=\'none\'">'

        # Music note pulse animation — always shown
        pulse_html = '<span class="htmx-np-pulse">&#9835;</span>'

        if title:
            # Clean up common "StreamTitle=" artifacts
            title = re.sub(r"StreamTitle='?([^;']*)'?.*", r"\1", title).strip()
            html_fragment = f"""<div class="htmx-np-inner htmx-np-active" title="Toca para ver info detallada">
  {pulse_html}
  {favicon_html}
  <div class="htmx-np-texts">
    <span class="htmx-np-station"><i class="fas fa-radio"></i> {html.escape(station_name, quote=True)}</span>
    <span class="htmx-np-title"><i class="fas fa-music"></i> {html.escape(title, quote=True)}</span>
    <span class="htmx-np-subtitle"><i class="fas fa-circle-info"></i> Toca para ver metadatos y detalles</span>
  </div>
  <span class="htmx-np-live">LIVE</span>
</div>"""
        elif target_url:
            html_fragment = f"""<div class="htmx-np-inner htmx-np-waiting" title="Sintonizando radio">
  {pulse_html}
  {favicon_html}
  <div class="htmx-np-texts">
    <span class="htmx-np-station"><i class="fas fa-radio"></i> {html.escape(station_name, quote=True)}</span>
    <span class="htmx-np-title htmx-np-dim"><i class="fas fa-spinner fa-spin"></i> Sintonizando transmisión...</span>
    <span class="htmx-np-subtitle">Conectando al servidor de audio</span>
  </div>
  <span class="htmx-np-live htmx-np-live-dim">LIVE</span>
</div>"""
        else:
            html_fragment = """<div class="htmx-np-inner htmx-np-idle">
  <span class="htmx-np-pulse">&#9835;</span>
  <div class="htmx-np-texts">
    <span class="htmx-np-station">Radios App</span>
    <span class="htmx-np-title">Selecciona una emisora para comenzar</span>
    <span class="htmx-np-subtitle"><i class="fas fa-sparkles"></i> Transmisión en vivo y metadatos</span>
  </div>
</div>"""

        body = html_fragment.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_nowplaying(self):
        parsed_path = urllib.parse.urlparse(self.path)
        query_params = urllib.parse.parse_qs(parsed_path.query)
        target_url = query_params.get("url", [""])[0]

        if not target_url:
            self.send_json({"title": None, "error": "Missing url parameter"})
            return
        if not self._is_public_http_url(target_url):
            self.send_json({"title": None, "error": "URL not allowed"}, 403)
            return

        # 1) Try ICY peek (most reliable for SHOUTcast/Icecast)
        try:
            title = self._peek_icy_metadata(target_url)
            if title:
                self.send_json({"title": title, "source": "icy_peek"})
                return
        except Exception as e:
            print(f"[NOWPLAYING] ICY peek error for {target_url}: {e}", file=sys.stderr)

        # 2) Try common HTTP metadata endpoints
        try:
            parsed = urllib.parse.urlparse(target_url)
            base = f"{parsed.scheme}://{parsed.netloc}"
        except Exception:
            self.send_json({"title": None, "error": "Invalid URL"})
            return

        endpoints = [
            "/7.html",
            "/currentsong",
            "/stats?json=1",
            "/status.xsl",
        ]

        for ep in endpoints:
            try:
                url = base + ep
                req = urllib.request.Request(
                    url,
                    headers={
                        "User-Agent": "RadiosApp/1.0",
                        "Icy-MetaData": "1",
                    },
                )
                with urllib.request.urlopen(req, timeout=5) as resp:
                    body = resp.read().decode("utf-8", errors="replace").strip()

                title = self._parse_metadata(body, ep)
                if title:
                    self.send_json({"title": title, "source": ep})
                    return
            except Exception:
                continue

        self.send_json({"title": None})

    def _parse_metadata(self, body, endpoint):
        if not body:
            return None

        try:
            if endpoint == "/7.html":
                # Reject if it looks like HTML
                if "<" in body and ">" in body:
                    return None
                # Format: listeners,status,peak,song_title or similar
                parts = body.split(",")
                if len(parts) >= 4:
                    song = ",".join(parts[3:]).strip()
                    if song and song != "-" and song != "":
                        return song
                if len(parts) == 1 and body not in ("-", ""):
                    return body

            elif endpoint == "/currentsong":
                # Just raw song title
                if body and body != "-":
                    # Strip any HTML tags
                    clean = re.sub(r"<[^>]+>", "", body).strip()
                    return clean if clean else None

            elif endpoint == "/stats?json=1":
                # Icecast JSON stats
                data = json.loads(body)
                for key in ("title", "song_title", "current_song", "song"):
                    val = data.get(key)
                    if val and val != "-":
                        return val
                # Also check inside source
                for src in data.get("source", []):
                    for key in ("title", "song_title", "current_song", "song"):
                        val = src.get(key) if isinstance(src, dict) else None
                        if val and val != "-":
                            return val

            elif endpoint == "/status.xsl":
                # Try to find title in XML
                m = re.search(r"<title[^>]*>([^<]+)</title>", body, re.IGNORECASE)
                if m:
                    val = m.group(1).strip()
                    return val if val and val != "-" else None
                # Try song in the XML
                m = re.search(r"<song[^>]*>([^<]+)</song>", body, re.IGNORECASE)
                if m:
                    val = m.group(1).strip()
                    return val if val and val != "-" else None
        except Exception:
            return None

        return None

    def handle_healthcheck(self):
        parsed_path = urllib.parse.urlparse(self.path)
        query_params = urllib.parse.parse_qs(parsed_path.query)
        target_url = query_params.get("url", [""])[0]
        timeout = int(query_params.get("timeout", [5])[0])

        if not target_url:
            self.send_json({"healthy": False, "error": "Missing url parameter"}, 400)
            return
        if not self._is_public_http_url(target_url):
            self.send_json({"healthy": False, "error": "URL not allowed"}, 403)
            return

        start = time.time()

        # 1) Try urllib first
        try:
            req = urllib.request.Request(
                target_url,
                headers={
                    "User-Agent": "RadiosApp/1.0",
                    "Accept": "*/*",
                    "Icy-MetaData": "1",
                },
            )
            upstream = urllib.request.urlopen(req, timeout=timeout)
            if not self._is_public_http_url(upstream.geturl()):
                upstream.close()
                self.send_json({"healthy": False, "error": "URL not allowed"}, 403)
                return
            chunk = upstream.read(1024)
            upstream.close()
            elapsed = int((time.time() - start) * 1000)
            healthy = len(chunk) > 0
            self.send_json(
                {
                    "healthy": healthy,
                    "time_ms": elapsed,
                    "status": upstream.status if hasattr(upstream, "status") else 200,
                }
            )
            return
        except urllib.error.HTTPError as e:
            elapsed = int((time.time() - start) * 1000)
            self.send_json(
                {
                    "healthy": False,
                    "time_ms": elapsed,
                    "status": e.code,
                    "error": str(e.reason),
                }
            )
            return
        except Exception:
            pass  # Fall through to raw socket

        # 2) Raw socket fallback for ICY / problematic streams
        if not self._is_public_http_url(target_url):
            self.send_json({"healthy": False, "error": "URL not allowed"}, 403)
            return
        try:
            parsed = urllib.parse.urlparse(target_url)
            host = parsed.hostname
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            path = parsed.path or "/"
            if parsed.query:
                path += "?" + parsed.query

            sock = socket.create_connection((host, port), timeout=timeout)
            if parsed.scheme == "https":
                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
                sock = ctx.wrap_socket(sock, server_hostname=host)

            request = (
                f"GET {path} HTTP/1.0\r\n"
                f"Host: {host}\r\n"
                f"User-Agent: RadiosApp/1.0\r\n"
                f"Icy-MetaData: 1\r\n"
                f"Accept: */*\r\n"
                f"\r\n"
            )
            sock.sendall(request.encode())

            # Read status line + headers
            data = b""
            deadline = time.time() + timeout
            while time.time() < deadline:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                data += chunk
                if b"\r\n\r\n" in data:
                    break

            sock.close()
            elapsed = int((time.time() - start) * 1000)
            healthy = len(data) > 0
            self.send_json(
                {
                    "healthy": healthy,
                    "time_ms": elapsed,
                }
            )
            return
        except Exception as e:
            elapsed = int((time.time() - start) * 1000)
            self.send_json(
                {
                    "healthy": False,
                    "time_ms": elapsed,
                    "error": str(e),
                }
            )
            return

    def _peek_icy_metadata(self, stream_url):
        """Quick peek at the stream for ICY metadata without proxying audio."""
        if not self._is_public_http_url(stream_url):
            return None

        parsed = urllib.parse.urlparse(stream_url)
        host = parsed.hostname
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query

        s = socket.create_connection((host, port), timeout=8)
        try:
            if parsed.scheme == "https":
                import ssl

                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
                s = ctx.wrap_socket(s, server_hostname=host)

            req = (
                f"GET {path} HTTP/1.0\r\n"
                f"Host: {host}\r\n"
                f"User-Agent: RadiosApp/1.0\r\n"
                f"Icy-MetaData: 1\r\n"
                f"Accept: */*\r\n"
                f"\r\n"
            )
            s.sendall(req.encode())

            # Read status + headers until blank line
            resp_raw = b""
            while True:
                chunk = s.recv(4096)
                if not chunk:
                    break
                resp_raw += chunk
                if b"\r\n\r\n" in resp_raw:
                    break

            header_part = resp_raw[: resp_raw.find(b"\r\n\r\n")]
            header_text = header_part.decode("utf-8", errors="replace")

            headers = {}
            for line in header_text.split("\r\n"):
                if ":" in line:
                    k, v = line.split(":", 1)
                    headers[k.strip().lower()] = v.strip()

            meta_int = headers.get("icy-metaint")
            if not meta_int:
                return None

            meta_int = int(meta_int)

            # Skip audio data up to first metadata block
            body_start = resp_raw.find(b"\r\n\r\n") + 4
            body_data = resp_raw[body_start:]
            need_audio = meta_int - len(body_data)
            if need_audio > 0:
                while need_audio > 0:
                    chunk = s.recv(min(need_audio, 8192))
                    if not chunk:
                        break
                    need_audio -= len(chunk)

            # Read metadata block length byte
            meta_len_byte = s.recv(1)
            if not meta_len_byte:
                return None
            meta_block_size = meta_len_byte[0] * 16
            if meta_block_size == 0:
                return None

            # Read full metadata block (might come in multiple recv calls)
            meta_data = b""
            while len(meta_data) < meta_block_size:
                chunk = s.recv(meta_block_size - len(meta_data))
                if not chunk:
                    break
                meta_data += chunk

            meta_str = meta_data.decode("utf-8", errors="replace")
            m = re.search(r"StreamTitle='([^']*)'", meta_str, re.IGNORECASE)
            if m:
                title = m.group(1).strip()
                return title if title else None
            return None
        finally:
            try:
                s.close()
            except Exception:
                pass

    def handle_proxy(self):
        parsed_path = urllib.parse.urlparse(self.path)
        query_params = urllib.parse.parse_qs(parsed_path.query)
        target_url = query_params.get("url", [""])[0]

        if not target_url:
            self.send_json({"error": "Missing url parameter"}, 400)
            return
        if not self._is_public_http_url(target_url):
            self.send_json({"error": "URL not allowed"}, 403)
            return

        print(f"[PROXY] Fetching: {target_url}", file=sys.stderr)

        # Try urllib first; fall back to raw socket for ICY streams
        try:
            req = urllib.request.Request(
                target_url,
                headers={
                    "User-Agent": "RadiosApp/1.0",
                    "Icy-MetaData": "1",
                    "Accept": "*/*",
                },
            )

            upstream = urllib.request.urlopen(req, timeout=15)
            if not self._is_public_http_url(upstream.geturl()):
                upstream.close()
                self.send_json({"error": "Redirected URL not allowed"}, 403)
                return
            self._proxy_stream(upstream, target_url)
            return

        except urllib.error.HTTPError as e:
            print(
                f"[PROXY] HTTP Error {e.code} for {target_url}: {e.reason}",
                file=sys.stderr,
            )
            self.send_error(e.code, str(e))
            return
        except Exception as e:
            # Fall through to raw socket (handles ICY protocol)
            print(f"[PROXY] urllib failed, trying raw socket: {e}", file=sys.stderr)

        # Raw socket fallback for ICY / problematic streams
        if not self._is_public_http_url(target_url):
            self.send_json({"error": "URL not allowed"}, 403)
            return
        try:
            parsed = urllib.parse.urlparse(target_url)
            host = parsed.hostname
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            path = parsed.path or "/"
            if parsed.query:
                path += "?" + parsed.query

            sock = socket.create_connection((host, port), timeout=15)
            if parsed.scheme == "https":
                import ssl

                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
                sock = ctx.wrap_socket(sock, server_hostname=host)

            request = (
                f"GET {path} HTTP/1.0\r\n"
                f"Host: {host}\r\n"
                f"User-Agent: RadiosApp/1.0\r\n"
                f"Icy-MetaData: 1\r\n"
                f"Accept: */*\r\n"
                f"\r\n"
            )
            sock.sendall(request.encode())

            # Read status line
            status_line = b""
            while not status_line.endswith(b"\r\n"):
                chunk = sock.recv(1)
                if not chunk:
                    break
                status_line += chunk

            status_str = status_line.decode("utf-8", errors="replace").strip()
            print(f"[PROXY] Raw socket status: {status_str}", file=sys.stderr)

            # Read headers until blank line
            headers_raw = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                headers_raw += chunk
                if b"\r\n\r\n" in headers_raw:
                    break

            header_text = headers_raw.decode("utf-8", errors="replace")
            headers = {}
            for line in header_text.split("\r\n"):
                if ":" in line:
                    k, v = line.split(":", 1)
                    headers[k.strip().lower()] = v.strip()

            ct = headers.get("content-type", "audio/mpeg")
            print(f"[PROXY] Raw socket Content-Type: {ct}", file=sys.stderr)

            self.send_response(200)
            self.send_header("Content-Type", ct)
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("X-Accel-Buffering", "no")
            icy_br = headers.get("icy-br", "")
            if icy_br:
                self.send_header("icy-br", icy_br)
            icy_name = headers.get("icy-name", "")
            if icy_name:
                self.send_header("icy-name", icy_name)
            self.end_headers()

            # Body comes after headers (skip past the blank line)
            body_start = headers_raw.find(b"\r\n\r\n") + 4
            remaining = headers_raw[body_start:]

            bytes_sent = 0
            if remaining:
                try:
                    self.wfile.write(remaining)
                    self.wfile.flush()
                    bytes_sent += len(remaining)
                except BrokenPipeError:
                    sock.close()
                    return

            while True:
                try:
                    chunk = sock.recv(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
                    bytes_sent += len(chunk)
                except (BrokenPipeError, ConnectionError):
                    break

            print(f"[PROXY] Raw socket done: {bytes_sent} bytes", file=sys.stderr)
            sock.close()

        except socket.timeout:
            print(f"[PROXY] Raw socket timeout for {target_url}", file=sys.stderr)
            self.send_error(504, "Upstream timed out")
        except Exception as e:
            print(f"[PROXY] Raw socket error for {target_url}: {e}", file=sys.stderr)
            self.send_error(502, f"Proxy error: {str(e)}")

    def _proxy_stream(self, upstream, target_url):
        ct = upstream.headers.get("Content-Type", "audio/mpeg")
        status = upstream.status
        print(f"[PROXY] urllib: Status={status} Content-Type={ct}", file=sys.stderr)

        self.send_response(200)
        self.send_header("Content-Type", ct)
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("X-Accel-Buffering", "no")

        icy_br = upstream.headers.get("icy-br", "")
        if icy_br:
            self.send_header("icy-br", icy_br)
        icy_name = upstream.headers.get("icy-name", "")
        if icy_name:
            self.send_header("icy-name", icy_name)

        self.end_headers()

        bytes_sent = 0
        while True:
            chunk = upstream.read(65536)
            if not chunk:
                break
            try:
                self.wfile.write(chunk)
                self.wfile.flush()
                bytes_sent += len(chunk)
            except BrokenPipeError:
                print(
                    f"[PROXY] Client disconnected after {bytes_sent} bytes",
                    file=sys.stderr,
                )
                break

        print(f"[PROXY] urllib done: {bytes_sent} bytes", file=sys.stderr)
