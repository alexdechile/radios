"""Configuración central de Radios App."""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent

PORT = int(os.environ.get("PORT", 8000))
DB_PATH = str(ROOT_DIR / "radios_curated.db")
RATE_LIMIT_DB = os.environ.get(
    "RATE_LIMIT_DB", str(ROOT_DIR / "radios_rate_limit.db")
)

TTS_VENV_PYTHON = os.environ.get("TTS_VENV_PYTHON", sys.executable)
TTS_VOICE = "es-CL-CatalinaNeural"
TTS_CACHE_DIR = "/tmp/radios_tts_cache"
TTS_MAX_TEXT_LENGTH = 3000

NOTICIERO_PATH = str(ROOT_DIR / "noticiero.json")
NOTICIERO_SCRIPT = str(ROOT_DIR / "scripts" / "noticiero.py")
NEWS_CACHE_TTL = 25  # minutes

ADMIN_USER = os.environ.get("ADMIN_USER", "")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")

PUBLIC_FILES = {
    "index.html",
    "style.css",
    "app.js",
    "admin.html",
    "admin.js",
    "manifest.json",
    "sw.js",
    "icon.svg",
    "icon-192.png",
    "icon-512.png",
    "radios_db.json",
}
PUBLIC_PREFIXES = ("vendor/",)

# Código fijo que se ejecuta en el proceso de TTS. El texto entra por stdin
# como JSON, por lo que nunca se concatena código Python.
TTS_WORKER = r"""
import asyncio
import json
import sys

import edge_tts

payload = json.load(sys.stdin)
text = payload["text"]
voice = payload["voice"]
output = payload["output"]
asyncio.run(edge_tts.Communicate(text, voice).save(output))
"""
