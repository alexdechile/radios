## Context

`app.js` is a vanilla-JS PWA that plays internet radio streams through a Plyr-wrapped `<audio>` element. Radio metadata (artist/track) is read from the ICY stream and resolved to album art and details through MusicBrainz, Cover Art Archive and Wikipedia on the backend. The features below were added incrementally; this document records the decisions behind them.

## Goals / Non-Goals

**Goals:**
- Let a listener control the player hands-free with Spanish voice commands and open a specific station through a short alias URL.
- Keep playback working across browser autoplay restrictions and mobile audio quirks.
- Present authoritative album/tracklist data and avoid showing bootleg or remix editions as if they were the original album.
- Tell the user what changed after an update, once per version.

**Non-Goals:**
- Server-side speech recognition; recognition stays entirely in the browser.
- User accounts or per-user server state; preferences and session state live in `localStorage`.
- Replacing MusicBrainz/Wikipedia as the metadata source.

## Decisions

### 1. Voice recognition in the browser with the admin alias as the key
- **Decision**: Use `SpeechRecognition`/`webkitSpeechRecognition` with `lang='es-CL'`. Commands are matched against normalized (lowercase, accent- and punctuation-stripped) phrases, and station names resolve through `voice_name` first, then station name, then prefix/substring. The radio is muted during recognition and restored in `onend`.
- **Rationale**: No server round-trip, no audio uploaded, and the admin-defined alias disambiguates stations with similar names.
- **Alternatives considered**: Server-side STT (privacy and latency cost) and exact-name-only matching (brittle for names such as "Tele13 Radio 103.3").

### 2. Session restore with deep links taking priority
- **Decision**: Persist `{url, name, uuid, favicon}` under `radios_last_station` and restore it on boot only when no `?play=`/`?radio=` deep link is present. `?play=` alone is enough. If autoplay is blocked, keep the stream loaded, show a tap hint, and re-arm the marquee and metadata tracker from Plyr's `play` event.
- **Rationale**: A music app should resume where the listener left off, but an explicit link must win. Blocked autoplay is a normal mobile state, not an error, so it must recover without a reload.
- **Alternatives considered**: A server-stored session (overkill for a single-user homelab) and failing silently on autoplay rejection (previously left the UI stuck on the tap hint with no metadata).

### 3. Web Audio routing gated on a real AudioContext
- **Decision**: Proxy a stream through the same-origin `/proxy` endpoint when it is plain HTTP (mixed content) or when an AudioContext genuinely exists. `shouldProxyForWebAudio()` returns `!!audioCtx`; merely opening the EQ/effects panel does not force the proxy, because `initEqualizer()` may abort on iOS or when `AudioContext` creation fails.
- **Rationale**: `createMediaElementSource` on a cross-origin stream can silence playback on Android/Chrome, so proxying is required once Web Audio is in the graph; forcing it without a graph wastes the single-threaded backend and adds latency.
- **Alternatives considered**: Always proxying (dead weight) and never proxying (silent audio once effects are enabled).

### 4. MusicBrainz matching: independent artist/title floors plus release ranking
- **Decision**: Score artist and title separately and require a minimum on each; combine several queries (official-first, then not-live, then exact, then free-text) without stopping at the first query that returns anything; rank releases with a quality score that rewards official studio albums and penalizes bootlegs, live, compilation, interview and remix editions; prefer the earliest edition on ties; omit album and tracklist when the best release is still a bootleg. Normalize Cover Art Archive URLs to https and bump `SONGINFO_CACHE_VERSION` when the algorithm changes.
- **Rationale**: An exact title previously cleared the acceptance threshold on its own, letting a correctly-titled cover by a similarly named act win, and MusicBrainz search returns bootleg/live releases first for heavily covered songs. Versioning the cache makes an improved algorithm actually take effect.
- **Alternatives considered**: Trusting the first search hit (the original behaviour) and a single combined score (which cannot express "artist must match AND title must match").

### 5. Release notes shown once per version
- **Decision**: Key the modal on `radios_changelog_seen` vs `APP_VERSION`, with `radios_pending_changelog` allowing a manual hard refresh to re-show it. Content lives in a `WHATS_NEW` map keyed by version.
- **Rationale**: Users should learn about changes once after updating, and support should be able to re-show the tutorial without a version bump.
- **Alternatives considered**: Fetching release notes from the server (an extra endpoint for static copy).

## Risks / Trade-offs

- [Voice recognition support varies] → Feature-detect and show a clear toast when unsupported; the button stays visible but inert.
- [MusicBrainz rate limit of ~1 request/second] → The query loop stops as soon as a candidate with an official studio release is found, so the common path makes a single search request.
- [Alias collisions] → Normalized uniqueness is enforced server-side; the client's fuzzy fallback may still resolve an ambiguous prefix to the first match.
- [Proxy load] → Only HTTP streams and sessions with an active AudioContext are proxied; admin writes and playback are single-user.
