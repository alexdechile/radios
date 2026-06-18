# Radios App - DonAlex Homelab

## Último Realizado
- [x] Restauración y reparación del servicio `radios-app.service` del Homelab, apuntando al directorio `/home/alexdechile/proyectos/radios` con el entorno de Python y su servidor `server.py`.
- [x] Solución al conflicto de puertos con `radios-auto` (que se movió al puerto local 8005 y se desvinculó de systemd del Homelab).
- [x] Creación de este archivo de documentación maestra (`alex.md`).

## ¿Qué hace esta App?
Es el reproductor oficial de radios online para el Homelab DonAlex, accesible desde el portal centralizado en `donalex.van-solfeggio.ts.net/radios/`. 
Ofrece una interfaz retro con estética nostálgica basada en **Winamp**, incluyendo:
- Un visualizador/analizador de espectro interactivo (ecualizador en canvas).
- Buscador integrado y un sistema de búsqueda profunda ("Deep Search") que utiliza Scrapling en segundo plano (`scripts/spider.py`) para raspar emisoras adicionales y guardarlas en una base de datos local (`radios_db.json`).
- Filtros rápidos por codec (MP3/AAC) y bitrate.
- Capacidad de exportar/importar listas de reproducción personalizadas en JSON.

## Stack Técnico
- **Frontend**: HTML5, CSS3 clásico estilo skin de Winamp, Vanilla JavaScript.
- **Audio**: Elementos HTML5 Audio nativos con reproductor multimedia Plyr integrado para compatibilidad de streams HLS/MP3/AAC.
- **Backend/Servidor**: Python `http.server` personalizado en `server.py` escuchando en el puerto 8000.
- **Scraper / Deep Search**: Python `scrapling` para la obtención inteligente de streams de audio desde DuckDuckGo en `/api/websearch` y mediante `scripts/spider.py` en un entorno virtual (`./venv`).
- **Integración Homelab**:
  - Servido a través de Nginx (`/etc/nginx/nginx.conf`) redirigiendo `/radios/` hacia `http://localhost:8000`.
  - Habilitado como servicio systemd de usuario: `radios-app.service`.
  - Certificación SSL y acceso seguro vía Tailscale (`donalex.van-solfeggio.ts.net`).

## Plan de Trabajo
1. [x] Implementar la interfaz skeuomorphic clásica de Winamp.
2. [x] Configurar reproductor local con Plyr para soporte multiprotocolo.
3. [x] Crear e integrar el servidor backend en Python con soporte de API para búsqueda profunda.
4. [x] Configurar el script de rastreo (`scripts/spider.py`) con Scrapling y almacenamiento en `radios_db.json`.
5. [x] Integrar y automatizar el servicio `radios-app.service` en systemd.
6. [x] Configurar ruteo en Nginx bajo la ruta `/radios/` hacia el puerto 8000.
