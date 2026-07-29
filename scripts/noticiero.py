#!/usr/bin/env python3
"""Noticiero Comerza — genera noticiero.json desde fuentes de noticias chilenas."""

import json
import os
import re
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT_PATH = os.path.join(BASE_DIR, "noticiero.json")

COOPERATIVA_RSS = "https://www.cooperativa.cl/noticias/site/tax/port/all/rss_3___1.xml"
EXANTE_URL = "https://www.ex-ante.cl/"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)

CHILE_OFFSET = timedelta(hours=-4)

PRIORITY_KEYWORDS = [
    "accidente",
    "choque",
    "colisión",
    "incendio",
    "evacuación",
    "carabinero",
    "policial",
    "detenido",
    "operativo",
    "metro",
    "autopista",
    "ruta",
    "tránsito",
    "corte",
    "temporal",
    "inundación",
    "alerta",
    "emergencia",
    "bencina",
    "asalto",
    "robo",
    "homicidio",
    "falleció",
    "rescate",
]


# ── Fuente 1: Cooperativa.cl RSS ──────────────────────────────────


def fetch_cooperativa():
    req = urllib.request.Request(COOPERATIVA_RSS, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read()


def is_today_chile(pub_date_str):
    try:
        dt = datetime.strptime(pub_date_str.strip(), "%a, %d %b %Y %H:%M:%S %z")
    except (ValueError, AttributeError):
        return False
    chile_now = datetime.now(timezone.utc) + CHILE_OFFSET
    return dt.astimezone(timezone.utc).date() == chile_now.date()


def parse_cooperativa(xml_data):
    root = ET.fromstring(xml_data)
    items = []
    for item in root.iter("item"):
        title_el = item.find("title")
        pubdate_el = item.find("pubDate")
        if title_el is None or pubdate_el is None:
            continue
        title = clean_title(title_el.text or "")
        pubdate = pubdate_el.text or ""
        if not title or not pubdate:
            continue
        items.append({"title": title, "pubdate": pubdate, "source": "Cooperativa"})
    return items


# ── Fuente 2: Ex-Ante.cl scraping ─────────────────────────────────


def fetch_exante():
    req = urllib.request.Request(EXANTE_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode("utf-8", errors="replace")


def parse_exante(html):
    titles = re.findall(r"<h3[^>]*><a[^>]*>([^<]+)</a></h3>", html)
    seen = set()
    items = []
    for t in titles:
        t = clean_title(t)
        if not t or len(t) < 15:
            continue
        if t.lower() in seen:
            continue
        seen.add(t.lower())
        items.append({"title": t, "source": "Ex-Ante"})
    return items


# ── Utilidades ────────────────────────────────────────────────────


def clean_title(title):
    title = re.sub(r"<[^>]+>", "", title)
    title = re.sub(r"&#\d+;", "", title)
    title = re.sub(r"\s+", " ", title).strip()
    title = title.rstrip(".!?,;:")
    return title


def score_title(title):
    lower = title.lower()
    return sum(5 if len(kw) <= 5 else 4 for kw in PRIORITY_KEYWORDS if kw in lower)


def build_script(headlines):
    parts = ["Noticiero Comerza."]
    for h in headlines:
        h = h.strip().rstrip(".!?,")
        parts.append(f"{h}.")
    parts.append("Estas fueron las noticias. Gracias por sintonizarnos.")
    return " ".join(parts)


# ── Main ───────────────────────────────────────────────────────────


def generate():
    all_items = []

    # Cooperativa
    try:
        xml_data = fetch_cooperativa()
        items = parse_cooperativa(xml_data)
        today = [it for it in items if is_today_chile(it["pubdate"])]
        if not today:
            today = items[:10]
        for it in today:
            it["score"] = score_title(it["title"])
        today.sort(key=lambda x: (-x["score"], x["pubdate"]))
        all_items.extend(today[:5])
        print(
            f"[noticiero] Cooperativa: {len(today)} hoy, tomados {min(5, len(today))}",
            file=__import__("sys").stderr,
        )
    except Exception as e:
        print(f"[noticiero] Cooperativa error: {e}", file=__import__("sys").stderr)

    # Ex-Ante
    try:
        html = fetch_exante()
        items = parse_exante(html)
        for it in items:
            it["score"] = score_title(it["title"])
        items.sort(key=lambda x: -x["score"])
        all_items.extend(items[:4])
        print(
            f"[noticiero] Ex-Ante: {len(items)} encontrados",
            file=__import__("sys").stderr,
        )
    except Exception as e:
        print(f"[noticiero] Ex-Ante error: {e}", file=__import__("sys").stderr)

    # Merge & deduplicate
    seen = set()
    final = []
    for it in all_items:
        key = it["title"].lower()[:60]
        if key in seen:
            continue
        seen.add(key)
        final.append(it)

    # Prioritize by score, limit to 5
    final.sort(key=lambda x: -x.get("score", 0))
    final = final[:5]

    if not final:
        print("[noticiero] No headlines from any source", file=__import__("sys").stderr)
        return False

    headlines = [it["title"] for it in final]
    text = build_script(headlines)

    chile_now = datetime.now(timezone.utc) + CHILE_OFFSET
    output = {
        "text": text,
        "generated_at": chile_now.strftime("%Y-%m-%dT%H:%M:%S-04:00"),
        "headlines": headlines,
        "sources": list(dict.fromkeys(it["source"] for it in final)),
    }

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(
        f"[noticiero] OK — {len(headlines)} titulares de {'+'.join(output['sources'])} → {OUTPUT_PATH}",
        file=__import__("sys").stderr,
    )
    return True


if __name__ == "__main__":
    generate()
