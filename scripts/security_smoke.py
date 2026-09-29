#!/usr/bin/env python3
"""Smoke tests de seguridad para Radios App.

Levanta server.py en puertos libres y verifica:
- allowlist estática
- bloqueo SSRF
- Basic Auth del admin
- token de admin
- rate limiting persistente

Uso:
    python3 scripts/security_smoke.py
"""

from __future__ import annotations

import base64
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOST = "127.0.0.1"
ADMIN_USER = "smoke_admin"
ADMIN_PASSWORD = "smoke_password"
ADMIN_TOKEN = "smoke_token"


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((HOST, 0))
        return s.getsockname()[1]


def get(url: str, headers: dict[str, str] | None = None) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def basic_auth_header(user: str, password: str) -> dict[str, str]:
    raw = f"{user}:{password}".encode("utf-8")
    return {"Authorization": "Basic " + base64.b64encode(raw).decode("ascii")}


def wait_for_server(base: str, proc: subprocess.Popen | None = None, timeout: float = 30.0) -> None:
    deadline = time.time() + timeout
    last_error = None
    while time.time() < deadline:
        # Si el proceso murió (p.ej. un import que falta), reportar su stderr
        # en vez de esperar el timeout completo sin pistas.
        if proc is not None and proc.poll() is not None:
            stderr = ""
            try:
                if proc.stderr is not None:
                    stderr = (proc.stderr.read() or "").strip()
            except Exception:
                pass
            raise RuntimeError(
                f"El servidor terminó con código {proc.returncode} antes de responder. "
                f"stderr:\n{stderr}"
            )
        try:
            status, _ = get(base + "/api/version")
            if status == 200:
                return
        except Exception as exc:  # pragma: no cover - diagnóstico
            last_error = exc
        time.sleep(0.2)
    raise RuntimeError(f"El servidor no arrancó en {timeout:.0f}s: {last_error}")


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def start_server(
    env_overrides: dict[str, str], rate_db: str | None = None
) -> tuple[subprocess.Popen, str, str]:
    port = free_port()
    base = f"http://{HOST}:{port}"
    if rate_db is None:
        rate_fd, rate_db = tempfile.mkstemp(prefix="radios_rate_smoke_", suffix=".db")
        os.close(rate_fd)
    env = dict(os.environ)
    env.update(env_overrides)
    env["RATE_LIMIT_DB"] = rate_db
    env["PYTHONUNBUFFERED"] = "1"
    proc = subprocess.Popen(
        [sys.executable, "server.py", "--port", str(port)],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    wait_for_server(base, proc)
    return proc, base, rate_db


def stop_server(proc: subprocess.Popen | None, rate_db: str | None) -> None:
    if proc is not None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
    if rate_db:
        try:
            os.remove(rate_db)
        except OSError:
            pass


def test_basic_security() -> None:
    proc, base, rate_db = start_server(
        {
            "ADMIN_USER": ADMIN_USER,
            "ADMIN_PASSWORD": ADMIN_PASSWORD,
        }
    )
    try:
        # 1) Allowlist estática
        status, _ = get(base + "/")
        expect(status == 200, f"/ debería ser 200, fue {status}")
        for forbidden in ("/server.py", "/.git/config", "/radios_curated.db", "/vendor/../server.py"):
            status, _ = get(base + forbidden)
            expect(status in (403, 404), f"{forbidden} debería ser 403/404, fue {status}")

        for public in (
            "/vendor/plyr/plyr.js",
            "/vendor/htmx/htmx.min.js",
            "/vendor/fontawesome/css/all.min.css",
            "/vendor/fonts/inter.css",
        ):
            status, _ = get(base + public)
            expect(status == 200, f"{public} debería ser 200, fue {status}")

        # 2) SSRF
        status, _ = get(base + "/api/healthcheck?url=file:///etc/passwd")
        expect(status == 403, f"healthcheck SSRF debería ser 403, fue {status}")
        status, _ = get(base + "/proxy?url=http://127.0.0.1:1/")
        expect(status == 403, f"proxy SSRF debería ser 403, fue {status}")

        # 3) Basic Auth admin
        status, _ = get(base + "/admin")
        expect(status == 401, f"/admin sin auth debería ser 401, fue {status}")
        status, _ = get(base + "/admin", headers=basic_auth_header(ADMIN_USER, ADMIN_PASSWORD))
        expect(status == 200, f"/admin con auth debería ser 200, fue {status}")

        # 4) Handlers modulares: rutas baratas que no mutan ni salen a Internet.
        endpoint_expectations = {
            "/api/curated": 200,
            "/api/songinfo": 400,
            "/api/lyrics": 200,
            "/api/nowplaying": 200,
            "/api/websearch": 400,
            "/api/feedback": 200,
        }
        for endpoint, expected in endpoint_expectations.items():
            status, _ = get(base + endpoint)
            expect(status == expected, f"{endpoint} debería ser {expected}, fue {status}")

        # 5) Rate limiting: /api/tts sin texto responde 400, la sexta debe ser 429.
        codes = []
        for _ in range(6):
            status, _ = get(base + "/api/tts")
            codes.append(status)
        expect(codes[:5] == [400] * 5, f"TTS previos deberían ser 400, fueron {codes}")
        expect(codes[5] == 429, f"TTS sexto debería ser 429, fue {codes[5]}")
    finally:
        stop_server(proc, rate_db)


def test_rate_limit_persistent() -> None:
    rate_fd, rate_db = tempfile.mkstemp(prefix="radios_rate_persist_", suffix=".db")
    os.close(rate_fd)

    proc, base, _ = start_server({}, rate_db=rate_db)
    try:
        for _ in range(5):
            status, _ = get(base + "/api/tts")
            expect(status == 400, f"TTS previo a persistencia debería ser 400, fue {status}")
    finally:
        stop_server(proc, None)

    proc, base, _ = start_server({}, rate_db=rate_db)
    try:
        status, _ = get(base + "/api/tts")
        expect(status == 429, f"TTS tras reinicio debería ser 429, fue {status}")
    finally:
        stop_server(proc, rate_db)


def test_admin_token() -> None:
    proc, base, rate_db = start_server(
        {
            "ADMIN_TOKEN": ADMIN_TOKEN,
        }
    )
    try:
        status, body = get(base + "/api/admin/status")
        expect(status == 200, f"/api/admin/status debería ser 200, fue {status}")
        expect(b'"token_required": true' in body, f"token_required no true: {body!r}")

        status, _ = get(base + "/admin")
        expect(status == 200, f"/admin con token mode debería ser 200, fue {status}")

        status, _ = get(base + "/api/admin/check")
        expect(status == 401, f"check sin token debería ser 401, fue {status}")

        status, _ = get(base + "/api/admin/check", headers={"X-Admin-Token": ADMIN_TOKEN})
        expect(status == 200, f"check con token debería ser 200, fue {status}")

        status, _ = get(base + "/api/admin/check", headers={"X-Admin-Token": "incorrecto"})
        expect(status == 401, f"check con token inválido debería ser 401, fue {status}")
    finally:
        stop_server(proc, rate_db)


def main() -> int:
    try:
        test_basic_security()
        test_rate_limit_persistent()
        test_admin_token()
        print("OK: smoke tests de seguridad pasaron")
        return 0
    except Exception as exc:
        print(f"FALLO: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
