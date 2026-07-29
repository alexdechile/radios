# Radios App - DonAlex Homelab

## Último Realizado
- [x] **Noticiero Comerza — Noticias Reales cada 30 min** (2026-07-28):
  - Script `scripts/noticiero.py` multfuente: Cooperativa.cl RSS (sección País, keyword-scored) + Ex-Ante.cl scrape (headlines `<h3>`). Genera `noticiero.json` con libreto "Noticiero Comerza. [titulares]... Gracias por sintonizarnos."
  - Servidor ejecuta noticiero.py en background a las :20 y :50 (10 min antes de cada emisión) vía thread daemon.
  - `GET /api/news` lee `noticiero.json` cacheado (25 min TTL), con fallback inline.
  - Scheduler frontend solo entre 08:30-18:00, triggers a :00 y :30 (segundo exacto).
  - Catalina añade cierre: "Sigamos escuchando a [Artista] con [Canción], en [Radio]." + frase positiva aleatoria (20 frases) al final.
  - Voz `es-CL-CatalinaNeural` via edge-tts, cacheada por hash.
- [x] **Optimización de PWA y Buffer de Audio** (2026-07-26):
  - Generación de iconos PNG (192x192 y 512x512) para el `manifest.json` mejorando la compatibilidad PWA (especialmente en iOS/Safari).
  - Configuración de `sizes: "any"` para el icono SVG en el manifest.
  - Inclusión de meta etiquetas (`theme-color` y `apple-touch-icon`) en el `index.html`.
  - Aumento del tamaño del chunk de proxy en `server.py` de 8KB a 64KB para proporcionar un buffer más generoso y mejorar la estabilidad ante pequeñas variaciones de conexión.
- [x] **Letras (Lyrics) en el Modal "Está Sonando"** (2026-07-25):
  - Nueva sección **"Letra"** colapsable dentro del popup de información de la canción, con carga *lazy* (solo consulta al expandir).
  - Nuevo endpoint backend `GET /api/lyrics` en `server.py` con dos fuentes: **lyrics.ovh** (API gratuita, principal) y **scraping de Genius** vía `scrapling` (fallback).
  - Cache en SQLite (tabla `lyrics_cache`): letras encontradas se guardan 30 días; las no encontradas se reintentan tras 1 día para evitar golpear las fuentes.
  - Limpieza de `feat.`/`ft.` en artista/título para mejorar la tasa de coincidencia.
  - Toggle **"Letra (Lyrics)"** en el Info Panel para mostrar/ocultar la sección (persistido en `localStorage`).
  - El auto-cierre de 30s del modal se cancela mientras se lee la letra; estilos acordes al tema oscuro/dorado con scroll suave para Safari móvil.
  - Nota legal: letras obtenidas bajo demanda de fuentes públicas y cacheadas localmente, sin redistribución masiva.
- [x] **Gestos Multi-táctiles y Zoom de UI Fluido (Pinch to Zoom)** (2026-07-25):
  - Implementado sistema de escalado/zoom dinámico de la interfaz entre **70% y 160%** mediante el gesto táctil de dos dedos (**Pinch to Zoom**).
  - Permite expandir o condensar la app para adaptarse perfectamente a diferentes tamaños de pantalla (desde displays pequeños/embebidos hasta tablets y monitores grandes).
  - Indicador flotante en pantalla (*Zoom Toast Overlay*) con diseño esmerilado que muestra en tiempo real el porcentaje de escala ajustado (`Escala UI: 115%`).
  - Doble toque de 2 dedos (*Double Tap*) restablece instantáneamente la escala al 100% por defecto.
  - Integrado control deslizante (*slider*) y botón de reseteo en el panel de **Info / Configuración** para control manual.
  - Persistencia automática de la preferencia en `localStorage` (`radios_ui_scale`) de forma independiente para cada dispositivo.
- [x] **Búsquedas por defecto con Dropdown editable** (2026-07-21):
  - Incorporado un desplegable editable (combobox dropdown) al campo de búsqueda en el panel de búsqueda (`#searchPanelInputWrap`).
  - Incluidas las 7 búsquedas por defecto solicitadas: `morning`, `easy`, `vintage`, `70`, `80`, `sleep`, `afternoon`.
  - Integrado selector visual con iconos FontAwesome (`fas fa-sun`, `fas fa-mug-hot`, `fas fa-record-vinyl`, `fas fa-compact-disc`, `fas fa-bolt`, `fas fa-moon`, `fas fa-cloud-sun`) y botón chevron con animación de rotación en `style.css`.
  - Soporte nativo adicional mediante HTML5 `<datalist id="searchPanelDefaults">` para autocompletado en navegadores y dispositivos móviles.
  - El usuario puede seleccionar cualquiera de las opciones por defecto o escribir cualquier término personalizado de manera libre.
  - Filtrado en tiempo real de las opciones del desplegable al escribir, cierre automático con `Escape` o al hacer clic fuera del campo.
  - Corregido el recorte (`overflow: hidden`) del contenedor `.search-panel` en `style.css` cambiándolo a `overflow: visible`, lo que permite que el desplegable flote libremente y de forma visible por encima del resto de la interfaz.
  - Simplificación del Player: eliminado el texto redundante de muestreo (`44 kHz`), ocultada la barra duplicada (`.now-playing-track`) y unificada la información en el minicard principal (`#htmxNowPlaying`).
  - Al hacer clic o tocar el minicard (`#htmxNowPlaying`), se gatilla directamente la apertura del modal detallado de "Está Sonando" (`fetchSongInfo`), manteniendo toda la interacción en una sola tarjeta compacta.
  - Minicard de 3 líneas: reestructurado el snippet (`server.py` e `index.html`) para mostrar Línea 1 (Radio), Línea 2 (Canción) y Línea 3 (Indicación/Subtítulo) de forma limpia.
  - Tamaño de kbps/radios (`.player-stats`): aumentado a `1.8rem` para igualar de manera exacta al reloj de tiempo (`.player-time`).
  - Botones de transporte (Play, Pausa, etc.): condensados en un 25% menos de altura vertical y ampliados un 10% en ancho (`min-width: 48px` / `58px`), corregidas las reglas dentro de las media queries `@media (min-width: 600px)` y `@media (max-height: 670px)` para asegurar que el cambio surta efecto en todas las resoluciones.
  - Bloqueo de Modal para títulos genéricos: creada la función `isGenericOrArtifactTitle` en `app.js` para evitar abrir el modal o consultar metadatos cuando la radio retorne textos por defecto como *"Icecast Streaming media server"*, *"Shoutcast"*, *"Unspecified"*, etc.
  - Filtrado de contenido *"Sponsored"*: eliminadas las radios de prueba patrocinadas de la lista inicial y aplicado un filtro en `renderResults` para omitir cualquier emisora cuyo nombre, tag o URL contenga la palabra *"sponsored"*.
  - Optimización de espacio vertical: eliminada la barra de pestañas fija (`.tab-bar` con RESULTADOS/PLAYLIST) ganando ~38px de alto en pantalla. En su lugar se integró el botón de Playlist (`<i class="fas fa-list-ul"></i>`) directo en la botonera de transporte separado por divisor vertical (`.transport-divider`). La búsqueda activa automáticamente la vista de resultados.
  - Reestructuración y priorización de metadatos de canciones (`MusicBrainz` + `Wikipedia`):
    - **Causa raíz descubierta**: Las consultas a MusicBrainz en `server.py` estaban fallando silenciosamente por un fallo en la codificación de la consulta Lucene (`urllib.parse.quote`), lo que causaba un fallback constante hacia Wikipedia.
    - **Prioridad absoluta**: MusicBrainz pasa a ser la fuente principal de datos estructurados. Se expandió la extracción para obtener el **Sello discográfico** (`label`), **Compositores/Autores** (`writer`), **Año**, **Álbum**, **Duración** y **Géneros**.
    - **Mezcla con Wikipedia**: Wikipedia ahora se consulta únicamente para complementar con la síntesis biográfica/histórica (`description`), enlace (`wiki_url`) o portada de respaldo, sin sobreescribir los datos fácticos de MusicBrainz.
    - Limpiada la tabla de caché `song_cache` en `radios_curated.db` para refrescar todas las canciones con los nuevos metadatos enriquecidos.
- [x] **Integración HTMX — Panel "Ahora Suena" con polling automático** (2026-07-21):
  - Nuevo endpoint `/api/nowplaying-fragment` en `server.py` que devuelve HTML fragmentado (en vez de JSON).
  - Panel `#htmxNowPlaying` en `index.html` con atributos `hx-get`, `hx-trigger="every 15s"` y `hx-swap="innerHTML"` — cero JS adicional para el polling.
  - Bridge `window.htmxNowPlayingUpdate()` en `index.html` llamado desde `app.js` al iniciar reproducción, actualiza el `hx-get` con la URL y nombre de la estación activa.
  - Tres estados visuales: **activo** (canción detectada, verde), **esperando** (sintonizando, ocre) e **idle** (sin radio, gris punteado).
  - Badge **LIVE** rojo pulsante, favicon de la radio, nota musical animada (♫), e indicador de carga punto verde.
  - HTMX cargado desde CDN (`unpkg.com/htmx.org@2.0.4`). Sin rotura de funcionalidad existente.
- [x] **Corrección de Popup "Está Sonando" y Metadatos**:
  - Corregido bug donde el popup "Está Sonando" y la sección de metadatos de canción actual desaparecían en streams locales, listas importadas y radios del Deep Search.
  - Se desacopló la consulta de metadatos ICY (`/api/nowplaying`) del flujo exclusivo de `radio-browser.info`, permitiendo que el tracker de metadatos se active para cualquier estación que tenga un stream URL.
  - Se movió la resolución de servidor de `radio-browser` (`pickServer()`) dentro de la función `fetchMeta`, evitando bloqueos y permitiendo actualizaciones en tiempo real del tema que suena en todos los tipos de emisoras.
- [x] **Popup "Está Sonando" con Wikipedia, MusicBrainz y Like/Dislike**:
  - Popup vertical con portada, track/artist, descripción, badges, extras (writer, producer, label, length), link Wikipedia y botones Like/Dislike con toggle persistente.
  - Backend expandido: parser de infobox con writer/producer/label/length/description/thumbnail/wiki_url, Wikipedia REST summary, MusicBrainz fallback (cover art, genres, ISRC, length).
  - Tabla `feedback` en SQLite con endpoint `POST /api/feedback` (toggle on/off del mismo voto).
  - Panel "Info del Popup" con 6 toggle switches (portada, descripción, badges, extras, wiki link, sección DJ), persistencia en localStorage.
  - Click en track now-playing abre popup, auto-cierre a los 30s.
- [x] **Playlist local con metadatos enriquecidos**:
  - Botón `+` en popup guarda la canción directo a `playlists/radio.json` con metadatos completos (title, artist, album, genre, year, duration, label, added_at).
  - Sin llamadas externas — Radios solo crea la playlist, DJ la resuelve después.
  - Endpoint `POST /api/playlist/save` con detección de duplicados.
  - Eliminados los endpoints proxy `/api/dj-search` y `/api/dj-add`.
- [x] **Fix loop de Service Worker**:
  - URL del SW cambiada de `sw.js?v=1.2.0` a `sw.js` (sin version param) para evitar ciclo infinito de refresco.
  - Mantenido `skipWaiting()` + `controllerchange` → reload (se estabiliza tras un ciclo).
- [x] **Redirección de Resultados de Búsqueda al Carrusel Principal**:
  - Ocultado el contenedor `#searchPanelResults` en `style.css` para que el panel de búsqueda sea más compacto y no duplique los resultados.
  - Modificada la interacción de búsqueda en `app.js` (`initSearchPanel`) para que la búsqueda se gatille automáticamente a partir del segundo carácter introducido (`q.length >= 2`).
  - Removido el llamado a `renderSearchPanelOverlay` y su definición en `app.js`, ya que los resultados ahora se presentan de forma exclusiva en el carrusel principal (`#results`).
  - Implementada lógica de restauración automática en el carrusel de resultados para cargar los favoritos/playlist por defecto cuando el campo de búsqueda se limpie o tenga menos de 2 caracteres.
  - Corregido bug donde el panel de búsqueda se cerraba automáticamente al escribir el segundo carácter. La búsqueda simulaba un clic en `#tabResults` para mostrar los resultados, lo cual gatillaba el detector de "clics fuera del panel". Ahora el listener de cierre por clic exterior ignora eventos programáticos mediante la verificación de confianza (`!e.isTrusted`).
- [x] **Corrección de header deslizable en Safari (iOS/macOS)**:
  - Cambiado `.app-header-actions` de `flex-shrink: 0` a `flex-shrink: 1` con `min-width: 0` en `style.css` para permitir que el contenedor se reduzca al tamaño de pantalla disponible y active su scroll horizontal.
  - Modificada la función `initHorizontalDrag` in `app.js` eliminando los listeners de touch (`touchstart`, `touchmove`, `touchend`) para delegar el scroll táctil al comportamiento nativo de Safari (momentum scrolling). Esto soluciona los tirones y hace que los botones del header respondan instantáneamente al tacto.
  - Añadido un interceptor de `click` en la fase de captura dentro de `initHorizontalDrag` para evitar clicks accidentales en botones o tarjetas al arrastrar horizontalmente con el mouse en pantallas de escritorio.
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
- **Noticiero por Voz**: 
  - Script `scripts/noticiero.py` que scrapea RSS de Cooperativa.cl y genera `noticiero.json`.
  - TTS con `edge-tts` (voz `es-CL-CatalinaNeural`) desde `/home/alexdechile/.openclaw/tmp/tts-venv/`.
  - Audio ducking via Web Audio API `GainNode` en la cadena de ecualización.
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
