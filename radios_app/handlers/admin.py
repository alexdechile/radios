"""Handlers de estaciones curadas."""
from __future__ import annotations

import json
import sqlite3
import urllib.parse
import uuid

from radios_app.storage import open_db


class AdminMixin:
    def handle_get_curated(self):
        try:
            conn = open_db()
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            c.execute(
                """
                SELECT * FROM curated_radios 
                ORDER BY 
                    position ASC, 
                    created_at ASC
                """
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
            st_uuid = data.get("uuid") or data.get("stationuuid") or str(uuid.uuid4())
            conn = open_db()
            c = conn.cursor()
            c.execute(
                """
                INSERT OR REPLACE INTO curated_radios
                    (uuid, name, url, favicon, tags, country, bitrate, codec,
                     homepage, language, state, clickcount, position,
                     editorial_notes, is_featured)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
                (
                    st_uuid,
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
                    data.get("position", 0),
                    data.get("editorial_notes", ""),
                    data.get("is_featured", 0),
                ),
            )
            conn.commit()
            conn.close()
            self.send_json({"status": "ok", "uuid": st_uuid})
        except Exception as e:
            self.send_json({"error": str(e)}, 500)

    def handle_update_curated(self):
        try:
            length = int(self.headers.get("Content-length", 0))
            body = self.rfile.read(length).decode("utf-8")
            data = json.loads(body)
            uuid = data.get("uuid", "")
            if not uuid:
                self.send_json({"error": "uuid required"}, 400)
                return
            conn = open_db()
            c = conn.cursor()
            c.execute("SELECT uuid FROM curated_radios WHERE uuid = ?", (uuid,))
            if not c.fetchone():
                conn.close()
                self.send_json({"error": "station not found"}, 404)
                return
            fields = []
            values = []
            for col in (
                "name", "url", "favicon", "tags", "country", "bitrate", "codec",
                "homepage", "language", "state", "clickcount", "position",
                "editorial_notes", "is_featured",
            ):
                if col in data:
                    fields.append(f"{col} = ?")
                    values.append(data[col])
            if not fields:
                conn.close()
                self.send_json({"error": "no fields to update"}, 400)
                return
            values.append(uuid)
            c.execute(
                f"UPDATE curated_radios SET {', '.join(fields)} WHERE uuid = ?",
                tuple(values),
            )
            conn.commit()
            conn.close()
            self.send_json({"status": "ok", "uuid": uuid})
        except Exception as e:
            self.send_json({"error": str(e)}, 500)

    def handle_reorder_curated(self):
        try:
            length = int(self.headers.get("Content-length", 0))
            body = self.rfile.read(length).decode("utf-8")
            data = json.loads(body)
            orders = data.get("orders", [])
            if not orders:
                self.send_json({"error": "orders array required"}, 400)
                return
            conn = open_db()
            c = conn.cursor()
            for entry in orders:
                c.execute(
                    "UPDATE curated_radios SET position = ? WHERE uuid = ?",
                    (entry.get("position", 0), entry.get("uuid", "")),
                )
            conn.commit()
            conn.close()
            self.send_json({"status": "ok", "updated": len(orders)})
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
            conn = open_db()
            c = conn.cursor()
            c.execute("DELETE FROM curated_radios WHERE uuid = ?", (uuid,))
            conn.commit()
            conn.close()
            self.send_json({"status": "deleted", "uuid": uuid})
        except Exception as e:
            self.send_json({"error": str(e)}, 500)
