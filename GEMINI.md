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
