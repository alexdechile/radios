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
