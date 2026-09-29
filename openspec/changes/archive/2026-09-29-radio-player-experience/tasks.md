## 1. Voice Station Control

- [x] 1.1 Add a dedicated microphone button (`#btnVoiceCommand`) to the header with a listening indicator badge.
- [x] 1.2 Implement `startVoiceRecognition()` with `lang='es-CL'`, permission/error toasts, a duplicate-start guard and mute-while-listening.
- [x] 1.3 Implement `handleVoiceCommand()` for pause/resume, next/previous, volume, current-song info and station resolution.
- [x] 1.4 Resolve stations by admin `voice_name`, then exact name, then prefix/substring, normalizing accents and punctuation.
- [x] 1.5 Make the pause command ignore `para` as a preposition ("pon la radio para dormir" must tune, not pause).

## 2. Session Restore and Deep Links

- [x] 2.1 Persist the last tuned station under `radios_last_station` and restore it on boot.
- [x] 2.2 Give `?play=` / `?radio=` / `?estacion=` / `?station=` priority over restore, and accept `?play=` without `?name=`.
- [x] 2.3 Recover from blocked autoplay: keep the stream loaded, show the tap hint, and re-arm the marquee and metadata tracker from the `play` event.
- [x] 2.4 Make the metadata tracker idempotent per station.

## 3. Resilient Playback

- [x] 3.1 Route streams through the same-origin `/proxy` only for HTTP streams or when an AudioContext exists.
- [x] 3.2 Re-route an already-playing stream through the proxy before creating the Web Audio graph.
- [x] 3.3 Restore the 60-second song popup auto-close and re-arm it when the cover lightbox, album list or lyrics are collapsed, extending it on popup interaction.
- [x] 3.4 Version the service worker cache from a single `APP_V` constant and fall back to the un-versioned pathname when offline.

## 4. Song Info Enrichment

- [x] 4.1 Score MusicBrainz recordings with independent artist and title minimums.
- [x] 4.2 Combine several queries (official-first) and stop early once an official studio release is found.
- [x] 4.3 Rank releases by an official/studio quality score and skip bootleg albums and tracklists.
- [x] 4.4 Fetch and cache the album tracklist; expose it in an expandable popup section with the current track highlighted.
- [x] 4.5 Add the cover lightbox inside the popup and an `albumTracks` info-panel setting.
- [x] 4.6 Normalize Cover Art Archive thumbnails to https.
- [x] 4.7 Version `song_cache` entries via `SONGINFO_CACHE_VERSION` so algorithm changes invalidate stale rows.

## 5. Release Notes Modal

- [x] 5.1 Add the `WHATS_NEW` registry keyed by `APP_VERSION` with a news step and a tutorial step.
- [x] 5.2 Show the modal once per version and let a manual hard refresh re-trigger it.
- [x] 5.3 Align the modal's dark palette with the song popup through shared CSS variables.

## 6. Verification & Documentation

- [x] 6.1 Verify the app boots with zero console errors and exercise voice, popup, lightbox and album flows with a headless browser.
- [x] 6.2 Verify MusicBrainz selection on Queen, Los Prisioneros and Adele against the live endpoint.
- [x] 6.3 Document the release in `alex.md` and bump `APP_VERSION` across `app.js`, `index.html`, `sw.js` and `version_check.json`.
