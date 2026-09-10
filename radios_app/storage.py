"""Acceso a SQLite y migraciones de esquema."""

from __future__ import annotations

import sqlite3

from .config import DB_PATH


def open_db():
    """Abre una conexión SQLite con timeout y busy_timeout."""
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("PRAGMA busy_timeout=10000")
    return conn


def init_db() -> None:
    """Inicializa tablas y aplica migraciones idempotentes."""
    conn = open_db()
    conn.execute("PRAGMA journal_mode=WAL")
    c = conn.cursor()
    c.execute(
        """
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
    """
    )
    c.execute(
        """
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
    """
    )
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
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            raw_title TEXT NOT NULL,
            artist TEXT DEFAULT '',
            track TEXT DEFAULT '',
            vote TEXT NOT NULL,
            source TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """
    )
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS lyrics_cache (
            raw_title TEXT PRIMARY KEY,
            artist TEXT,
            track TEXT,
            lyrics TEXT,
            source TEXT,
            fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """
    )
    for col, typedef in [
        ("editorial_notes", "TEXT DEFAULT ''"),
        ("is_featured", "INTEGER DEFAULT 0"),
    ]:
        try:
            c.execute(f"ALTER TABLE curated_radios ADD COLUMN {col} {typedef}")
        except sqlite3.OperationalError:
            pass
    conn.commit()
    conn.close()
