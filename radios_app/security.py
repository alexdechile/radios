"""Utilidades de seguridad: IPs, SSRF, Basic Auth y rate limiting persistente."""

from __future__ import annotations

import base64
import hmac
import ipaddress
import os
import socket
import sqlite3
import time
import urllib.parse

from .config import RATE_LIMIT_DB


def get_client_ip(client_address, headers) -> str:
    """Return the effective client IP, respecting Nginx trusted proxy headers."""
    direct_ip = client_address[0]
    if direct_ip in ("127.0.0.1", "::1"):
        for hdr in ("X-Real-IP", "X-Forwarded-For"):
            val = headers.get(hdr, "")
            if val:
                return val.split(",")[0].strip()
    return direct_ip


def is_tailscale_ip(ip_str: str) -> bool:
    """Return True if the IP is loopback, Tailscale IPv4 or Tailscale IPv6."""
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    if ip.is_loopback:
        return True
    if isinstance(ip, ipaddress.IPv4Address):
        return ip in ipaddress.ip_network("100.64.0.0/10")
    if isinstance(ip, ipaddress.IPv6Address):
        return ip in ipaddress.ip_network("fd7a:115c:a1e0::/48")
    return False


def basic_auth_matches(header: str, expected_user: str, expected_password: str) -> bool:
    """Valida un header Basic Auth contra las credenciales esperadas."""
    if not header.lower().startswith("basic "):
        return False
    try:
        encoded = header.split(" ", 1)[1].strip()
        decoded = base64.b64decode(encoded).decode("utf-8")
        user, _, password = decoded.partition(":")
    except Exception:
        return False
    return hmac.compare_digest(user, expected_user) and hmac.compare_digest(
        password, expected_password
    )


def is_public_http_url(raw_url: str) -> bool:
    """Return True only for http(s) URLs whose hostname resolves exclusively
    to public IPs. This blocks SSRF to localhost, LAN, Tailscale, metadata, etc."""
    try:
        parsed = urllib.parse.urlparse(raw_url)
        if parsed.scheme not in ("http", "https"):
            return False
        host = parsed.hostname
        if not host or parsed.username or parsed.password:
            return False
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        if not infos:
            return False
        for info in infos:
            ip_str = str(info[4][0]).split("%", 1)[0]
            ip = ipaddress.ip_address(ip_str)
            if not ip.is_global:
                return False
        return True
    except Exception:
        return False


class SQLiteRateLimiter:
    """Rate limiter de ventana deslizante persistido en SQLite.

    Funciona entre procesos/workers que compartan el mismo RATE_LIMIT_DB.
    Si SQLite falla, permite la petición para no bloquear tráfico legítimo.
    """

    def __init__(self, db_path: str = RATE_LIMIT_DB):
        self.db_path = db_path
        parent = os.path.dirname(db_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        self._init_db()

    def _connect(self):
        conn = sqlite3.connect(self.db_path, timeout=5)
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    def _init_db(self) -> None:
        try:
            conn = self._connect()
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS rate_limits (
                    bucket TEXT NOT NULL,
                    client_ip TEXT NOT NULL,
                    ts REAL NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup "
                "ON rate_limits (bucket, client_ip, ts)"
            )
            conn.commit()
            conn.close()
        except Exception:
            # Si no se puede inicializar, se comportará como fail-open.
            pass

    def allow(self, bucket: str, client_ip: str, limit: int, window: int = 60) -> bool:
        now = time.time()
        cutoff = now - window
        try:
            conn = self._connect()
            try:
                conn.execute("BEGIN IMMEDIATE")
                conn.execute("DELETE FROM rate_limits WHERE ts <= ?", (cutoff,))
                row = conn.execute(
                    "SELECT COUNT(*) FROM rate_limits WHERE bucket = ? AND client_ip = ?",
                    (bucket, client_ip),
                ).fetchone()
                if row and row[0] >= limit:
                    conn.commit()
                    return False
                conn.execute(
                    "INSERT INTO rate_limits (bucket, client_ip, ts) VALUES (?, ?, ?)",
                    (bucket, client_ip, now),
                )
                conn.commit()
                return True
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass
                return True
            finally:
                conn.close()
        except Exception:
            return True
