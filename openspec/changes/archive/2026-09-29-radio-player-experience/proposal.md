## Why

The listener-facing player accumulated several independent features and fixes (voice commands, session restore and alias deep links, richer song details, release notes) that exist in code but nowhere in the project's spec baseline. Writing them down keeps `openspec/specs` authoritative and gives future changes a contract to build on.

## What Changes

- **Voice station control**: a dedicated microphone button in the header starts Web Speech recognition; Spanish commands play/pause/resume, skip tracks, adjust volume, report the current song and tune a station by its admin alias or name. The radio is muted while listening so the microphone does not capture the stream.
- **Session restore and alias deep links**: the last tuned station is persisted locally and restored on launch, while explicit `?play=` / `?radio=` / `?estacion=` / `?station=` deep links take priority. `?play=` works without a companion `?name=`.
- **Resilient playback**: when the browser blocks autoplay the stream stays loaded, the UI invites a manual tap, and pressing play re-arms the marquee and the song-metadata tracker. Web Audio effects route streams through the same-origin proxy only when an AudioContext actually exists, and the song detail popup reliably auto-closes after 60 seconds.
- **Song info enrichment**: MusicBrainz matching scores artist and title independently, prefers official studio releases over bootlegs/live/remix editions, exposes the album tracklist and a zoomable cover, and normalizes cover-art URLs to https. Song-info cache entries are versioned so improved matching invalidates stale metadata.
- **Release notes modal**: a "what's new + tutorial" modal appears once per app version, and a manual hard refresh can re-trigger it.

## Capabilities

### New Capabilities
- `voice-station-control`: microphone button, spoken commands and alias-based station resolution.
- `resilient-playback`: session restore, deep-link priority, autoplay-blocked recovery, Web Audio proxy routing and song popup lifecycle.
- `song-info-enrichment`: MusicBrainz matching quality, album tracklist, cover lightbox and versioned song-info cache.
- `release-notes-modal`: once-per-version what's-new and tutorial modal.

### Modified Capabilities

## Impact

- **Frontend (`app.js`, `index.html`, `style.css`)**: voice recognition, last-station/deep-link boot flow, Web Audio proxy decision, song popup sections and cover lightbox, release-notes modal, shared dark-surface design tokens.
- **Backend (`radios_app/handlers/media_info.py`)**: MusicBrainz query set, recording scoring, release ranking, album tracklist and Cover Art Archive URL normalization.
- **Service worker (`sw.js`)**: versioned cache name and offline fallback that ignores the `?v=` query.
- **No new runtime dependencies.**
