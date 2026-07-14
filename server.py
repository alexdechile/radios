import http.server
import socketserver
import urllib.parse
import urllib.request
import json
import re
import sys
import os
import socket
import ssl
import sqlite3
import time
from scrapling.fetchers import Fetcher

PORT = 8000
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "radios_curated.db")


def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS curated_radios (
            uuid TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            url TEXT NOT NULL,
            favicon TEXT DEFAULT '',
            tags TEXT DEFAULT '',
            country TEXT DEFAULT '',
            bitrate TEXT DEFAULT '',
            codec TEXT DEFAULT '',
            homepage TEXT DEFAULT '',
            language TEXT DEFAULT '',
            state TEXT DEFAULT '',
            clickcount TEXT DEFAULT '',
            position INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    conn.close()


init_db()


class RadiosHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/api/curated"):
            self.handle_get_curated()
        elif self.path.startswith("/api/websearch"):
            self.handle_websearch()
        elif self.path.startswith("/api/nowplaying"):
            self.handle_nowplaying()
        elif self.path.startswith("/api/healthcheck"):
            self.handle_healthcheck()
        elif self.path.startswith("/proxy"):
            self.handle_proxy()
        else:
            self.handle_static()

    def do_POST(self):
        if self.path.startswith("/api/curated"):
            self.handle_add_curated()

    def do_DELETE(self):
        if self.path.startswith("/api/curated"):
            self.handle_delete_curated()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header(
            "Access-Control-Allow-Methods", "GET, POST, DELETE, PUT, OPTIONS"
        )
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def handle_get_curated(self):
        try:
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            c.execute(
                "SELECT * FROM curated_radios ORDER BY position ASC, created_at ASC"
            )
            rows = [dict(r) for r in c.fetchall()]
            conn.close()
            self.send_json(rows)
        except Exception as e:
            self.send_json({"error": str(e)}, 500)

    def handle_add_curated(self):
        try:
            length = int(self.headers.get("Content-length", 0))
            body = self.rfile.read(length).decode("utf-8")
            data = json.loads(body)
            uuid = data.get("uuid", "")
            if not uuid:
                self.send_json({"error": "uuid required"}, 400)
                return
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute(
                """
                INSERT OR REPLACE INTO curated_radios
                    (uuid, name, url, favicon, tags, country, bitrate, codec, homepage, language, state, clickcount)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
                (
                    uuid,
                    data.get("name", ""),
                    data.get("url", ""),
                    data.get("favicon", ""),
                    data.get("tags", ""),
                    data.get("country", ""),
                    data.get("bitrate", ""),
                    data.get("codec", ""),
                    data.get("homepage", ""),
                    data.get("language", ""),
                    data.get("state", ""),
                    data.get("clickcount", ""),
                ),
            )
            conn.commit()
            conn.close()
            self.send_json({"status": "ok", "uuid": uuid})
        except Exception as e:
            self.send_json({"error": str(e)}, 500)

    def handle_delete_curated(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)
            uuid = params.get("uuid", [None])[0]
            if not uuid:
                self.send_json({"error": "uuid query parameter required"}, 400)
                return
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute("DELETE FROM curated_radios WHERE uuid = ?", (uuid,))
            conn.commit()
            conn.close()
            self.send_json({"status": "deleted", "uuid": uuid})
        except Exception as e:
            self.send_json({"error": str(e)}, 500)

    def handle_static(self):
        # Basic static file serving logic
        path = self.path.split("?")[0]
        if path == "/":
            path = "/index.html"

        # Remove leading slash and prevent directory traversal
        local_path = path.lstrip("/")
        if ".." in local_path or local_path.startswith("/"):
            self.send_error(403, "Forbidden")
            return

        if not os.path.exists(local_path) or os.path.isdir(local_path):
            self.send_error(404, "File not found")
            return

        # Determine mime type
        ext = os.path.splitext(local_path)[1].lower()
        mime_types = {
            ".html": "text/html",
            ".js": "application/javascript",
            ".css": "text/css",
            ".json": "application/json",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".ico": "image/x-icon",
        }
        content_type = mime_types.get(ext, "application/octet-stream")

        try:
            with open(local_path, "rb") as f:
                content = f.read()
                self.send_response(200)
                self.send_header("Content-type", content_type)
                self.send_header("Content-length", len(content))
                self.end_headers()
                self.wfile.write(content)
        except Exception as e:
            self.send_error(500, str(e))

    def handle_websearch(self):
        parsed_path = urllib.parse.urlparse(self.path)
        query_params = urllib.parse.parse_qs(parsed_path.query)
        query = query_params.get("q", [""])[0]

        if not query:
            self.send_json({"error": "No query provided"}, 400)
            return

        print(f"Deep Web Search for: {query}", file=sys.stderr)
        results = self.perform_web_search(query)
        self.send_json(results)

    def handle_nowplaying(self):
        parsed_path = urllib.parse.urlparse(self.path)
        query_params = urllib.parse.parse_qs(parsed_path.query)
        target_url = query_params.get("url", [""])[0]

        if not target_url:
            self.send_json({"title": None, "error": "Missing url parameter"})
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
        import sys as _sys

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

    def send_json(self, data, status=200):
        try:
            body = json.dumps(data).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-type", "application/json")
            self.send_header("Content-length", len(body))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            print(f"Error sending JSON: {e}", file=sys.stderr)

    def handle_proxy(self):
        parsed_path = urllib.parse.urlparse(self.path)
        query_params = urllib.parse.parse_qs(parsed_path.query)
        target_url = query_params.get("url", [""])[0]

        if not target_url:
            self.send_json({"error": "Missing url parameter"}, 400)
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
            self.send_header("Access-Control-Allow-Origin", "*")
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
                    chunk = sock.recv(8192)
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
        self.send_header("Access-Control-Allow-Origin", "*")
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
            chunk = upstream.read(8192)
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

    def perform_web_search(self, query):
        search_query = f"{query} radio en vivo stream"
        ddg_url = (
            f"https://lite.duckduckgo.com/lite/?q={urllib.parse.quote(search_query)}"
        )

        stations = []
        try:
            page = Fetcher.get(ddg_url)
            links = page.css("a.result-link::attr(href)").getall()[:5]

            for i, link in enumerate(links):
                try:
                    site = Fetcher.get(link, timeout=10)

                    audio_sources = site.css("audio source::attr(src)").getall()
                    audio_src = site.css("audio::attr(src)").get()
                    if audio_src:
                        audio_sources.append(audio_src)

                    stream_patterns = [
                        r'https?://[^"\'>]+\.m3u8',
                        r'https?://[^"\'>]+\.mp3',
                        r'https?://[^"\'>]+/stream',
                        r'https?://[^"\'>]+/icecast',
                        r'https?://[^"\'>]+: \d+/[^"\'>]*',
                    ]

                    html_content = site.html
                    found_urls = []

                    for src in audio_sources:
                        if src.startswith("http"):
                            found_urls.append(src)

                    for pattern in stream_patterns:
                        matches = re.findall(pattern, html_content)
                        found_urls.extend(matches)

                    unique_urls = list(set(found_urls))

                    for stream_url in unique_urls:
                        if any(
                            ext in stream_url.lower()
                            for ext in [".html", ".php", ".jpg", ".png", ".css", ".js"]
                        ):
                            continue

                        stations.append(
                            {
                                "uuid": f"web-{i}-{hash(stream_url)}",
                                "name": f"{query} (Web Result {i + 1})",
                                "url": stream_url,
                                "favicon": "",
                                "tags": "web, search",
                                "country": "Web",
                                "bitrate": "Unknown",
                                "is_web": True,
                            }
                        )
                        if stations:
                            break
                except Exception as e:
                    print(f"Error analyzing {link}: {e}", file=sys.stderr)
                    continue

        except Exception as e:
            print(f"Global Search Error: {e}", file=sys.stderr)

        return stations


if __name__ == "__main__":
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    handler = RadiosHandler
    with socketserver.ThreadingTCPServer(("", PORT), handler) as httpd:
        print(
            f"Serving Radios with Deep Search at http://localhost:{PORT}",
            file=sys.stderr,
        )
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            httpd.shutdown()
            print("\nServer stopped.", file=sys.stderr)
