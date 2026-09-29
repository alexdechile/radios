# curated-admin Specification

## Purpose
Provides a secure, internal administrative interface accessible strictly through Tailscale to view, search, curate, reorder, and document editorial commentary for the radios served as the default catalogue to all users.
## Requirements
### Requirement: Tailscale Network Access Control
The application server SHALL restrict access to the curated radio administration interface and administrative write operations strictly to requests originating from the Tailscale network or local loopback.

#### Scenario: Request from Tailscale IPv4 or IPv6
- **WHEN** a client makes an HTTP request to `/admin` or `/admin.html` with a client IP in `100.64.0.0/10`, `fd7a:115c:a1e0::/48`, or loopback (`127.0.0.1`, `::1`)
- **THEN** the server grants access and serves the administrative interface

#### Scenario: Request from non-Tailscale / Public Funnel
- **WHEN** a client makes an HTTP request to `/admin`, `/admin.html`, or administrative mutation endpoints from a non-Tailscale IP or through an external funnel header
- **THEN** the server rejects the request with HTTP 403 Forbidden and an informative error message

### Requirement: Curated Stations Grid and Filtering
The admin interface SHALL render a responsive grid displaying all stations currently registered in the curated database, showing their primary attributes and allowing real-time text filtering.

#### Scenario: Viewing curated radios list
- **WHEN** an administrator opens the `/admin` dashboard
- **THEN** the grid loads all curated radios ordered by position and country, displaying their logo/favicon, station name, country, stream URL, bitrate/codec, tags, and editorial notes summary

#### Scenario: Real-time filtering within the grid
- **WHEN** an administrator types search keywords into the local filter field
- **THEN** the grid immediately filters visible stations by matching name, country, tags, or editorial commentary

### Requirement: Station Discovery and Import
The admin interface SHALL provide a search capability allowing administrators to query external station directories (Radio Browser API / Deep Search) and import selected stations into the curated database.

#### Scenario: Searching external station directories
- **WHEN** the administrator queries an external term in the discovery search bar
- **THEN** the system displays candidate stations with name, country, stream URL, and an "Añadir a Curadas" action button

#### Scenario: Importing an external station into curated
- **WHEN** the administrator clicks "Añadir a Curadas" on an external search result
- **THEN** a pre-filled editor modal opens allowing the administrator to inspect attributes, assign position, and write editorial notes before saving to the SQLite database

### Requirement: Editorial Commentary and Station Editing
The administration interface and API SHALL allow creating and updating station records with a dedicated editorial commentary field and featured highlight toggle.

#### Scenario: Saving editorial notes
- **WHEN** the administrator edits a curated station, enters text into the "Nota Editorial" field, and submits the form
- **THEN** the server persists the editorial note in the database and updates the station in the default catalogue

#### Scenario: Editing station details
- **WHEN** the administrator updates station metadata (e.g., name, stream URL, favicon, tags, position)
- **THEN** the server validates the station UUID and updates the record in `curated_radios`

### Requirement: Voice Alias for Deep Links and Voice Commands
The administration interface and API SHALL allow assigning a unique, human-friendly alias (`voice_name`) to each curated station, which clients use to open or play that station through `?radio=<alias>` deep links and voice commands.

#### Scenario: Assigning a unique alias
- **WHEN** the administrator saves a station whose `voice_name` normalizes (lowercased, accents and punctuation removed) to the same key as another station
- **THEN** the server rejects the write with HTTP 409 and an informative error, leaving the existing alias intact

#### Scenario: Re-saving a station preserves its alias
- **WHEN** a station is re-saved through the add endpoint without changing its alias
- **THEN** the server updates only the fields provided in the request and does not clear the stored alias, editorial notes or featured flag

#### Scenario: Alias exposed to clients
- **WHEN** a client requests the curated catalogue
- **THEN** every station includes its `voice_name` so the client can resolve `?radio=<alias>` and voice commands

### Requirement: Stream Testing and Deletion
The admin interface SHALL provide instant stream playback testing and the ability to remove obsolete stations from the curated catalogue.

#### Scenario: Previewing station audio
- **WHEN** the administrator clicks the preview play button on any station card
- **THEN** the embedded preview audio player attempts to stream the audio directly with visual feedback of playing/error status

#### Scenario: Deleting a curated station
- **WHEN** the administrator confirms deletion of a station
- **THEN** the server removes the record from `curated_radios` and the station is removed from the grid

