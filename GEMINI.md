# Radios App

Aplicación de streaming de radios online con estética de sketch/manual.

## Infraestructura
- **Puerto Local:** 8000
- **Servicio:** `radios-app.service` (usuario)
- **Ruta Nginx:** `/radios/`
- **Tecnología:** Python `http.server` sirviendo archivos estáticos (HTML/JS/CSS).

## Comandos Útiles
- **Reiniciar Servicio:** `systemctl --user restart radios-app.service`
- **Ver Logs:** `journalctl --user -u radios-app.service -f`
- **Actualizar Deep Search (Spider):** `./venv/bin/python scripts/spider.py`

## Deep Search (Scrapling)
La aplicación utiliza un sistema de búsqueda profunda que complementa los resultados de Radio Browser API con una base de datos local (`radios_db.json`).
- **Scripts:** `scripts/spider.py` raspa directorios externos (ej: internet-radio.com).
- **Entorno:** Requiere el entorno virtual `./venv/` con `scrapling` instalado.
- **Automatización:** Se recomienda ejecutar el spider semanalmente para refrescar los enlaces.

## Seguridad y Admin

- **Allowlist estática:** solo se sirven archivos públicos y `vendor/`. Archivos como `server.py`, `.git`, bases SQLite y scripts quedan bloqueados.
- **Admin por Tailscale:** las rutas admin y mutaciones de curadas siguen restringidas a la red Tailscale.
- **Basic Auth opcional:** definir `ADMIN_USER` y `ADMIN_PASSWORD` para proteger `/admin` y las mutaciones.
- **Token de admin opcional:** definir `ADMIN_TOKEN`. La página `/admin` muestra un login propio y las peticiones usan el header `X-Admin-Token`.
- **Rate limiting:** persistente en SQLite por IP para TTS, websearch, noticias, letras, proxy y metadata.
- **Smoke tests:** `python3 scripts/security_smoke.py`.
- **CI:** `.github/workflows/ci.yml`.

## Arquitectura Backend

- `server.py`: entrypoint HTTP, routing, auth y helpers.
- `radios_app/config.py`: configuración central.
- `radios_app/storage.py`: SQLite y migraciones.
- `radios_app/security.py`: SSRF, auth, IP y rate limiting persistente.
- `radios_app/handlers/`: mixins por dominio:
  - `admin.py`
  - `static.py`
  - `search.py`
  - `media_info.py`
  - `streams.py`
  - `tts_news.py`
  - `playlist_feedback.py`
