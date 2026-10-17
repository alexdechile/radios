# Reglas de Agentes — Radios App

Guía técnica compacta para agentes de IA (OpenCode, Antigravity, DSH) que trabajen en este repositorio.

## Reglas del Proyecto

1. **Documentación Maestra (`alex.md`):** Mantener siempre la sección `## Último Realizado` al inicio. Escribir en lenguaje simple para un lego (no técnico), una línea por hito y con fecha (`DD-MM-YYYY: descripción simple`). No volcar detalles internos de código ni commits en `alex.md`.
2. **Confirmación Obligatoria:** No hacer commits a Git sin confirmación explícita del usuario ("funciona", "quedó bien", "perfecto").
3. **Cloud First:** No compilar ni correr tareas pesadas en local; usar GitHub Actions (`.github/workflows/ci.yml`). Pruebas rápidas locales solo si toman < 30s (`python3 scripts/security_smoke.py`).
4. **Aviso por voz:** Al terminar tareas largas, avisar por TTS con `bash ~/skills/voz-local/scripts/hablar.sh "Don Alex, terminé. <resultado>"`.

## Infraestructura y Homelab

- **Puerto:** `8000` (local).
- **Servicio Systemd:** `systemctl --user restart radios-app.service`
- **Logs:** `journalctl --user -u radios-app.service -f`
- **Nginx Subpath:** `/radios/` redirige a `http://localhost:8000/`. Los enlaces y endpoints deben tolerar tanto la raíz como el subpath `/radios/` (usar `getApiUrl()` en frontend).
- **Acceso:** Tailscale en `https://donalex.van-solfeggio.ts.net/radios/` y Funnel público en puerto 10000.

## Arquitectura y Código

- **Backend Python:**
  - Entrypoint: `server.py` (routing HTTP, auth, helpers).
  - Módulos en `radios_app/`: `config.py`, `storage.py`, `security.py`.
  - Handlers en `radios_app/handlers/`: `admin.py`, `media_info.py`, `playlist_feedback.py`, `search.py`, `static.py`, `streams.py`, `tts_news.py`.
- **Bases de Datos (SQLite):**
  - `radios_curated.db`: catálogo curado (`curated_radios`) y votos (`feedback`). Versionada en git.
  - `radios_cache.db`: cachés de runtime (`song_cache`, `lyrics_cache`). Ignorada por git.
  - `radios_rate_limit.db`: tracking de rate limit por IP. Ignorada por git.
- **Frontend:**
  - `index.html`, `app.js`, `style.css`: aplicación principal (classic + mini mode in-page).
  - `admin.html`, `admin.js`: panel de gestión curatorial.
  - `sw.js`: Service Worker con versionado cache-busting centralizado.
- **Seguridad:**
  - Allowlist estática en `static.py`: solo archivos públicos y `vendor/`.
  - Admin (`/admin`): restringido por IP a red Tailscale y localhost. Soporta `X-Admin-Token` o Basic Auth.
  - Rate limiting persistente por IP en endpoints de búsqueda, letras, TTS y proxy.
  - Verificación de seguridad: `python3 scripts/security_smoke.py`.
