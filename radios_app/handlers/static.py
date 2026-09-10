"""Servidor estático con allowlist."""
from __future__ import annotations

import os
import urllib.parse

from radios_app.config import PUBLIC_FILES, PUBLIC_PREFIXES


class StaticMixin:
    def handle_static(self):
        # Servir solo una allowlist de archivos públicos. Nunca .git, .py,
        # bases de datos, scripts ni documentación interna.
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path or "/")
        if path == "/":
            path = "/index.html"
        elif path in ("/admin", "/admin/"):
            path = "/admin.html"

        local_path = os.path.normpath(path.lstrip("/"))
        if os.path.isabs(local_path) or local_path in (".", "..") or local_path.startswith("../"):
            self.send_error(403, "Forbidden")
            return
        if local_path not in PUBLIC_FILES and not local_path.startswith(PUBLIC_PREFIXES):
            self.send_error(404, "File not found")
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
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                self.wfile.write(content)
        except Exception as e:
            self.send_error(500, str(e))
