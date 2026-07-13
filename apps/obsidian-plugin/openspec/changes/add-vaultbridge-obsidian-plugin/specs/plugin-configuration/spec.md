## ADDED Requirements

### Requirement: Worker connection settings
The plugin SHALL allow the user to configure the VaultBridge Worker URL, sync token, and device ID required to call Protocol v2.

#### Scenario: Missing required configuration blocks sync
- **WHEN** the user triggers sync without a Worker URL, sync token, or device ID
- **THEN** the plugin SHALL stop before scanning or network calls and show a configuration error

#### Scenario: Configured settings persist
- **WHEN** the user saves valid Worker URL, sync token, and device ID settings
- **THEN** the plugin SHALL persist those settings across Obsidian restarts

### Requirement: Device state persistence
The plugin SHALL persist the compact Protocol v2 device state outside the synced vault content.

#### Scenario: Successful sync updates device state
- **WHEN** the Worker returns a new `deviceState` or `nextDeviceState`
- **THEN** the plugin SHALL store the returned state for the next sync

#### Scenario: Partial sync does not update device state
- **WHEN** downloads, conflict handling, blob upload, commit, or any other sync step fails or is interrupted
- **THEN** the plugin SHALL NOT advance `lastSyncedCommitSha`

#### Scenario: Device state is not added to the vault manifest
- **WHEN** the plugin scans the vault for syncable files
- **THEN** the plugin SHALL NOT include plugin-local device state as a vault file

### Requirement: Secret handling
The plugin SHALL avoid exposing the configured sync token in user-facing text, logs, vault files, or error output.

#### Scenario: Error includes request context
- **WHEN** a Worker request fails
- **THEN** the plugin SHALL show an actionable error without displaying the raw sync token

#### Scenario: Settings display token
- **WHEN** the user views plugin settings
- **THEN** the plugin SHALL mask or otherwise avoid casually exposing the full sync token

### Requirement: Connection validation
The plugin SHALL provide a way to validate the configured Worker connection before a real sync.

#### Scenario: Worker health check succeeds
- **WHEN** the user tests a reachable Worker that reports VaultBridge Protocol v2
- **THEN** the plugin SHALL report the connection as valid

#### Scenario: Worker check fails
- **WHEN** the Worker is unreachable or reports an incompatible protocol
- **THEN** the plugin SHALL show a clear error and SHALL NOT modify vault files
