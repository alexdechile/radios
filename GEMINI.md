# Radios App — Reglas de Agentes

Guía técnica compacta para agentes de IA que trabajen en este repositorio.

## Reglas del Proyecto

1. **Documentación Maestra (`alex.md`):** Mantener siempre la sección `## Último Realizado` al inicio. Escribir en lenguaje simple para un lego (no técnico), una línea por hito y con fecha (`DD-MM-YYYY: descripción simple`). No volcar detalles internos de código ni commits en `alex.md`.
2. **Confirmación Obligatoria:** No hacer commits a Git sin confirmación explícita del usuario ("funciona", "quedó bien", "perfecto").
3. **Cloud First:** No compilar ni correr tareas pesadas en local; usar GitHub Actions (`.github/workflows/ci.yml`). Pruebas rápidas locales solo si toman < 30s (`python3 scripts/security_smoke.py`).
4. **Aviso por voz:** Al terminar tareas largas, avisar por TTS con `bash ~/skills/voz-local/scripts/hablar.sh "Don Alex, terminé. <resultado>"`.

## Infraestructura y Homelab

- **Puerto Local:** `8000`.
- **Servicio Systemd:** `systemctl --user restart radios-app.service`
- **Logs:** `journalctl --user -u radios-app.service -f`
- **Nginx Subpath:** `/radios/` redirige a `http://localhost:8000/`. Los endpoints deben tolerar raíz o subpath `/radios/` (`getApiUrl()` en frontend).
- **Acceso:** Tailscale en `https://donalex.van-solfeggio.ts.net/radios/` y Funnel público en puerto 10000.

## Arquitectura Backend y Datos

- **Servidor:** Python `http.server` modular en `server.py` y `radios_app/handlers/`:
  - `admin.py`, `media_info.py`, `playlist_feedback.py`, `search.py`, `static.py`, `streams.py`, `tts_news.py`.
- **Bases de Datos SQLite:**
  - `radios_curated.db`: catálogo curado (`curated_radios`) y votos (`feedback`). Versionada en git.
  - `radios_cache.db`: cachés de runtime (`song_cache`, `lyrics_cache`). Ignorada por git.
  - `radios_rate_limit.db`: tracking de rate limit por IP. Ignorada por git.
- **Deep Search:** `scripts/spider.py` en `./venv/` con `scrapling`.

## Seguridad y Admin

- **Allowlist estática:** Solo se sirven archivos públicos y `vendor/`.
- **Admin por Tailscale:** `/admin` restringido a red Tailscale y localhost. Soporta `X-Admin-Token` o Basic Auth.
- **Rate limiting:** Persistente en SQLite por IP para TTS, websearch, noticias, letras, proxy y metadata.
- **Smoke tests:** `python3 scripts/security_smoke.py`.
