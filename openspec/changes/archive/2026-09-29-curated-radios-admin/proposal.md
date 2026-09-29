## Why

Currently, the default curated radios loaded by all clients are stored in SQLite (`radios_curated.db`), but there is no dedicated administrative UI to manage, audit, reorder, or annotate them. Administrators need a secure, dedicated dashboard accessible strictly via Tailscale to manage the curated station catalogue, search the broader radio directory, adjust station properties, and attach editorial notes and highlights.

## What Changes

- **Restricted Access via Tailscale**: The administration page (`/admin` or `/admin.html`) and sensitive administrative mutation endpoints are restricted exclusively to requests originating from the Tailscale network (Carrier Grade NAT IPv4 `100.64.0.0/10`, Tailscale IPv6 `fd7a:115c:a1e0::/48`, or local loopback), denying public access via Tailscale Funnel or external proxies.
- **New Curated Radios Admin Page**: A dedicated web interface adopting the app's sketch/retro aesthetic, providing:
  - An integrated search bar to search existing curated stations as well as query external radios via Radio Browser API / Deep Search to import new stations into the curated list.
  - A responsive station grid displaying stations with their essential attributes (Favicon/Logo, Name, Country, Stream URL, Codec, Bitrate, Tags, Position).
  - Editorial field management (`editorial_notes`, `is_featured` toggle) allowing administrators to document why a station was curated or provide commentary.
  - Unique voice alias (`voice_name`) per station, used by clients for `?radio=<alias>` deep links and voice commands ("reproduce infinita").
  - Quick actions: In-line station playback test, reordering (position adjustment), editing station metadata, and deleting/removing stations from the curated catalogue.
- **Data Model & Backend Updates**:
  - Extend `curated_radios` schema with `editorial_notes TEXT DEFAULT ''`, `is_featured INTEGER DEFAULT 0` and `voice_name TEXT DEFAULT ''`.
  - Introduce server-side verification helper in `RadiosHandler` to strictly reject non-Tailscale requests attempting to access the admin page and mutation endpoints.
  - Enforce case/accent-insensitive alias uniqueness on write, and update only the fields provided on re-save (never `INSERT OR REPLACE`, which silently cleared omitted columns).

## Capabilities

### New Capabilities
- `curated-admin`: Web-based administration panel and API to browse, search, edit, reorder, and annotate the application's default curated radios, protected by Tailscale-only network verification.

### Modified Capabilities

## Impact

- **Backend (`server.py`)**:
  - Schema migration in `init_db()` adding `editorial_notes`, `is_featured` and `voice_name` columns to `curated_radios`.
  - Tailscale network IP validation check (`is_tailscale_request`) applied to `/admin`, `/admin.html`, and administrative endpoints.
  - New/updated endpoints for updating curated stations with editorial fields (`POST /api/curated/update`, `POST /api/curated/reorder`), plus normalized alias-uniqueness validation on add/update.
- **Frontend**:
  - New `admin.html` and `admin.js` with live search, station grid, editor modal with the editorial and voice-alias fields, and direct stream preview player.
- **Security & Network**:
  - Tailnet-only enforcement: Requests via Funnel (public port 10000) or external untrusted IPs attempting to hit the admin section receive HTTP 403 Forbidden.
