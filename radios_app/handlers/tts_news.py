"""TTS y noticiero."""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import threading
import time
import urllib.parse

from radios_app.config import (
    NEWS_CACHE_TTL,
    NOTICIERO_PATH,
    NOTICIERO_SCRIPT,
    TTS_CACHE_DIR,
    TTS_MAX_TEXT_LENGTH,
    TTS_VENV_PYTHON,
    TTS_VOICE,
    TTS_WORKER,
)

NOTICIERO_LOCK = threading.Lock()


class TtsNewsMixin:
    def handle_news(self):
        # 1) Try reading cached noticiero.json
        if os.path.exists(NOTICIERO_PATH):
            try:
                age = time.time() - os.path.getmtime(NOTICIERO_PATH)
                if age < NEWS_CACHE_TTL * 60:
                    with open(NOTICIERO_PATH, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    if data.get("text"):
                        self.send_json(data)
                        return
            except Exception:
                pass

        # 2) Stale or missing — run noticiero.py
        self._run_noticiero()

        # 3) Read again
        if os.path.exists(NOTICIERO_PATH):
            try:
                with open(NOTICIERO_PATH, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if data.get("text"):
                    self.send_json(data)
                    return
            except Exception:
                pass

        # 4) Fallback
        self.send_json(
            {
                "text": "Noticiero Comerza. No pudimos obtener las noticias en este momento. Estas fueron las noticias. Gracias por sintonizarnos."
            }
        )

    def _run_noticiero(self):
        if not NOTICIERO_LOCK.acquire(blocking=False):
            return
        try:
            subprocess.run(
                [sys.executable, NOTICIERO_SCRIPT],
                capture_output=True,
                timeout=30,
            )
        except Exception as e:
            print(f"[server] noticiero.py failed: {e}", file=sys.stderr)
        finally:
            NOTICIERO_LOCK.release()

    def handle_tts(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        text = params.get("text", [""])[0]

        if not text:
            self.send_json({"error": "No text provided"}, 400)
            return
        if len(text) > TTS_MAX_TEXT_LENGTH:
            self.send_json({"error": "Text too long"}, 413)
            return

        # Ensure cache dir exists
        os.makedirs(TTS_CACHE_DIR, exist_ok=True)

        text_hash = hashlib.md5(text.encode()).hexdigest()[:16]
        output_path = os.path.join(TTS_CACHE_DIR, f"{text_hash}.mp3")

        if not os.path.exists(output_path):
            payload = json.dumps(
                {"text": text, "voice": TTS_VOICE, "output": output_path},
                ensure_ascii=False,
            )
            try:
                proc = subprocess.run(
                    [TTS_VENV_PYTHON, "-c", TTS_WORKER],
                    input=payload,
                    capture_output=True,
                    timeout=30,
                    text=True,
                )
            except subprocess.TimeoutExpired:
                self.send_json({"error": "TTS generation timed out"}, 500)
                return

            if proc.returncode != 0 or not os.path.exists(output_path):
                print(f"[TTS] worker failed: {proc.stderr[-500:]}", file=sys.stderr)
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
            self.send_header("Cache-Control", "public, max-age=3600")
            self.end_headers()
            self.wfile.write(content)
        except Exception as e:
            self.send_json({"error": str(e)}, 500)
