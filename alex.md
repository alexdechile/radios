# Radios App - DonAlex Homelab

## Último Realizado
- [x] **Paridad de Funcionalidades entre Versión Clásica y Versión Mini**:
  - **Temporizador de Apagado y Despertador (Mini)**: Implementado el panel modal y lógica de temporizador (Sleep Timer con presets/personalizado) y despertador (alarma programable) en la versión Mini (`mini.html`, `mini.js`, `mini.css`), con sincronización de la emisora elegida y visualización de badges de cuenta regresiva/reloj apilados verticalmente de forma compacta.
  - **Ecualizador de 5 bandas (Mini)**: Añadido el panel de ecualización de 5 bandas (60Hz, 250Hz, 1kHz, 4kHz, 16kHz) con presets (FLAT/BASS/VOZ/AGUDOS) y conexión real al Web Audio API en la versión Mini, optimizando el control táctil con sliders horizontales compactos integrados en la pestaña de Efectos.
  - **Autoplay y Navegación Coherentes (Clásica y Mini)**:
    - Soportada la navegación (Prev/Next) y autoreproducción/salto automático por error en los resultados de búsqueda activos en la versión Clásica (alineada con la lógica de cola `activeQueue` de la versión Mini).
    - Añadida autodetección y autoreproducción de streams mediante enlaces directos (Deep Linking con query params `?play=url&name=name`) en la versión Mini para emparejar la funcionalidad de compartición de la versión Clásica.
- [x] **Descubrimiento Dinámico de Servidores de API**:
  - Implementado un mecanismo de resolución dinámica de servidores activos consultando `all.api.radio-browser.info/json/servers` en `pickServer()` para `app.js` y `mini.js`.
  - Esto previene errores de resolución DNS (`net::ERR_NAME_NOT_RESOLVED`) y limpia la consola del navegador al evitar peticiones de sondeo a servidores dados de baja o fuera de servicio temporalmente (como `at1`, `de2` o `nl1`).
- [x] **Corrección de Service Worker (`sw.js`)**:
  - Restringido el interceptor de peticiones `fetch` del Service Worker solo a URLs del mismo origen (`same-origin`), evitando interferir con APIs y flujos de audio externos (como `radio-browser.info`).
  - Implementado un fallback graceful (`new Response` con estado 503) cuando una petición local falla y no se encuentra en el caché, eliminando el error `Uncaught (in promise) TypeError: Failed to convert value to 'Response'` en la consola del navegador.
- [x] **Corrección de deprecación de sliders y rutas de API (Nginx subpath)**:
  - Reemplazado `slider-vertical` por `none` en `appearance` de `style.css` (usando el estándar `writing-mode: vertical-lr; direction: rtl;`) para eliminar advertencias de Chrome.
  - Creada función `getApiUrl` en `app.js` y `mini.js` para resolver dinámicamente las llamadas API (`/api/curated`, `/api/nowplaying`, `/api/websearch`) agregando el prefijo `/radios` si se accede bajo esa ruta proxy, eliminando los errores 404.
- [x] **Versión Móvil Compacta (Radios Mini)** — Implementación de una interfaz fluida, ultra responsiva y ligera en `mini.html` optimizada para el iPhone 6 (pantallas pequeñas y Safari Móvil). Incluye autodetección y redirección desde la versión clásica, buscador integrado con filtros, sincronización de la playlist/favoritos vía `localStorage` y reproductor nativo HTML5 en segundo plano (sticky footer) con control táctil optimizado y navegación (Prev/Next) entre la lista activa. Se puede alternar libremente con el botón de Versión Clásica/Versión Móvil en las cabeceras.
- [x] Implementación de temporizador de apagado automático (Sleep Timer) con presets de 15, 30, 45, 60 minutos y personalizado.
- [x] Implementación de despertador / alarma programable con selección de estación de radio de la playlist.
- [x] Integración de badges de estado y botón de reloj cerca del contador de tiempo.
- [x] Restauración y reparación del servicio `radios-app.service` del Homelab.
- [x] **Mini EQ de 5 bandas estilo radio de auto** — Panel con sliders verticales (60Hz, 250Hz, 1kHz, 4kHz, 16kHz), 4 presets (FLAT/BASS/VOZ/AGUDOS), nodos `BiquadFilter` reales conectados en la cadena WebAudio, y persistencia en `localStorage`. Activable con el botón `⧸⧸⧸` en el header.

## ¿Qué hace esta App?
Es el reproductor oficial de radios online para el Homelab DonAlex, accesible desde el portal centralizado en `donalex.van-solfeggio.ts.net/radios/`. 
Ofrece una interfaz retro con estética nostálgica basada en **Winamp**, incluyendo:
- Un visualizador/analizador de espectro interactivo (ecualizador en canvas).
- Buscador integrado y un sistema de búsqueda profunda ("Deep Search") que utiliza Scrapling en segundo plano (`scripts/spider.py`) para raspar emisoras adicionales y guardarlas en una base de datos local (`radios_db.json`).
- Filtros rápidos por codec (MP3/AAC) y bitrate.
- Capacidad de exportar/importar listas de reproducción personalizadas en JSON.

## Stack Técnico
- **Frontend**: Doble cliente web de alto rendimiento:
  - *Versión Clásica*: HTML5, CSS3 clásico estilo skin de Winamp y Vanilla JavaScript.
  - *Versión Mini (Móvil)*: HTML5/CSS3 fluido y responsivo en `mini.html`, con diseño optimizado para celulares de baja resolución/pantalla pequeña e interfaces de tacto rápido.
- **Audio**: Elementos HTML5 Audio nativos.
  - *Versión Clásica*: Reproductor Plyr integrado para soporte extendido HLS/MP3/AAC.
  - *Versión Mini*: Reproductor de audio HTML5 nativo de bajo consumo para maximizar compatibilidad en navegadores antiguos (iOS 12).
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
