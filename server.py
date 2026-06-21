import http.server
import socketserver
import urllib.parse
import urllib.request
import json
import re
import sys
import os
import socket
from scrapling.fetchers import Fetcher

PORT = 8000


class RadiosHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/api/websearch"):
            self.handle_websearch()
        elif self.path.startswith("/proxy"):
            self.handle_proxy()
        else:
            self.handle_static()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

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
