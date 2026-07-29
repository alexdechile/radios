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
import subprocess
import hashlib
import threading
from datetime import datetime, timedelta
from scrapling.fetchers import Fetcher

PORT = 8000
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "radios_curated.db")
TTS_VENV_PYTHON = "/home/alexdechile/.openclaw/tmp/tts-venv/bin/python"
TTS_VOICE = "es-CL-CatalinaNeural"
TTS_CACHE_DIR = "/tmp/radios_tts_cache"


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
    c.execute("""
        CREATE TABLE IF NOT EXISTS song_cache (
            raw_title TEXT PRIMARY KEY,
            artist TEXT,
            track TEXT,
            album TEXT,
            genre TEXT,
            year TEXT,
            source TEXT,
            writer TEXT,
            producer TEXT,
            label TEXT,
            length TEXT,
            description TEXT,
            thumbnail TEXT,
            wiki_url TEXT,
            fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    # Migration: add new columns if missing (schema upgrade)
    for col in [
        "writer",
        "producer",
        "label",
        "length",
        "description",
        "thumbnail",
        "wiki_url",
    ]:
        try:
            c.execute(f"ALTER TABLE song_cache ADD COLUMN {col} TEXT")
        except sqlite3.OperationalError:
            pass
    c.execute("""
        CREATE TABLE IF NOT EXISTS feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            raw_title TEXT NOT NULL,
            artist TEXT DEFAULT '',
            track TEXT DEFAULT '',
            vote TEXT NOT NULL,
            source TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    c.execute("""
        CREATE TABLE IF NOT EXISTS lyrics_cache (
            raw_title TEXT PRIMARY KEY,
            artist TEXT,
            track TEXT,
            lyrics TEXT,
            source TEXT,
            fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    conn.close()


init_db()


class RadiosHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            if self.path.startswith("/api/version"):
                self.handle_version()
            elif self.path.startswith("/api/curated"):
                self.handle_get_curated()
            elif self.path.startswith("/api/websearch"):
                self.handle_websearch()
            elif self.path.startswith("/api/songinfo"):
                self.handle_songinfo()
            elif self.path.startswith("/api/lyrics"):
                self.handle_lyrics()
            elif self.path.startswith("/api/feedback"):
                self.handle_get_feedback()
            elif self.path.startswith("/api/nowplaying-fragment"):
                self.handle_nowplaying_fragment()
            elif self.path.startswith("/api/nowplaying"):
                self.handle_nowplaying()
            elif self.path.startswith("/api/news"):
                self.handle_news()
            elif self.path.startswith("/api/tts"):
                self.handle_tts()
            elif self.path.startswith("/api/healthcheck"):
                self.handle_healthcheck()
            elif self.path.startswith("/proxy"):
                self.handle_proxy()
            else:
                self.handle_static()
        except Exception as e:
            self.send_json({"error": str(e)}, 500)

    def do_POST(self):
        if self.path.startswith("/api/curated"):
            self.handle_add_curated()
        elif self.path.startswith("/api/playlist"):
            self.handle_playlist_save()
        elif self.path.startswith("/api/feedback"):
            self.handle_feedback()

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

    def handle_songinfo(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)
            raw_title = params.get("title", [""])[0]

            if not raw_title:
                self.send_json({"error": "No title provided"}, 400)
                return

            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            c = conn.cursor()

            c.execute("SELECT * FROM song_cache WHERE raw_title = ?", (raw_title,))
            row = c.fetchone()

            if row:
                row_dict = dict(row)
                fetched = row_dict.get("fetched_at")
                if fetched:
                    try:
                        fetched_dt = datetime.strptime(fetched, "%Y-%m-%d %H:%M:%S")
                        age = datetime.now() - fetched_dt
                        # Use cache if fresh (7 days), UNLESS thumbnail is missing and entry is old (>1 day)
                        has_thumbnail = bool(row_dict.get("thumbnail"))
                        if age < timedelta(days=7) and (
                            has_thumbnail or age < timedelta(days=1)
                        ):
                            row_dict["cached"] = True
                            conn.close()
                            self.send_json(row_dict)
                            return
                    except Exception:
                        pass
            conn.close()

            result = self._search_song_info(raw_title)

            if result.get("source"):
                conn = sqlite3.connect(DB_PATH)
                c = conn.cursor()
                c.execute(
                    """
                    INSERT OR REPLACE INTO song_cache (raw_title, artist, track, album, genre, year, source,
                        writer, producer, label, length, description, thumbnail, wiki_url)
                    VALUES (?, ?, ?, ?, ?, ?, ?,
                        ?, ?, ?, ?, ?, ?, ?)
                """,
                    (
                        raw_title,
                        result.get("artist"),
                        result.get("track"),
                        result.get("album"),
                        result.get("genre"),
                        result.get("year"),
                        result.get("source"),
                        result.get("writer"),
                        result.get("producer"),
                        result.get("label"),
                        result.get("length"),
                        result.get("description"),
                        result.get("thumbnail"),
                        result.get("wiki_url"),
                    ),
                )
                conn.commit()
                conn.close()
                result["cached"] = False

            self.send_json(result)
        except Exception as e:
            self.send_json(
                {
                    "raw_title": None,
                    "artist": None,
                    "track": None,
                    "album": None,
                    "genre": None,
                    "year": None,
                    "source": None,
                    "writer": None,
                    "producer": None,
                    "label": None,
                    "length": None,
                    "description": None,
                    "thumbnail": None,
                    "wiki_url": None,
                    "cached": False,
                    "error": str(e),
                }
            )

    def handle_lyrics(self):
        """Fetch song lyrics (cached in SQLite). Sources: lyrics.ovh -> Genius scrape."""
        try:
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)
            raw_title = params.get("title", [""])[0]
            q_artist = params.get("artist", [""])[0]
            q_track = params.get("track", [""])[0]

            # Determine artist/track: prefer explicit params, else parse raw_title
            artist = q_artist.strip()
            track = q_track.strip()
            if not artist or not track:
                p_artist, p_track = self._parse_title(raw_title)
                artist = artist or p_artist
                track = track or p_track

            cache_key = raw_title or f"{artist} - {track}"
            if not artist or not track:
                self.send_json({"lyrics": None, "source": None, "cached": False})
                return

            # ── Check cache (30-day TTL) ──
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            c.execute("SELECT * FROM lyrics_cache WHERE raw_title = ?", (cache_key,))
            row = c.fetchone()
            if row:
                row_dict = dict(row)
                fetched = row_dict.get("fetched_at")
                fresh = True
                if fetched:
                    try:
                        fetched_dt = datetime.strptime(fetched, "%Y-%m-%d %H:%M:%S")
                        # Re-try missing lyrics after 1 day; keep found lyrics 30 days
                        age = datetime.now() - fetched_dt
                        if row_dict.get("lyrics"):
                            fresh = age < timedelta(days=30)
                        else:
                            fresh = age < timedelta(days=1)
                    except Exception:
                        pass
                if fresh:
                    conn.close()
                    self.send_json(
                        {
                            "artist": row_dict.get("artist"),
                            "track": row_dict.get("track"),
                            "lyrics": row_dict.get("lyrics"),
                            "source": row_dict.get("source"),
                            "cached": True,
                        }
                    )
                    return
            conn.close()

            # ── Fetch fresh ──
            lyrics, source = self._search_lyrics(artist, track)

            # Store in cache (even negatives, so we don't hammer sources)
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute(
                """
                INSERT OR REPLACE INTO lyrics_cache (raw_title, artist, track, lyrics, source, fetched_at)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                """,
                (cache_key, artist, track, lyrics, source),
            )
            conn.commit()
            conn.close()

            self.send_json(
                {
                    "artist": artist,
                    "track": track,
                    "lyrics": lyrics,
                    "source": source,
                    "cached": False,
                }
            )
        except Exception as e:
            self.send_json(
                {"lyrics": None, "source": None, "cached": False, "error": str(e)}
            )

    def _search_lyrics(self, artist, track):
        """Return (lyrics_text, source) or (None, None)."""
        # Clean feat./featuring for better matches
        clean_track = re.sub(
            r"\s*(\(|\[)?feat\.?.*", "", track, flags=re.IGNORECASE
        ).strip()
        clean_artist = re.sub(
            r"\s*(feat\.?|ft\.?|&|,).*", "", artist, flags=re.IGNORECASE
        ).strip()

        candidates = [
            (artist, track),
            (clean_artist, clean_track),
        ]
        seen = set()

        # ── 1) lyrics.ovh (free, no auth) ──
        for a, t in candidates:
            key = (a.lower(), t.lower())
            if not a or not t or key in seen:
                continue
            seen.add(key)
            try:
                url = (
                    "https://api.lyrics.ovh/v1/"
                    f"{urllib.parse.quote(a)}/{urllib.parse.quote(t)}"
                )
                req = urllib.request.Request(
                    url, headers={"User-Agent": "RadiosApp/1.0"}
                )
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                lyr = (data.get("lyrics") or "").strip()
                if lyr and len(lyr) > 20:
                    return self._clean_lyrics(lyr), "lyrics.ovh"
            except Exception as e:
                print(f"[LYRICS] lyrics.ovh error '{a} - {t}': {e}", file=sys.stderr)
                continue

        # ── 2) Genius scrape (fallback) ──
        try:
            lyr = self._scrape_genius_lyrics(
                clean_artist or artist, clean_track or track
            )
            if lyr:
                return self._clean_lyrics(lyr), "genius"
        except Exception as e:
            print(f"[LYRICS] genius error: {e}", file=sys.stderr)

        return None, None

    def _clean_lyrics(self, text):
        # Normalize line endings and strip excessive blank lines
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        text = re.sub(r"\n{3,}", "\n\n", text).strip()
        return text

    def _scrape_genius_lyrics(self, artist, track):
        """Scrape lyrics from Genius using scrapling."""
        if not artist or not track:
            return None
        # Search Genius via their search page
        query = f"{artist} {track}"
        search_url = (
            f"https://genius.com/api/search/multi?q={urllib.parse.quote(query)}"
        )
        song_url = None
        try:
            req = urllib.request.Request(
                search_url,
                headers={"User-Agent": "Mozilla/5.0 (RadiosApp)"},
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            for section in data.get("response", {}).get("sections", []):
                if section.get("type") != "song":
                    continue
                for hit in section.get("hits", []):
                    result = hit.get("result", {})
                    url = result.get("url")
                    if url and "/lyrics" not in url and "genius.com" in url:
                        song_url = url
                        break
                if song_url:
                    break
        except Exception as e:
            print(f"[LYRICS] genius search error: {e}", file=sys.stderr)
            return None

        if not song_url:
            return None

        try:
            page = Fetcher.get(song_url, timeout=12)
            # Modern Genius: div[data-lyrics-container="true"]
            containers = page.css('div[data-lyrics-container="true"]')
            parts = []
            for cont in containers:
                # get_all_text preserves text; fall back to .text
                try:
                    txt = cont.get_all_text(separator="\n")
                except Exception:
                    txt = cont.text
                if txt:
                    parts.append(txt)
            lyrics = "\n".join(parts).strip()
            # Remove leading "[Verse]" style tags kept? keep them, they're helpful
            if lyrics and len(lyrics) > 20:
                return lyrics
        except Exception as e:
            print(f"[LYRICS] genius scrape error: {e}", file=sys.stderr)
        return None

    def _parse_title(self, raw_title):
        """Parse 'Artist - Track' or 'Artist – Track' or 'Artist | Track' from raw_title."""
        for sep in [" – ", " - ", " | ", " — "]:
            if sep in raw_title:
                parts = raw_title.split(sep, 1)
                artist = parts[0].strip()
                song = parts[1].strip()
                # Remove common suffixes like (Radio Edit), [Official], etc.
                song = re.sub(
                    r"\s*(\(|\[)(radio edit|official|remaster|live|acoustic|version|feat\.?.*)(\)|\])",
                    "",
                    song,
                    flags=re.IGNORECASE,
                ).strip()
                return artist, song
        return None, raw_title.strip()

    def _search_song_info(self, raw_title):
        artist, song = self._parse_title(raw_title)
        base = {"raw_title": raw_title, "artist": artist, "track": song}

        # ── 1) MusicBrainz (primary source for structured data + cover art) ──
        mb = self._search_musicbrainz(artist, song)
        if mb:
            base.update(mb)
            base.setdefault("artist", artist)
            base["source"] = "musicbrainz"
            # Wikipedia as complement for description + wiki_url (song-specific)
            eff_artist = mb.get("artist") or artist
            eff_track = base.get("track") or song
            wiki = self._search_wikipedia_song(eff_artist, eff_track)
            if wiki:
                base.setdefault("description", wiki.get("description"))
                base.setdefault("wiki_url", wiki.get("wiki_url"))
                # Only use wiki thumbnail if MB didn't find cover art
                if not base.get("thumbnail") and wiki.get("thumbnail"):
                    base["thumbnail"] = wiki["thumbnail"]
            return base

        # ── 2) Wikipedia song search (fallback) ──
        if artist:
            wiki = self._search_wikipedia_song(artist, song)
            if wiki:
                base.update(wiki)
                base["source"] = "wikipedia"
                return base

        # ── 3) DuckDuckGo → Wikipedia (last resort) ──
        ddg = self._search_duckduckgo_song(raw_title)
        if ddg:
            base.update(ddg)
            base["source"] = "duckduckgo"
            return base

        return base

    def _search_wikipedia_song(self, artist, song):
        """Search Wikipedia specifically for the SONG page (not the artist page).
        Validates that the result is actually about the song."""
        if not artist or not song:
            return None

        # Ordered queries from most specific to least specific
        queries = [
            f"{song} {artist} single",
            f"{song} {artist} song",
            f'"{song}" {artist}',
            f"{artist} {song}",
        ]

        artist_lower = artist.lower()
        song_lower = song.lower()

        for lang in ("es", "en"):
            for query in queries:
                try:
                    url = (
                        f"https://{lang}.wikipedia.org/w/api.php"
                        f"?action=query&list=search&srsearch={urllib.parse.quote(query)}"
                        f"&format=json&srlimit=5&srprop=snippet"
                    )
                    req = urllib.request.Request(
                        url, headers={"User-Agent": "RadiosApp/1.0"}
                    )
                    with urllib.request.urlopen(req, timeout=8) as resp:
                        data = json.loads(resp.read().decode("utf-8"))

                    pages = data.get("query", {}).get("search", [])
                    if not pages:
                        continue

                    # Find the first result that looks like the SONG (not the artist biography)
                    for page in pages:
                        page_title_lower = page["title"].lower()
                        snippet_lower = page.get("snippet", "").lower()

                        # Skip pages that look like artist biopages (title == artist only)
                        if page_title_lower == artist_lower:
                            continue
                        # Skip disambiguation pages
                        if (
                            "disambiguation" in page_title_lower
                            or "desambiguación" in page_title_lower
                        ):
                            continue
                        # Must mention the song title or both artist in snippet
                        song_words = [w for w in song_lower.split() if len(w) > 3]
                        relevance_ok = (
                            song_lower in page_title_lower
                            or any(w in snippet_lower for w in song_words)
                            or (
                                artist_lower in snippet_lower
                                and any(w in snippet_lower for w in song_words)
                            )
                        )
                        if not relevance_ok:
                            continue

                        summary = self._fetch_wikipedia_summary(
                            page["title"], lang=lang
                        )
                        if summary:
                            return summary

                except Exception as e:
                    print(
                        f"[SONGINFO] Wikipedia song search ({lang}) error '{query}': {e}",
                        file=sys.stderr,
                    )
                    continue

        return None

    def _search_duckduckgo_song(self, raw_title):
        try:
            ddg_url = f"https://lite.duckduckgo.com/lite/?q={urllib.parse.quote(raw_title + ' canción')}"
            page = Fetcher.get(ddg_url, timeout=10)
            links = page.css("a.result-link::attr(href)").getall()[:5]
            for link in links:
                try:
                    parsed_link = urllib.parse.urlparse(link)
                    ddg_params = urllib.parse.parse_qs(parsed_link.query)
                    actual_url = ddg_params.get("uddg", [None])[0]
                    if not actual_url:
                        continue
                    if "wikipedia.org" in actual_url:
                        lang = "es" if "es.wikipedia.org" in actual_url else "en"
                        ddg_title = (
                            urllib.parse.unquote(
                                actual_url.split("/wiki/")[-1].replace("_", " ")
                            )
                            if "/wiki/" in actual_url
                            else None
                        )
                        if ddg_title:
                            summary = self._fetch_wikipedia_summary(
                                ddg_title, lang=lang
                            )
                            if summary:
                                return summary
                except Exception:
                    continue
        except Exception as e:
            print(f"[SONGINFO] DuckDuckGo fallback error: {e}", file=sys.stderr)
        return None

    def _fetch_wikipedia_summary(self, page_title, lang="es"):
        """Fetch thumbnail + description from Wikipedia REST Summary API."""
        for try_lang in [lang, "en"] if lang == "es" else [lang]:
            try:
                rest_url = (
                    f"https://{try_lang}.wikipedia.org/api/rest_v1/page/summary/"
                    f"{urllib.parse.quote(page_title.replace(' ', '_'))}"
                )
                req = urllib.request.Request(
                    rest_url, headers={"User-Agent": "RadiosApp/1.0"}
                )
                with urllib.request.urlopen(req, timeout=8) as resp:
                    data = json.loads(resp.read().decode("utf-8"))

                # Skip if this is a disambiguation page
                if data.get("type") == "disambiguation":
                    continue

                result = {}
                if data.get("originalimage", {}).get("source"):
                    result["thumbnail"] = data["originalimage"]["source"]
                elif data.get("thumbnail") and data["thumbnail"].get("source"):
                    result["thumbnail"] = data["thumbnail"]["source"]
                if data.get("extract"):
                    # Truncate cleanly at sentence boundary
                    extract = data["extract"]
                    if len(extract) > 350:
                        cut = extract[:350].rfind(".")
                        extract = extract[: cut + 1] if cut > 100 else extract[:350]
                    result["description"] = extract
                if data.get("content_urls", {}).get("desktop", {}).get("page"):
                    result["wiki_url"] = data["content_urls"]["desktop"]["page"]
                if result.get("description"):
                    return result
            except Exception as e:
                print(
                    f"[SONGINFO] Wikipedia ({try_lang}) REST summary error '{page_title}': {e}",
                    file=sys.stderr,
                )
                continue
        return None

    def _search_musicbrainz(self, artist, track):
        """Search MusicBrainz for recording metadata: cover art, genres, artist image."""
        if not artist or not track:
            return None
        try:
            import time as _time

            # Use proper Lucene syntax with field prefixes
            query_str = f'artist:"{artist}" AND recording:"{track}"'
            mb_url = (
                "https://musicbrainz.org/ws/2/recording/"
                f"?query={urllib.parse.quote(query_str)}&fmt=json&limit=5"
            )
            req = urllib.request.Request(
                mb_url, headers={"User-Agent": "RadiosApp/1.0 (radios-sketch@donalex)"}
            )
            with urllib.request.urlopen(req, timeout=12) as resp:
                data = json.loads(resp.read().decode("utf-8"))

            recordings = data.get("recordings", [])
            if not recordings:
                return None

            result = {}
            rec = recordings[0]

            # ── Cover art & Label info: try releases ──
            release_ids = []
            if rec.get("releases"):
                for release in rec["releases"][:5]:  # try up to 5 releases
                    rid = release.get("id")
                    if rid:
                        release_ids.append(rid)

            for rid in release_ids:
                # 1) Try Cover Art Archive
                if not result.get("thumbnail"):
                    try:
                        ca_url = f"https://coverartarchive.org/release/{rid}"
                        ca_req = urllib.request.Request(
                            ca_url, headers={"User-Agent": "RadiosApp/1.0"}
                        )
                        with urllib.request.urlopen(ca_req, timeout=6) as ca_resp:
                            ca_data = json.loads(ca_resp.read().decode("utf-8"))
                            for img in ca_data.get("images", []):
                                thumbs = img.get("thumbnails", {})
                                thumb_url = (
                                    thumbs.get("500")
                                    or thumbs.get("250")
                                    or img.get("image")
                                )
                                if img.get("front") and thumb_url:
                                    result["thumbnail"] = thumb_url
                                    break
                            if not result.get("thumbnail"):
                                imgs = ca_data.get("images", [])
                                if imgs:
                                    thumbs = imgs[0].get("thumbnails", {})
                                    thumb_url = (
                                        thumbs.get("500")
                                        or thumbs.get("250")
                                        or imgs[0].get("image")
                                    )
                                    if thumb_url:
                                        result["thumbnail"] = thumb_url
                    except Exception:
                        pass

                # 2) Try Label (Sello discográfico) from MusicBrainz release
                if not result.get("label"):
                    try:
                        rel_url = f"https://musicbrainz.org/ws/2/release/{rid}?fmt=json&inc=labels"
                        rel_req = urllib.request.Request(
                            rel_url,
                            headers={"User-Agent": "RadiosApp/1.0 (donalex@homelab)"},
                        )
                        with urllib.request.urlopen(rel_req, timeout=5) as rel_resp:
                            rel_data = json.loads(rel_resp.read().decode("utf-8"))
                            labels = [
                                l.get("label", {}).get("name")
                                for l in rel_data.get("label-info", [])
                                if l.get("label")
                                and l.get("label", {}).get("name")
                                and l.get("label", {}).get("name") != "[no label]"
                            ]
                            if labels:
                                result["label"] = labels[0]
                    except Exception:
                        pass

                if result.get("thumbnail") and result.get("label"):
                    break

            # ── Writer / Composer info from MusicBrainz Work search ──
            try:
                work_query = f'artist:"{artist}" AND work:"{track}"'
                wurl = f"https://musicbrainz.org/ws/2/work/?query={urllib.parse.quote(work_query)}&fmt=json&limit=2"
                wreq = urllib.request.Request(
                    wurl, headers={"User-Agent": "RadiosApp/1.0 (donalex@homelab)"}
                )
                with urllib.request.urlopen(wreq, timeout=6) as wresp:
                    wdata = json.loads(wresp.read().decode("utf-8"))
                    works = wdata.get("works", [])
                    if works:
                        wid = works[0].get("id")
                        if wid:
                            wurl_detail = f"https://musicbrainz.org/ws/2/work/{wid}?fmt=json&inc=artist-rels"
                            wreq_detail = urllib.request.Request(
                                wurl_detail,
                                headers={
                                    "User-Agent": "RadiosApp/1.0 (donalex@homelab)"
                                },
                            )
                            with urllib.request.urlopen(
                                wreq_detail, timeout=6
                            ) as wresp_detail:
                                wdetail = json.loads(
                                    wresp_detail.read().decode("utf-8")
                                )
                                writers = []
                                for rel in wdetail.get("relations", []):
                                    if rel.get("type") in (
                                        "composer",
                                        "lyricist",
                                        "writer",
                                    ):
                                        wname = rel.get("artist", {}).get("name")
                                        if wname and wname not in writers:
                                            writers.append(wname)
                                if writers:
                                    result["writer"] = ", ".join(writers[:3])
            except Exception:
                pass

            # ── Artist info: genres and artist image ──
            artist_mbid = None
            if rec.get("artist-credit") and len(rec["artist-credit"]) > 0:
                credit = rec["artist-credit"][0]
                if isinstance(credit, dict) and credit.get("artist", {}).get("id"):
                    artist_mbid = credit["artist"]["id"]

            if artist_mbid:
                try:
                    art_url = f"https://musicbrainz.org/ws/2/artist/{artist_mbid}?fmt=json&inc=tags+genres"
                    art_req = urllib.request.Request(
                        art_url, headers={"User-Agent": "RadiosApp/1.0"}
                    )
                    with urllib.request.urlopen(art_req, timeout=6) as art_resp:
                        art_data = json.loads(art_resp.read().decode("utf-8"))
                        tags = []
                        for tag_list_key in ("genres", "tags"):
                            for tag in art_data.get(tag_list_key, []):
                                t = tag.get("name", "").strip()
                                if t and t not in tags:
                                    tags.append(t)
                        if tags:
                            result["genre"] = ", ".join(tags[:4])
                        result["artist_mbid"] = artist_mbid
                except Exception:
                    pass

                # ── Artist image fallback via CAA release-group ──
                if not result.get("thumbnail") and rec.get("releases"):
                    for release in rec["releases"][:3]:
                        rg_id = (release.get("release-group") or {}).get("id")
                        if not rg_id:
                            continue
                        try:
                            rg_url = (
                                f"https://coverartarchive.org/release-group/{rg_id}"
                            )
                            rg_req = urllib.request.Request(
                                rg_url, headers={"User-Agent": "RadiosApp/1.0"}
                            )
                            with urllib.request.urlopen(rg_req, timeout=6) as rg_resp:
                                rg_data = json.loads(rg_resp.read().decode("utf-8"))
                                for img in rg_data.get("images", []):
                                    thumbs = img.get("thumbnails", {})
                                    thumb_url = (
                                        thumbs.get("500")
                                        or thumbs.get("250")
                                        or img.get("image")
                                    )
                                    if thumb_url:
                                        result["thumbnail"] = thumb_url
                                        break
                            if result.get("thumbnail"):
                                break
                        except Exception:
                            continue

            # ── Recording metadata ──
            if rec.get("isrcs"):
                result["isrc"] = rec["isrcs"][0]

            if rec.get("length"):
                minutes = rec["length"] // 60000
                seconds = (rec["length"] % 60000) // 1000
                result["length"] = f"{minutes}:{seconds:02d}"

            if rec.get("title"):
                result["track"] = rec["title"]

            # Artist name from credits
            if rec.get("artist-credit"):
                ac_parts = []
                for ac in rec["artist-credit"]:
                    if isinstance(ac, dict):
                        name = ac.get("name") or ac.get("artist", {}).get("name", "")
                        if name:
                            ac_parts.append(name)
                        joinphrase = ac.get("joinphrase", "")
                        if joinphrase:
                            ac_parts.append(joinphrase)
                    elif isinstance(ac, str):
                        ac_parts.append(ac)
                if ac_parts:
                    result["artist"] = "".join(ac_parts).strip()

            # Album from first release
            if rec.get("releases") and rec["releases"][0].get("title"):
                result["album"] = rec["releases"][0]["title"]
                release_date = rec["releases"][0].get("date", "")
                if release_date:
                    result["year"] = release_date[:4]

            return result if result else None
        except Exception as e:
            print(f"[SONGINFO] MusicBrainz error: {e}", file=sys.stderr)
            return None

    def handle_nowplaying_fragment(self):
        """HTMX endpoint: returns an HTML fragment for the 'now playing' bar.
        Polling-friendly — HTMX calls this every 15s and swaps innerHTML.
        """
        parsed_path = urllib.parse.urlparse(self.path)
        query_params = urllib.parse.parse_qs(parsed_path.query)
        target_url = query_params.get("url", [""])[0]
        station_name = query_params.get("name", ["Radio"])[0]
        station_favicon = query_params.get("favicon", [""])[0]

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
        if station_favicon and station_favicon.startswith("http"):
            favicon_html = f'<img class="htmx-np-favicon" src="{station_favicon}" alt="" onerror="this.style.display=\'none\'">'

        # Music note pulse animation — always shown
        pulse_html = '<span class="htmx-np-pulse">&#9835;</span>'

        if title:
            # Clean up common "StreamTitle=" artifacts
            title = re.sub(r"StreamTitle='?([^;']*)'?.*", r"\1", title).strip()
            html = f"""<div class="htmx-np-inner htmx-np-active" title="Toca para ver info detallada">
  {pulse_html}
  {favicon_html}
  <div class="htmx-np-texts">
    <span class="htmx-np-station"><i class="fas fa-radio"></i> {station_name}</span>
    <span class="htmx-np-title"><i class="fas fa-music"></i> {title}</span>
    <span class="htmx-np-subtitle"><i class="fas fa-circle-info"></i> Toca para ver metadatos y detalles</span>
  </div>
  <span class="htmx-np-live">LIVE</span>
</div>"""
        elif target_url:
            html = f"""<div class="htmx-np-inner htmx-np-waiting" title="Sintonizando radio">
  {pulse_html}
  {favicon_html}
  <div class="htmx-np-texts">
    <span class="htmx-np-station"><i class="fas fa-radio"></i> {station_name}</span>
    <span class="htmx-np-title htmx-np-dim"><i class="fas fa-spinner fa-spin"></i> Sintonizando transmisión...</span>
    <span class="htmx-np-subtitle">Conectando al servidor de audio</span>
  </div>
  <span class="htmx-np-live htmx-np-live-dim">LIVE</span>
</div>"""
        else:
            html = """<div class="htmx-np-inner htmx-np-idle">
  <span class="htmx-np-pulse">&#9835;</span>
  <div class="htmx-np-texts">
    <span class="htmx-np-station">Radios App</span>
    <span class="htmx-np-title">Selecciona una emisora para comenzar</span>
    <span class="htmx-np-subtitle"><i class="fas fa-sparkles"></i> Transmisión en vivo y metadatos</span>
  </div>
</div>"""

        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

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

    def handle_news(self):
        news = {
            "text": (
                "Estas son las noticias más importantes. "
                "El Congreso aprobó la nueva ley de reforma tributaria. "
                "La selección chilena se prepara para el próximo partido. "
                "Y el clima para hoy: cielos despejados en la zona central. "
                "Estas fueron las noticias."
            )
        }
        self.send_json(news)

    def handle_tts(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        text = params.get("text", [""])[0]

        if not text:
            self.send_json({"error": "No text provided"}, 400)
            return

        # Ensure cache dir exists
        os.makedirs(TTS_CACHE_DIR, exist_ok=True)

        text_hash = hashlib.md5(text.encode()).hexdigest()[:16]
        output_path = os.path.join(TTS_CACHE_DIR, f"{text_hash}.mp3")

        if not os.path.exists(output_path):
            safe_text = text.replace("'", "\\'")
            code = (
                "import asyncio; import edge_tts; "
                f"asyncio.run(edge_tts.Communicate('{safe_text}', '{TTS_VOICE}').save('{output_path}'))"
            )
            try:
                subprocess.run(
                    [TTS_VENV_PYTHON, "-c", code],
                    capture_output=True,
                    timeout=30,
                    text=True,
                )
            except subprocess.TimeoutExpired:
                self.send_json({"error": "TTS generation timed out"}, 500)
                return

            if not os.path.exists(output_path):
                self.send_json({"error": "TTS generation failed"}, 500)
                return

            # Schedule cleanup after 5 minutes
            def cleanup():
                time.sleep(300)
                try:
                    os.remove(output_path)
                except OSError:
                    pass

            threading.Thread(target=cleanup, daemon=True).start()

        try:
            with open(output_path, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "public, max-age=3600")
            self.end_headers()
            self.wfile.write(content)
        except Exception as e:
            self.send_json({"error": str(e)}, 500)

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

    # ── Playlist Management ──

    def handle_playlist_save(self):
        """Add a track to the local radio playlist with enriched metadata."""
        try:
            length = int(self.headers.get("Content-length", 0))
            body = self.rfile.read(length).decode("utf-8")
            data = json.loads(body)

            track_name = data.get("track", data.get("raw_title", ""))
            if not track_name:
                self.send_json({"error": "track or raw_title required"}, 400)
                return

            playlists_dir = os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "playlists"
            )
            os.makedirs(playlists_dir, exist_ok=True)
            playlist_path = os.path.join(playlists_dir, "radio.json")

            now = datetime.now().isoformat()

            track_entry = {
                "title": track_name,
                "artist": data.get("artist", ""),
                "album": data.get("album", ""),
                "genre": data.get("genre", ""),
                "year": data.get("year", ""),
                "duration": data.get("length", ""),
                "label": data.get("label", ""),
                "added_at": now,
            }

            if os.path.exists(playlist_path):
                with open(playlist_path, "r", encoding="utf-8") as f:
                    playlist = json.load(f)
            else:
                playlist = {
                    "name": "radio",
                    "created": now,
                    "updated": now,
                    "source": "radios-app",
                    "tracks": [],
                }

            if "tracks" not in playlist:
                playlist["tracks"] = []

            dupes = [
                t
                for t in playlist["tracks"]
                if t.get("title") == track_name
                and t.get("artist") == data.get("artist", "")
            ]
            if dupes:
                self.send_json(
                    {
                        "success": True,
                        "duplicate": True,
                        "message": "Ya está en la playlist",
                        "count": len(playlist["tracks"]),
                    }
                )
                return

            playlist["updated"] = now
            playlist["tracks"].append(track_entry)

            with open(playlist_path, "w", encoding="utf-8") as f:
                json.dump(playlist, f, indent=2, ensure_ascii=False)

            self.send_json(
                {"success": True, "duplicate": False, "count": len(playlist["tracks"])}
            )
        except Exception as e:
            self.send_json({"error": str(e)}, 500)

    def handle_get_feedback(self):
        """Get current vote for a song title."""
        try:
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)
            raw_title = params.get("raw_title", [""])[0]
            if not raw_title:
                self.send_json({"vote": None})
                return
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute(
                "SELECT vote FROM feedback WHERE raw_title = ? ORDER BY created_at DESC LIMIT 1",
                (raw_title,),
            )
            row = c.fetchone()
            conn.close()
            self.send_json({"vote": row[0] if row else None})
        except Exception as e:
            self.send_json({"vote": None, "error": str(e)})

    def handle_feedback(self):
        """Store like/dislike vote for a song."""
        try:
            length = int(self.headers.get("Content-length", 0))
            body = self.rfile.read(length).decode("utf-8")
            data = json.loads(body)

            raw_title = data.get("raw_title", "")
            artist = data.get("artist", "")
            track = data.get("track", "")
            vote = data.get("vote", "")

            if not raw_title or vote not in ("like", "dislike"):
                self.send_json(
                    {"error": "raw_title and vote (like/dislike) required"}, 400
                )
                return

            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()

            # Check if already voted
            c.execute(
                "SELECT vote FROM feedback WHERE raw_title = ? ORDER BY created_at DESC LIMIT 1",
                (raw_title,),
            )
            existing = c.fetchone()

            if existing and existing[0] == vote:
                # Same vote — toggle off
                c.execute("DELETE FROM feedback WHERE raw_title = ?", (raw_title,))
                conn.commit()
                conn.close()
                self.send_json(
                    {"action": "removed", "vote": vote, "raw_title": raw_title}
                )
                return

            # Insert new vote
            c.execute(
                "INSERT INTO feedback (raw_title, artist, track, vote, source) VALUES (?, ?, ?, ?, ?)",
                (raw_title, artist, track, vote, "popup"),
            )
            conn.commit()
            conn.close()
            self.send_json({"action": vote, "raw_title": raw_title})
        except Exception as e:
            self.send_json({"error": str(e)}, 500)


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
