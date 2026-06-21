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

            ct = upstream.headers.get("Content-Type", "audio/mpeg")
            status = upstream.status
            print(
                f"[PROXY] Status={status} Content-Type={ct} for {target_url}",
                file=sys.stderr,
            )

            self.send_response(200)
            self.send_header("Content-Type", ct)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")

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

            print(
                f"[PROXY] Done: {bytes_sent} bytes sent for {target_url}",
                file=sys.stderr,
            )

        except urllib.error.HTTPError as e:
            print(
                f"[PROXY] HTTP Error {e.code} for {target_url}: {e.reason}",
                file=sys.stderr,
            )
            self.send_error(e.code, str(e))
        except urllib.error.URLError as e:
            print(f"[PROXY] URL Error for {target_url}: {e.reason}", file=sys.stderr)
            self.send_error(502, f"Connection failed: {e.reason}")
        except socket.timeout:
            print(f"[PROXY] Timeout for {target_url}", file=sys.stderr)
            self.send_error(504, "Upstream timed out")
        except Exception as e:
            print(f"[PROXY] Unexpected error for {target_url}: {e}", file=sys.stderr)
            self.send_error(502, f"Proxy error: {str(e)}")

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
    socketserver.TCPServer.allow_reuse_address = True
    handler = RadiosHandler
    with socketserver.TCPServer(("", PORT), handler) as httpd:
        print(
            f"Serving Radios with Deep Search at http://localhost:{PORT}",
            file=sys.stderr,
        )
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            httpd.shutdown()
            print("\nServer stopped.", file=sys.stderr)
