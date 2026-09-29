## Purpose

Lets a listener control the radio hands-free in Spanish and open a specific station through a short administrator-defined alias.

## ADDED Requirements

### Requirement: Voice Command Button
The application SHALL provide a dedicated microphone button that starts browser speech recognition and clearly indicates while it is listening.

#### Scenario: Starting recognition
- **WHEN** the user activates the microphone button
- **THEN** speech recognition starts in Spanish (`es-CL`), a listening indicator becomes visible, and the radio is muted so the microphone does not capture the stream

#### Scenario: Recognition ends
- **WHEN** recognition stops, errors or is aborted
- **THEN** the listening indicator is hidden and the radio is unmuted if it had been muted for the command

#### Scenario: Unsupported browser
- **WHEN** the browser exposes no SpeechRecognition implementation
- **THEN** the app informs the user that voice commands are unavailable instead of failing silently

### Requirement: Spoken Playback Commands
The application SHALL interpret recognized Spanish phrases as playback commands.

#### Scenario: Transport commands
- **WHEN** the user says an unambiguous pause, resume, next or previous phrase
- **THEN** the player pauses, resumes, or changes station accordingly

#### Scenario: Volume and song info
- **WHEN** the user asks to raise/lower the volume or to identify the current song
- **THEN** the player adjusts its volume or opens the song information for the current track

#### Scenario: Stop word as a preposition
- **WHEN** the phrase contains the word "para" as part of a larger request (for example "pon la radio para dormir")
- **THEN** the app treats it as a station request and does not pause

### Requirement: Station Resolution by Alias
The application SHALL resolve a spoken or linked station name against the curated catalogue, preferring the administrator-defined alias.

#### Scenario: Resolving by alias
- **WHEN** the user asks for a station using the alias defined in the admin panel
- **THEN** the app plays that station even if the spoken text only approximates the station's display name

#### Scenario: Alias variants
- **WHEN** comparing aliases and names
- **THEN** case, accents and punctuation are ignored

#### Scenario: Unknown station
- **WHEN** no station matches the request
- **THEN** the app reports that the station could not be found and leaves playback unchanged

### Requirement: Alias Deep Links
The application SHALL open a curated station directly from a URL parameter carrying its alias.

#### Scenario: Alias in the URL
- **WHEN** the app loads with `?radio=<alias>`, `?estacion=<alias>` or `?station=<alias>`
- **THEN** the matching station starts playing and the app reports the station name
