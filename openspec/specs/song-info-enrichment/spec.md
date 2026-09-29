# song-info-enrichment Specification

## Purpose
Provides accurate, official-facing song metadata (artist, album, cover, label, tracklist) for the currently playing track, avoiding mismatched artists and bootleg editions.
## Requirements
### Requirement: Recording Matching Quality
The song-info backend SHALL only accept a MusicBrainz recording when both the artist and the title match with sufficient confidence.

#### Scenario: Title matches but artist does not
- **WHEN** a candidate recording has the requested title but an unrelated or merely similar artist name
- **THEN** the candidate is rejected and is not used to build the song information

#### Scenario: Featured or extended artist credit
- **WHEN** the candidate's artist credit contains all the requested artist's words plus extra performers
- **THEN** the candidate is accepted

#### Scenario: No confident match
- **WHEN** no candidate meets both minimums
- **THEN** the backend returns no MusicBrainz result instead of guessing

#### Scenario: Fallback query when the exact query is weak
- **WHEN** the strict query returns candidates that do not meet the minimums
- **THEN** broader queries are attempted before giving up

### Requirement: Official Release Preference
The song-info backend SHALL prefer official studio releases when choosing the album, cover, label and tracklist.

#### Scenario: Bootleg or live editions
- **WHEN** the only acceptable releases for a recording are bootlegs, live or interview editions
- **THEN** the backend does not present them as the song's album or tracklist

#### Scenario: Remix or derived edition
- **WHEN** a release is a derived edition such as a remix, 5.1 mix or instrumental
- **THEN** it ranks below the original edition so the original album is preferred

#### Scenario: Equivalent releases
- **WHEN** two releases have the same quality score
- **THEN** the earliest edition is preferred

### Requirement: Album Tracklist and Cover
The song detail view SHALL present the album tracklist and an expandable cover when available.

#### Scenario: Tracklist available
- **WHEN** the current song has an official release with a tracklist
- **THEN** the popup shows the album name, the number of tracks and the list of track titles with durations, highlighting the current track

#### Scenario: Tracklist disabled by settings
- **WHEN** the user disables the "Lista de temas" setting
- **THEN** the tracklist section is not displayed

#### Scenario: Cover preview
- **WHEN** the song has a cover image and the user activates it
- **THEN** the popup displays the cover enlarged within the popup bounds

#### Scenario: Secure cover URLs
- **WHEN** a cover image URL is returned over plain HTTP
- **THEN** it is returned as HTTPS so it is not blocked on secure pages

### Requirement: Versioned Song Info Cache
The song-info cache SHALL be invalidated when the matching algorithm changes.

#### Scenario: Algorithm version increased
- **WHEN** the stored cache entry was written by an older algorithm version
- **THEN** it is treated as stale and the metadata is fetched again

#### Scenario: Cached tracklist shape
- **WHEN** a cached entry is served
- **THEN** its stored tracklist is returned as a list, and a missing or invalid value is returned as an empty list

