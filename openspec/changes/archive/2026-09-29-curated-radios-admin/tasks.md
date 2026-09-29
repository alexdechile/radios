## 1. Database & Backend Preparation

- [x] 1.1 Extend `init_db()` in `server.py` to add `editorial_notes` and `is_featured` columns to `curated_radios`.
- [x] 1.2 Implement `is_tailscale_request(self)` helper in `server.py` to identify Tailnet IPs (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`, `127.0.0.1`, `::1`) and reject Funnel/unauthorized access.
- [x] 1.3 Add route guards for `/admin`, `/admin.html`, and administrative API mutations (`POST /api/curated`, `POST /api/curated/update`, `DELETE /api/curated`).
- [x] 1.4 Update `handle_get_curated`, `handle_add_curated`, and implement `handle_update_curated` to support `editorial_notes` and `is_featured`.
- [x] 1.5 Add `voice_name TEXT DEFAULT ''` to `curated_radios` via the `init_db()` migration.
- [x] 1.6 Implement `normalize_voice_name()` / `voice_name_exists()` and enforce alias uniqueness (HTTP 409) on add and update.
- [x] 1.7 Replace `INSERT OR REPLACE` in `handle_add_curated` with a partial update of only the provided fields (exclude the row's own UUID from the alias check).

## 2. Admin Web Interface

- [x] 2.1 Create `admin.html` with sketch/retro styling consistent with `style.css` (header, search bar, station discovery tabs, curated grid, audio preview bar).
- [x] 2.2 Create `admin.js` with state management for curated stations, local filter, and audio preview player.
- [x] 2.3 Implement the curated radios grid rendering station cards with logo, name, country, tags, position badge, and editorial commentary preview.
- [x] 2.4 Implement Station Discovery / Deep Search panel within admin to search Radio Browser API and add new stations directly to curated list.
- [x] 2.5 Build the Edit/Create Station Modal featuring the "Nota Editorial" textarea and "Destacada" toggle.
- [x] 2.6 Add the "Alias para voz / deeplink" field to the editor modal, show the alias on station cards, and include it in the local filter.

## 3. Verification & Documentation

- [x] 3.1 Test Tailscale authorization: verify access is allowed via Tailscale IP/loopback and blocked with HTTP 403 when simulated from non-Tailscale IPs.
- [x] 3.2 Test station editing and editorial notes persistence in `radios_curated.db`.
- [x] 3.3 Test audio stream preview playback in the admin grid.
- [x] 3.4 Update `alex.md` and project documentation with the new admin endpoint and operational instructions.
- [x] 3.5 Test alias uniqueness: verify HTTP 409 on a duplicate normalized alias and that re-saving a station keeps its stored alias.
