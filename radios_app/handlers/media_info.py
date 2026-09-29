"""Letras, metadata de canciones y Wikipedia/MusicBrainz."""
from __future__ import annotations

import sys

import difflib
import json
import sqlite3
import re
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timedelta

from scrapling.fetchers import Fetcher

from radios_app.storage import open_db

# Versión del algoritmo de metadata. Al aumentarla, las entradas viejas de
# song_cache se consideran obsoletas y se vuelven a consultar.
SONGINFO_CACHE_VERSION = 3


class MediaInfoMixin:
    def handle_songinfo(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)
            raw_title = params.get("title", [""])[0]

            if not raw_title:
                self.send_json({"error": "No title provided"}, 400)
                return

            conn = open_db()
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
                        try:
                            cache_meta_version = int(row_dict.get("meta_version") or 1)
                        except Exception:
                            cache_meta_version = 1
                        if (
                            age < timedelta(days=7)
                            and (has_thumbnail or age < timedelta(days=1))
                            and cache_meta_version >= SONGINFO_CACHE_VERSION
                        ):
                            row_dict["cached"] = True
                            # album_tracks se guarda como JSON en SQLite; exponerlo como lista.
                            raw_tracks = row_dict.get("album_tracks")
                            if raw_tracks:
                                try:
                                    row_dict["album_tracks"] = json.loads(raw_tracks)
                                except Exception:
                                    row_dict["album_tracks"] = []
                            else:
                                row_dict["album_tracks"] = []
                            conn.close()
                            self.send_json(row_dict)
                            return
                    except Exception:
                        pass
            conn.close()

            result = self._search_song_info(raw_title)

            if result.get("source"):
                conn = open_db()
                c = conn.cursor()
                c.execute(
                    """
                    INSERT OR REPLACE INTO song_cache (raw_title, artist, track, album, genre, year, source,
                        writer, producer, label, length, description, thumbnail, wiki_url, release_id, album_tracks, meta_version)
                    VALUES (?, ?, ?, ?, ?, ?, ?,
                        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                        result.get("release_id"),
                        json.dumps(result.get("album_tracks") or []),
                        SONGINFO_CACHE_VERSION,
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
                    "release_id": None,
                    "album_tracks": [],
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
            conn = open_db()
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
            conn = open_db()
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

    def _clean_track_string(self, text):
        """Clean and normalize track/artist text, fixing broken apostrophes, radio prefixes, etc."""
        if not text:
            return ""
        t = text.strip()
        # Fix broken or cutoff apostrophes at the end of word or line
        # e.g. "Don " -> "Don't ", "It " -> "It's ", or trailing apostrophe
        t = re.sub(r"^(Don|Can|Won|Didn|Isn|Aren|Couldn|Wouldn|Shouldn)\b(?!\w|')", r"\1't", t, flags=re.IGNORECASE)
        t = re.sub(r"^It\b(?!\w|')", "It's", t, flags=re.IGNORECASE)
        t = re.sub(r"\b(Don|Can|Won|Didn|Isn|Aren|Couldn|Wouldn|Shouldn)\s+([A-Z])", r"\1't \2", t)
        return t.strip()

    def _parse_title(self, raw_title):
        """Parse 'Artist - Track' or 'Artist – Track' or 'Artist | Track' from raw_title,
        stripping common broadcaster prefixes and suffixes."""
        if not raw_title:
            return None, ""

        clean = raw_title.strip()

        # Remove broadcaster prefixes like "Now On Air:", "Now Playing:", "Sintonizas:", etc.
        clean = re.sub(
            r"^(Now\s+On\s+Air\s*:?|Now\s+Playing\s*:?|Playing\s*:?|On\s+Air\s*:?|En\s+Vivo\s*:?|Sintonizas\s*:?|Estás\s+Escuchando\s*:?)\s*",
            "",
            clean,
            flags=re.IGNORECASE,
        ).strip()

        # Remove trailing station branding like "| Radio XYZ", "// 98.5 FM", "- Online", etc.
        clean = re.sub(
            r"\s*(\||\/\/)\s*(radio|fm|stream|en vivo|online|hit|music).*",
            "",
            clean,
            flags=re.IGNORECASE,
        ).strip()

        for sep in [" – ", " - ", " | ", " — "]:
            if sep in clean:
                parts = clean.split(sep, 1)
                artist = parts[0].strip()
                song = parts[1].strip()

                # Cleanup prefixes that might have remained on artist
                artist = re.sub(
                    r"^(Now\s+On\s+Air\s*:?|Now\s+Playing\s*:?|Playing\s*:?|On\s+Air\s*:?)\s*",
                    "",
                    artist,
                    flags=re.IGNORECASE,
                ).strip()

                # Remove common suffixes like (Radio Edit), [Official], etc.
                song = re.sub(
                    r"\s*(\(|\[)(radio edit|official|remaster|live|acoustic|version|feat\.?.*)(\)|\])",
                    "",
                    song,
                    flags=re.IGNORECASE,
                ).strip()

                # Remove station branding if present at the end of song
                song = re.sub(
                    r"\s*(\||\/\/)\s*.*",
                    "",
                    song,
                    flags=re.IGNORECASE,
                ).strip()

                artist = self._clean_track_string(artist)
                song = self._clean_track_string(song)
                return artist, song

        clean = self._clean_track_string(clean)
        return None, clean

    def _search_song_info(self, raw_title):
        artist, song = self._parse_title(raw_title)
        base = {"raw_title": raw_title, "artist": artist, "track": song}

        # If song or artist is suspiciously empty or extremely short without substance, skip
        if not song or (len(song) <= 2 and not artist):
            return base

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

        # ── 2) Wikipedia song search (fallback with strict validation) ──
        if artist and song and len(song) >= 2:
            wiki = self._search_wikipedia_song(artist, song)
            if wiki:
                base.update(wiki)
                base["source"] = "wikipedia"
                return base

        # ── 3) DuckDuckGo → Wikipedia (last resort, strict song check) ──
        if artist and song and len(song) >= 3:
            ddg = self._search_duckduckgo_song(f"{artist} {song}")
            if ddg:
                base.update(ddg)
                base["source"] = "duckduckgo"
                return base

        return base

    def _search_wikipedia_song(self, artist, song):
        """Search Wikipedia specifically for the SONG page (not an unrelated book/biography).
        Validates that the result is actually about the song and artist."""
        if not artist or not song:
            return None

        # If the song title is very short (e.g. "Don", "It", "Me"), require strict matching
        is_short_title = len(song.strip()) <= 3

        # Ordered queries from most specific to least specific
        queries = [
            f'"{song}" "{artist}"',
            f"{song} {artist} song",
            f"{song} {artist} single",
            f"{song} {artist} canción",
        ]

        artist_lower = artist.lower()
        song_lower = song.lower()

        # Words that indicate a false positive when matched against non-music articles
        unwanted_categories = [
            "novela", "novel", "libro", "book", "escritor", "writer", "político",
            "politician", "militar", "military", "desambiguación", "disambiguation",
            "futbolista", "footballer", "ciudad", "city", "provincia", "province"
        ]

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

                    for page in pages:
                        page_title_lower = page["title"].lower()
                        snippet_lower = page.get("snippet", "").lower()

                        # Skip pages that look like artist biopages (title == artist only)
                        if page_title_lower == artist_lower:
                            continue
                        # Skip disambiguation pages
                        if "disambiguation" in page_title_lower or "desambiguación" in page_title_lower:
                            continue

                        # Check for unwanted non-music contexts if artist is absent in title/snippet
                        if any(cat in snippet_lower for cat in unwanted_categories):
                            # Allow only if music terms strongly present
                            if not any(m in snippet_lower for m in ("canción", "song", "single", "álbum", "album", "banda", "band")):
                                continue

                        # Relevance check:
                        # 1. Both artist and song should be related to the snippet/title
                        artist_words = [w for w in re.findall(r"\w+", artist_lower) if len(w) >= 3]

                        has_artist_match = any(w in snippet_lower or w in page_title_lower for w in artist_words) if artist_words else (artist_lower in snippet_lower)

                        # Siempre exigimos relación con el artista para evitar
                        # biografías o canciones homónimas de otro intérprete.
                        if not has_artist_match:
                            continue

                        # For short titles like "Don" or "It", we MUST have an artist match AND music term
                        if is_short_title:
                            if not any(m in snippet_lower or m in page_title_lower for m in ("song", "canción", "single")):
                                continue
                        else:
                            music_terms = ("song", "canción", "single", "album", "álbum", "banda", "band")
                            if not (
                                song_lower in page_title_lower
                                or song_lower in snippet_lower
                                or any(m in snippet_lower or m in page_title_lower for m in music_terms)
                            ):
                                continue

                        summary = self._fetch_wikipedia_summary(
                            page["title"], lang=lang
                        )
                        if summary:
                            desc = summary.get("description", "").lower()
                            # Extra sanity check on description
                            if is_short_title and not any(w in desc for w in artist_words):
                                continue
                            return summary

                except Exception as e:
                    print(
                        f"[SONGINFO] Wikipedia song search ({lang}) error '{query}': {e}",
                        file=sys.stderr,
                    )
                    continue

        return None

    def _search_duckduckgo_song(self, query):
        """DuckDuckGo fallback search for song."""
        try:
            ddg_url = f"https://lite.duckduckgo.com/lite/?q={urllib.parse.quote(query + ' canción')}"
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

    @staticmethod
    def _format_duration(ms):
        """Convierte milisegundos de MusicBrainz a mm:ss."""
        if not ms:
            return ""
        try:
            total_seconds = int(ms) // 1000
            return f"{total_seconds // 60}:{total_seconds % 60:02d}"
        except Exception:
            return ""

    @staticmethod
    def _release_quality_score(release):
        """Puntúa qué tan canónico es un release (álbum de estudio oficial).

        Penaliza fuertemente bootlegs y ediciones en vivo: MusicBrainz suele
        devolverlas primero para grabaciones muy versionadas, y elegirlas
        produce álbumes, sellos y tracklists equivocados.
        """
        rg = release.get("release-group") or {}
        primary = (rg.get("primary-type") or "").lower()
        secondary = [t.lower() for t in (rg.get("secondary-types") or [])]
        status = (release.get("status") or "").lower()
        disambiguation = (release.get("disambiguation") or "").lower()
        title = (release.get("title") or "").lower()
        total = 0
        if primary == "album":
            total += 30
        elif primary == "single":
            total += 20
        elif primary == "ep":
            total += 15
        if "compilation" in secondary:
            total -= 25
        if "live" in secondary:
            total -= 15
        if "soundtrack" in secondary:
            total -= 10
        if "interview" in secondary or "spokenword" in secondary:
            total -= 40
        if "demo" in secondary:
            total -= 20
        if status == "official":
            total += 10
        elif status == "bootleg":
            total -= 60
        # Ediciones derivadas (5.1, remixes, instrumentales, karaoke) no
        # representan el álbum original ni su tracklist.
        for marker in (
            "mix", "remix", "instrumental", "karaoke", "commentary",
            "interview", "a cappella", "acapella", "demo", "tribute",
        ):
            if marker in disambiguation:
                total -= 25
                break
        if "interview" in title or "commentary" in title:
            total -= 20
        if release.get("date"):
            total += 2
        track_count = release.get("track-count") or 0
        if 5 <= track_count <= 30:
            total += 5
        elif track_count > 60:
            total -= 5
        return total

    @classmethod
    def _sort_releases_by_relevance(cls, releases):
        """Ordena releases de MusicBrainz priorizando álbumes/singles oficiales.

        El primer release de una grabación suele ser una compilación oscura o
        una edición rara. A igual calidad se prefiere la edición más antigua
        (la original) y se dejan al final las que no tienen fecha.
        """
        if not releases:
            return []

        def date_key(release):
            year = (release.get("date") or "")[:4]
            try:
                return int(year)
            except ValueError:
                return 9999  # sin fecha conocida, al final

        return sorted(
            releases,
            key=lambda r: (cls._release_quality_score(r), -date_key(r)),
            reverse=True,
        )

    def _fetch_release_tracks(self, release_id, limit=60):
        """Obtiene el listado de temas de un release de MusicBrainz.

        Es una llamada adicional bajo demanda, con timeout corto y tolerante a
        fallos: si MusicBrainz no responde, el modal simplemente omite la
        sección de álbum.
        """
        if not release_id:
            return []
        try:
            url = (
                f"https://musicbrainz.org/ws/2/release/{release_id}"
                "?fmt=json&inc=recordings"
            )
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "RadiosApp/1.0 (radios-sketch@donalex)"},
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read().decode("utf-8"))

            tracks = []
            for medium in data.get("media", []):
                disc = medium.get("position") or 1
                for track in medium.get("tracks", []):
                    title = (track.get("title") or "").strip()
                    if not title:
                        continue
                    tracks.append(
                        {
                            "disc": disc,
                            "position": track.get("number")
                            or track.get("position")
                            or "",
                            "title": title,
                            "length": self._format_duration(track.get("length")),
                        }
                    )
                    if len(tracks) >= limit:
                        return tracks
            return tracks
        except Exception as e:
            print(
                f"[SONGINFO] MusicBrainz release tracks error: {e}",
                file=sys.stderr,
            )
            return []

    @staticmethod
    def _normalize_match_text(text):
        """Normaliza texto para comparar artista/título sin acentos ni signos."""
        if not text:
            return ""
        value = unicodedata.normalize("NFKD", str(text))
        value = "".join(ch for ch in value if not unicodedata.combining(ch))
        return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()

    def _recording_artist_name(self, rec):
        parts = []
        for credit in rec.get("artist-credit") or []:
            if isinstance(credit, dict):
                name = credit.get("name") or (credit.get("artist") or {}).get("name")
                if name:
                    parts.append(name)
            elif isinstance(credit, str):
                parts.append(credit)
        return " ".join(parts).strip()

    def _recording_match_score(self, rec, artist, track):
        """Puntúa por separado el artista y el título de una grabación (0-100).

        Se separan a propósito: un título exacto NO debe bastar si el artista
        no calza, porque eso aceptaba covers y actos de nombre parecido
        (p.ej. "Kiss" contra "Kissin' Dynamite" o "The Killers" contra
        "The Kills"). El llamador exige un mínimo en cada subscore.
        """
        input_artist = self._normalize_match_text(artist)
        input_track = self._normalize_match_text(track)
        cand_artist = self._normalize_match_text(self._recording_artist_name(rec))
        cand_track = self._normalize_match_text(rec.get("title") or "")

        # ── Artista ──
        artist_score = 0
        if input_artist and cand_artist:
            if input_artist == cand_artist:
                artist_score = 100
            else:
                input_tokens = set(input_artist.split())
                cand_tokens = set(cand_artist.split())
                overlap = len(input_tokens & cand_tokens) / max(1, len(input_tokens))
                if input_tokens and input_tokens <= cand_tokens:
                    # Todas las palabras del artista están presentes
                    # (ej. "Los Prisioneros" vs "Los Prisioneros feat. X").
                    artist_score = 80
                elif (
                    input_artist in cand_artist or cand_artist in input_artist
                ) and overlap >= 0.5:
                    # La subcadena solo cuenta con solapamiento real de
                    # palabras: evita que "kiss" calce con "kissin dynamite".
                    artist_score = 60
                artist_score = max(artist_score, int(overlap * 90))

        # ── Título ──
        track_score = 0
        if input_track and cand_track:
            if input_track == cand_track:
                track_score = 100
            elif input_track in cand_track or cand_track in input_track:
                # Caso típico: "Evergreen" vs "Evergreen (Love Theme...)".
                track_score = 85
            else:
                ratio = difflib.SequenceMatcher(None, input_track, cand_track).ratio()
                track_score = int(ratio * 100)

        return artist_score, track_score

    def _search_musicbrainz(self, artist, track):
        """Search MusicBrainz for recording metadata: cover art, genres, artist image."""
        if not artist or not track:
            return None
        try:
            # El artista y el título deben calzar cada uno por su lado.
            ARTIST_MIN = 60
            TRACK_MIN = 60
            # Un release de estudio oficial puntúa ~45; por debajo de este
            # umbral se sigue buscando variantes de consulta.
            GOOD_RELEASE = 35

            # Se combinan varias consultas. La primera prioriza releases
            # oficiales y descarta en vivo, que suelen copar los resultados de
            # grabaciones muy versionadas (p.ej. "Bohemian Rhapsody").
            queries = [
                f'artist:"{artist}" AND recording:"{track}" AND status:official',
                f'artist:"{artist}" AND recording:"{track}" AND NOT secondarytype:live',
                f'artist:"{artist}" AND recording:"{track}"',
                f'{artist} {track}',
            ]
            candidates = {}
            for query_str in queries:
                mb_url = (
                    "https://musicbrainz.org/ws/2/recording/"
                    f"?query={urllib.parse.quote(query_str)}&fmt=json&limit=10"
                )
                req = urllib.request.Request(
                    mb_url, headers={"User-Agent": "RadiosApp/1.0 (radios-sketch@donalex)"}
                )
                try:
                    with urllib.request.urlopen(req, timeout=10) as resp:
                        data = json.loads(resp.read().decode("utf-8"))
                except Exception:
                    continue

                for rec in data.get("recordings", []):
                    artist_score, track_score = self._recording_match_score(
                        rec, artist, track
                    )
                    if artist_score < ARTIST_MIN or track_score < TRACK_MIN:
                        continue
                    releases = rec.get("releases") or []
                    quality = max(
                        (self._release_quality_score(r) for r in releases),
                        default=0,
                    )
                    rec_id = rec.get("id") or f"{artist}|{track}|{rec.get('title')}"
                    prev = candidates.get(rec_id)
                    if prev is None or quality > prev["quality"]:
                        candidates[rec_id] = {
                            "rec": rec,
                            "text": artist_score + track_score,
                            "quality": quality,
                            "releases": releases,
                        }

                # Ya hay una grabación con álbum de estudio oficial: no vale la
                # pena seguir consultando variantes más laxas.
                if any(c["quality"] >= GOOD_RELEASE for c in candidates.values()):
                    break

            if not candidates:
                print(
                    f"[SONGINFO] Sin match confiable en MusicBrainz para '{artist} - {track}'",
                    file=sys.stderr,
                )
                return None

            # Mejor release primero y, a igualdad, mejor calce de texto.
            best = max(
                candidates.values(),
                key=lambda c: (c["quality"], c["text"]),
            )
            rec = best["rec"]
            releases = self._sort_releases_by_relevance(best["releases"])
            best_quality = best["quality"]

            result = {}

            # ── Cover art & Label info: try releases ──
            release_ids = []
            if releases:
                for release in releases[:5]:  # try up to 5 releases
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

            # ── Album tracklist (release más relevante) ──
            # Se omite si el mejor release es un bootleg (best_quality < 0):
            # mostrar el tracklist de una edición pirata es peor que no
            # mostrar ninguno. Se guarda en caché junto al resto de metadata.
            primary_release_id = (
                releases[0].get("id") if releases and releases[0].get("id") else None
            )
            if not primary_release_id and release_ids:
                primary_release_id = release_ids[0]
            if primary_release_id and best_quality >= 0:
                result["release_id"] = primary_release_id
                tracks = self._fetch_release_tracks(primary_release_id)
                if tracks:
                    result["album_tracks"] = tracks

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
                if not result.get("thumbnail") and releases:
                    for release in releases[:3]:
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

            # Álbum desde el release más relevante (nunca desde un bootleg).
            if releases and releases[0].get("title") and best_quality >= 0:
                result["album"] = releases[0]["title"]
                release_date = releases[0].get("date", "")
                if release_date:
                    result["year"] = release_date[:4]

            # Las portadas de Cover Art Archive llegan como http:// y quedan
            # bloqueadas como mixed content en páginas https.
            thumb = result.get("thumbnail")
            if isinstance(thumb, str) and thumb.startswith("http://"):
                result["thumbnail"] = "https://" + thumb[len("http://"):]

            return result if result else None
        except Exception as e:
            print(f"[SONGINFO] MusicBrainz error: {e}", file=sys.stderr)
            return None
