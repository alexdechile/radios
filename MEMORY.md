# Memoria del Proyecto Radios

- El proyecto fue integrado al portal el 13 de mayo de 2026.
- Se configuró el ruteo en Nginx para `/radios/` apuntando al puerto 8000.
- El servicio corre como un servidor HTTP simple de Python.

## Arquitectura (julio 2026)

- **No más redirección automática** a `mini.html`. Siempre abre en classic.
- **Mini Mode in-page** dentro de `index.html` (sección `.mini-mode` oculta). Al tocar "Versión Móvil" se togglea in-page — el gesture del usuario persiste.
- **Autoplay**: al entrar a mini mode → search input se auto-focus → primera interacción con teclado → `playRandomFav()`.
- **Botones en header**: classic→mini en `.app-header-actions`, mini→classic en `.mm-header` (no más botones flotantes).
- **Corrección de scroll/slide en Safari (iOS)**: Se cambió `flex-shrink: 0` a `flex-shrink: 1; min-width: 0;` en `.app-header-actions` y se eliminaron los listeners de touch en `initHorizontalDrag`, logrando scroll horizontal nativo fluido sin interferir con clics en los botones.
- **Búsqueda redirigida al carrusel principal**: Se ocultó `#searchPanelResults` en CSS para evitar duplicación y hacer el panel más compacto. Las búsquedas automáticas se gatillan al escribir el segundo carácter (`q.length >= 2`) y muestran resultados directamente en el carrusel principal (`#results`), restaurando automáticamente los favoritos si se vacía la consulta. Se corrigió un bug por el cual el panel se cerraba al escribir el 2do carácter debido a un evento de click programático en las pestañas (`e.isTrusted` agregado en listener).

## Archivos relevantes

- `index.html` — HTML único (classic + mini mode oculto)
- `app.js` — JS principal (incluye mini-mode: `enterMiniMode`, `mmRenderResults`, `mmSearch`, etc.)
- `style.css` — CSS principal (incluye `.mini-mode`, `.mm-card`, etc.)
- `mini.html` / `mini.js` / `mini.css` — Standalone (ya no se usa como target)
- `server.py` — Servidor Python
- `version_check.json` — Versión `1.3.1`
- `sw.js` — Service Worker
