"""Handlers de estaciones curadas."""
from __future__ import annotations

import json
import re
import sqlite3
import unicodedata
import urllib.parse
import uuid

from radios_app.storage import open_db


def normalize_voice_name(value):
    """Normaliza un alias para comparar sin acentos, mayúsculas ni signos."""
    if not value:
        return ""
    text = unicodedata.normalize("NFKD", str(value))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def voice_name_exists(cursor, voice_name, exclude_uuid=None):
    key = normalize_voice_name(voice_name)
    if not key:
        return False
    if exclude_uuid:
        cursor.execute(
            "SELECT voice_name FROM curated_radios WHERE uuid != ?",
            (exclude_uuid,),
        )
    else:
        cursor.execute("SELECT voice_name FROM curated_radios")
    return any(normalize_voice_name(row[0]) == key for row in cursor.fetchall())


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

            c.execute("SELECT uuid FROM curated_radios WHERE uuid = ?", (st_uuid,))
            existing = c.fetchone() is not None

            # El uuid que se está escribiendo se excluye del chequeo para que un
            # re-envío de la misma estación conserve su alias (antes daba 409).
            if voice_name_exists(
                c, data.get("voice_name", ""), st_uuid if existing else None
            ):
                conn.close()
                self.send_json({"error": "voice_name duplicado"}, 409)
                return

            upsalable_columns = (
                "name", "url", "favicon", "tags", "country", "bitrate", "codec",
                "homepage", "language", "state", "clickcount", "position",
                "editorial_notes", "is_featured", "voice_name",
            )

            if existing:
                # Actualización parcial: NO se usa INSERT OR REPLACE porque
                # borraría los campos omitidos (alias, nota editorial, etc.).
                fields = []
                values = []
                for col in upsalable_columns:
                    if col in data:
                        fields.append(f"{col} = ?")
                        values.append(data[col])
                if fields:
                    values.append(st_uuid)
                    c.execute(
                        f"UPDATE curated_radios SET {', '.join(fields)} WHERE uuid = ?",
                        tuple(values),
                    )
            else:
                c.execute(
                    """
                    INSERT INTO curated_radios
                        (uuid, name, url, favicon, tags, country, bitrate, codec,
                         homepage, language, state, clickcount, position,
                         editorial_notes, is_featured, voice_name)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                        data.get("voice_name", ""),
                    ),
                )
            conn.commit()
            conn.close()
            self.send_json({"status": "ok", "uuid": st_uuid, "updated": existing})
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
            if "voice_name" in data and voice_name_exists(c, data.get("voice_name", ""), uuid):
                conn.close()
                self.send_json({"error": "voice_name duplicado"}, 409)
                return
            fields = []
            values = []
            for col in (
                "name", "url", "favicon", "tags", "country", "bitrate", "codec",
                "homepage", "language", "state", "clickcount", "position",
                "editorial_notes", "is_featured", "voice_name",
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
