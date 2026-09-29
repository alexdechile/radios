## Context

The Radios App serves a curated selection of stations stored in `radios_curated.db` (`curated_radios` table). This list is loaded by default on fresh browser sessions across all user devices. Currently, stations are added directly through the main player UI into SQLite or via command-line scripts, with no visual administrative dashboard to audit station health, edit stream URLs, reorganize playback order, or document editorial notes explaining why a station was included.

Furthermore, the server runs on port 8000 and is accessible:
1. Locally via loopback (`127.0.0.1:8000`).
2. Privately via Tailscale Tailnet (`100.116.195.127:8000` and `donalex.van-solfeggio.ts.net/radios/` via Nginx).
3. Publicly via Tailscale Funnel on port 10000 (`https://donalex.van-solfeggio.ts.net:10000/`).

To preserve privacy and prevent unauthorized mutations, administrative features must be strictly restricted to Tailscale tailnet access and rejected if accessed via public Funnel or external IPs.

## Goals / Non-Goals

**Goals:**
- Provide a dedicated, responsive admin page (`/admin` / `admin.html`) adopting the app's sketch/minimalist aesthetic.
- Restrict access to `/admin` and write API endpoints (`POST /api/curated`, `POST /api/curated/update`, `DELETE /api/curated`) strictly to Tailscale/loopback IP ranges.
- Provide a full CRUD grid of curated radios with search/filter, playback audio testing, reordering, and metadata editing.
- Introduce an "Editorial" field (`editorial_notes`) and "Featured" flag (`is_featured`) for each curated station to provide context and curation comments.
- Integrate search for discovering new stations from Radio Browser API / Deep Search directly within the admin page to easily add them to the curated database.

**Non-Goals:**
- Multi-user authentication/passwords (Tailscale network-level authentication serves as the single source of truth for administrative access).
- Modifying the public playback client's layout, except for displaying editorial notes or featured badges if applicable.

## Decisions

### 1. Network-Level Security via Tailscale IP Verification
- **Decision**: Validate client IP inside `RadiosHandler` in `server.py`. Tailscale uses `100.64.0.0/10` (CGNAT range `100.64.0.0` - `100.127.255.255`) and Tailscale IPv6 ULA `fd7a:115c:a1e0::/48`. Also allow local loopback (`127.0.0.1`, `::1`). When requests arrive via Nginx reverse proxy, inspect `X-Real-IP` and `X-Forwarded-For` (trusted if upstream is localhost). Check also headers like `Tailscale-Funnel-Request` or host ports to block public funnel requests.
- **Alternatives considered**:
  - *HTTP Basic Auth / Session token*: Requires managing credentials and logins; Tailscale provides zero-trust identity and encryption natively for the homelab.
  - *Separate port*: Requires configuring another service or firewall rule; path-based routing (`/admin`) on the existing server is simpler and cleaner.

### 2. Database Schema Extension
- **Decision**: Add `editorial_notes TEXT DEFAULT ''`, `is_featured INTEGER DEFAULT 0` and `voice_name TEXT DEFAULT ''` to `curated_radios` in `radios_curated.db`. Execute safe schema migration in `init_db()` via `ALTER TABLE ... ADD COLUMN` if they do not exist.
- **Alternatives considered**:
  - *Separate table `curated_editorial`*: Overcomplicates simple 1-to-1 curation notes. Keeping them in `curated_radios` ensures queries and backups remain simple.

### 2b. Voice Alias Uniqueness and Safe Re-save
- **Decision**: Normalize `voice_name` (lowercase, strip accents and punctuation) in the backend and compare against every other row before writing; reject duplicates with HTTP 409. Re-saves go through a partial `UPDATE` limited to the fields present in the request body instead of `INSERT OR REPLACE`, and the row's own UUID is excluded from the duplicate scan.
- **Rationale**: The alias is the client's stable key for `?radio=<alias>` and voice commands, so collisions must be rejected. `INSERT OR REPLACE` deletes and re-inserts the row, which silently cleared omitted columns (alias, editorial notes) and reset `created_at`, perturbing the ordering query.
- **Alternatives considered**:
  - *UNIQUE index on the raw column*: Does not catch case/accent variants and cannot be created while many rows legitimately share the `''` default.

### 3. Frontend Architecture (`admin.html` & `admin.js`)
- **Decision**: A lightweight standalone page (`admin.html` with vanilla JS and CSS following `style.css` variables). It does not need to load the heavy multitrack/Winamp player engine, keeping load times fast. An embedded HTML5 `<audio>` element handles live stream testing. The editor modal exposes the "Alias para voz / deeplink" field next to the station name.
- **Alternatives considered**:
  - *Embedding admin panel inside modal of index.html*: Clutters the listener-facing application bundle with admin code and exposes admin UI elements to public users.

## Risks / Trade-offs

- [Reverse proxy IP spoofing] → When behind Nginx, evaluate `X-Real-IP` or `X-Forwarded-For` only when the direct client socket is `127.0.0.1`.
- [Tailscale Funnel proxying] → Funnel sets specific forward headers or uses port 10000; requests through Funnel will resolve with public IPs, which naturally fail the `100.64.0.0/10` check.
- [Database locked during concurrent writes] → SQLite is in WAL mode or simple single-threaded commit; admin writes are sporadic, so lock contention is practically zero.
