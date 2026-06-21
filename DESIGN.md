# Diseño — Radios App

> *Clean, creamy, pastel. Moderno y suave.*

## Stack

| Recurso | Versión | Fuente |
|---------|---------|--------|
| **Inter** | Google Fonts | `fonts.googleapis.com` |
| **Font Awesome** | v6.5+ | `cdnjs.cloudflare.com` |
| **Plyr** | v3.7.8 | `cdn.plyr.io` |
| **Radio Browser API** | gratuita | `api.radio-browser.info` |

## Paleta Pastel

| Color | Hex | Uso |
|-------|-----|-----|
| Fondo página | `#FFF8F0` | Lienzo general |
| Tarjetas | `#FFFFFF` | Cards, contenedores |
| Fondo suave | `#FFFDF5` | Secciones secundarias |
| Lavanda | `#C9B6D9` | Header, equalizer, active states |
| Lavanda claro | `#E8DFF0` | Hover, backgrounds |
| Rosa | `#F6C8C8` | Remove buttons, accents |
| Rosa claro | `#FDE8E8` | Hover remove |
| Sage | `#A8D5BA` | Play, playing state |
| Sage claro | `#D8EDE0` | Play hover |
| Cielo | `#A8C5D6` | Secondary elements |
| Cielo claro | `#D8E8F0` | Deep search button |
| Durazno | `#F7DCB1` | Bitrate badges |
| Mint | `#B8E0D2` | Web results |
| Texto | `#4A4A4A` | Primary text |
| Texto secundario | `#8A8A8A` | Secondary text |
| Borde | `#E8E0D8` | Borders, separators |

## Layout

```
┌─────────────────────────┐
│ 🌐 Radios          🔄   │  ← Header gradiente lavanda-cielo
├─────────────────────────┤
│ [📊 Ecualizador] 12:34  │  ← Display reproducción
│ 5 radios  44 kHz        │
│ Now Playing: Station... │
│ [🔍 Buscar...  ▼ ▼ 🌐]  │  ← Search + filtros
├─────────────────────────┤
│ ◀◀ ▶️ ⏸ ⏹ ▶▶          │  ← Transporte
│ [RESULTADOS] [PLAYLIST] │  ← Tabs
├─────────────────────────┤
│ Resultados / Playlist   │  ← Scroll
│ (station cards pastel)  │
│                         │
├─────────────────────────┤
│ [SAVE] [LOAD]       //  │  ← Footer
└─────────────────────────┘
```

## Filosofía

Fondo crema, tarjetas blancas, bordes suaves y sombras difusas.
Colores pastel que conviven sin gritar. Gradientes sutiles en header.
Everything responsive, nada_forzado.
