# resilient-playback Specification

## Purpose
Keeps radio playback working across browser autoplay restrictions, mobile audio quirks and the song detail popup, while remembering where the listener left off.
## Requirements
### Requirement: Session Restore
The application SHALL persist the last tuned station and restore it when the app is opened again.

#### Scenario: Restoring the last station
- **WHEN** the app loads without an explicit deep link and a previously tuned station exists
- **THEN** the app attempts to play that station and, if playback starts, shows its title and begins tracking song metadata

#### Scenario: Explicit deep link wins
- **WHEN** the app loads with `?play=`, `?radio=`, `?estacion=` or `?station=`
- **THEN** the deep-linked station is played and the stored last station is not auto-restored

#### Scenario: Play without a name
- **WHEN** the app loads with `?play=<stream-url>` and no `?name=` parameter
- **THEN** the stream still plays, using a generic station name

#### Scenario: Corrupt stored state
- **WHEN** the stored last station cannot be parsed or has no stream URL
- **THEN** the app ignores it and boots normally

### Requirement: Autoplay-Blocked Recovery
The application SHALL keep a stream usable when the browser blocks automatic playback.

#### Scenario: Autoplay rejected
- **WHEN** automatic playback is rejected by the browser
- **THEN** the stream stays loaded, the song-metadata popup is dismissed, and the interface invites the user to press play

#### Scenario: Manual play after a block
- **WHEN** the user starts playback manually after an autoplay block
- **THEN** the station title and the song metadata tracking resume without requiring a reload

### Requirement: Web Audio Routing
The application SHALL route a stream through the same-origin proxy when required for correct audio processing, and only then.

#### Scenario: Plain HTTP stream
- **WHEN** a station's stream URL uses `http://`
- **THEN** the stream is played through the same-origin proxy

#### Scenario: Web Audio graph active
- **WHEN** an AudioContext already exists because the user enabled the equalizer or effects
- **THEN** the stream is played through the same-origin proxy and re-routed before the Web Audio graph is created

#### Scenario: Effects panel opened without a graph
- **WHEN** the equalizer or effects panel is opened but no AudioContext could be created (for example on iOS)
- **THEN** streams continue to play natively without being forced through the proxy

### Requirement: Song Popup Lifecycle
The song detail popup SHALL close itself after a period of inactivity while remaining open during deliberate interaction.

#### Scenario: Auto-close after inactivity
- **WHEN** the popup has been open for 60 seconds without interaction
- **THEN** the popup closes automatically

#### Scenario: Interaction extends the popup
- **WHEN** the user zooms the cover, expands the album list or lyrics, or interacts with the popup body
- **THEN** the auto-close countdown is paused or restarted so the popup does not disappear mid-interaction

### Requirement: Offline Asset Availability
The service worker SHALL serve versioned application assets when offline.

#### Scenario: Offline request for a versioned asset
- **WHEN** the app is offline and requests an asset URL carrying a `?v=` query that is not cached under its full URL
- **THEN** the service worker serves the cached asset for the same path without the query

#### Scenario: Offline navigation
- **WHEN** the app navigates while offline
- **THEN** the cached application shell is served

