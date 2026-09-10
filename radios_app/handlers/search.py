"""Búsqueda web profunda."""
from __future__ import annotations

import sys

import re
import urllib.parse

from scrapling.fetchers import Fetcher


class SearchMixin:
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

    def perform_web_search(self, query):
        search_query = f"{query} radio en vivo stream"
        ddg_url = (
            f"https://lite.duckduckgo.com/lite/?q={urllib.parse.quote(search_query)}"
        )

        stations = []
        try:
            page = Fetcher.get(ddg_url, timeout=10)
            links = page.css("a.result-link::attr(href)").getall()[:5]

            for i, link in enumerate(links):
                try:
                    if not self._is_public_http_url(link):
                        continue
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
