#!/usr/bin/env python3
"""Noticiero Comerza — genera noticiero.json desde RSS de Cooperativa.cl"""

import json
import os
import re
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT_PATH = os.path.join(BASE_DIR, "noticiero.json")

RSS_FEED = "https://www.cooperativa.cl/noticias/site/tax/port/all/rss_3___1.xml"
USER_AGENT = "NoticieroComerza/1.0"

CHILE_OFFSET = timedelta(hours=-4)  # UTC-4 (sin horario de verano por ahora)

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
    "atentado",
    "asalto",
    "robo",
    "homicidio",
    "falleció",
]


def fetch_rss():
    req = urllib.request.Request(RSS_FEED, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read()


def is_today_chile(pub_date_str):
    """Verifica si la fecha del artículo es de hoy en Chile (UTC-4)."""
    try:
        dt = datetime.strptime(pub_date_str.strip(), "%a, %d %b %Y %H:%M:%S %z")
    except (ValueError, AttributeError):
        return False
    chile_now = datetime.now(timezone.utc) + CHILE_OFFSET
    return dt.astimezone(timezone.utc).date() == chile_now.date()


def score_title(title):
    lower = title.lower()
    score = 0
    for kw in PRIORITY_KEYWORDS:
        if kw in lower:
            score += 5 if len(kw) <= 5 else 4
    return score


def clean_title(title):
    title = re.sub(r"\s+", " ", title).strip()
    title = title.rstrip(".!?")
    return title


def parse_rss(xml_data):
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
        items.append({"title": title, "pubdate": pubdate})
    return items


def build_script(headlines):
    parts = ["Noticiero Comerza."]
    parts.extend(headlines)
    parts.append("Estas fueron las noticias. Gracias por sintonizarnos.")
    return " ".join(parts)


def generate():
    try:
        xml_data = fetch_rss()
    except Exception as e:
        print(f"[noticiero] Error fetching RSS: {e}", file=__import__("sys").stderr)
        return False

    items = parse_rss(xml_data)
    if not items:
        print("[noticiero] No items found in RSS", file=__import__("sys").stderr)
        return False

    today_items = [it for it in items if is_today_chile(it["pubdate"])]
    if not today_items:
        print("[noticiero] No items from today (Chile)", file=__import__("sys").stderr)
        today_items = items[:10]

    for it in today_items:
        it["score"] = score_title(it["title"])

    max_score = max(it["score"] for it in today_items) if today_items else 0
    if max_score > 0:
        today_items.sort(key=lambda x: -x["score"])
    else:
        today_items.sort(key=lambda x: x["title"])

    top = today_items[:5]

    headlines = [it["title"] for it in top]

    text = build_script(headlines)

    chile_now = datetime.now(timezone.utc) + CHILE_OFFSET
    output = {
        "text": text,
        "generated_at": chile_now.strftime("%Y-%m-%dT%H:%M:%S-04:00"),
        "headlines": headlines,
    }

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(
        f"[noticiero] OK — {len(headlines)} titulares → {OUTPUT_PATH}",
        file=__import__("sys").stderr,
    )
    return True


if __name__ == "__main__":
    generate()
