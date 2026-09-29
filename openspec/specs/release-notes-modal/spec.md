# release-notes-modal Specification

## Purpose
Tells listeners what changed after an update and offers a short tutorial, shown once per application version.
## Requirements
### Requirement: Once-Per-Version Release Notes
The application SHALL show a release-notes modal at most once per application version.

#### Scenario: First launch after an update
- **WHEN** the app starts and the stored seen-version differs from the current application version
- **THEN** the release-notes modal is displayed shortly after boot

#### Scenario: Subsequent launches
- **WHEN** the app starts and the stored seen-version already matches the current application version
- **THEN** the release-notes modal is not displayed

#### Scenario: Dismissing the modal
- **WHEN** the user closes the modal
- **THEN** the current version is recorded as seen and the modal stays closed for subsequent launches

#### Scenario: Manual re-display after a hard refresh
- **WHEN** the user triggers a manual hard refresh
- **THEN** the release-notes modal is displayed again on the next load even if the version did not change

### Requirement: Release Notes Content
The modal SHALL present a list of changes and a short guided tutorial.

#### Scenario: News step
- **WHEN** the modal opens
- **THEN** it shows the changes registered for the current version

#### Scenario: Tutorial step
- **WHEN** the user advances past the changes
- **THEN** the modal shows the tutorial steps with progress and previous/next navigation, ending with a close action

#### Scenario: Unknown version
- **WHEN** no release-note entry exists for the current version
- **THEN** the modal falls back to generic content instead of failing to open

### Requirement: Consistent Modal Styling
The release-notes modal SHALL share the player's dark surface styling.

#### Scenario: Visual consistency
- **WHEN** the release-notes modal is displayed
- **THEN** it uses the same background, border and accent tokens as the song detail popup

