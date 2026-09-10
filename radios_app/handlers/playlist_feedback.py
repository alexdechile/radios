"""Playlist local y feedback de canciones."""
from __future__ import annotations

import json
import os
import threading
import urllib.parse
from datetime import datetime

from radios_app.storage import open_db

PLAYLIST_LOCK = threading.Lock()


class PlaylistFeedbackMixin:
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
            artist = data.get("artist", "")

            track_entry = {
                "title": track_name,
                "artist": artist,
                "album": data.get("album", ""),
                "genre": data.get("genre", ""),
                "year": data.get("year", ""),
                "duration": data.get("length", ""),
                "label": data.get("label", ""),
                "added_at": now,
            }

            # Lock para evitar perder actualizaciones si llegan dos guardados
            # simultáneos desde el popup de canción.
            with PLAYLIST_LOCK:
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
                    and t.get("artist") == artist
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
            conn = open_db()
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

            conn = open_db()
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
