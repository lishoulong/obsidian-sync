## ADDED Requirements

### Requirement: Conflict preservation
The plugin SHALL never silently overwrite local or remote content when Protocol v2 reports a conflict.

#### Scenario: Conflict detected
- **WHEN** `/v2/sync/check` returns one or more conflict entries
- **THEN** the plugin SHALL keep the local files unchanged and SHALL NOT call `/v2/commit`

### Requirement: Remote conflict copy creation
The plugin SHALL save remote conflict versions as separate sibling files so the user can review both versions.

#### Scenario: Remote conflict file is available
- **WHEN** a conflict entry includes a remote blob SHA
- **THEN** the plugin SHALL download the remote version and create a conflict copy using a timestamped `remote-conflict` filename

#### Scenario: Conflict copy filename collides
- **WHEN** the generated conflict copy path already exists
- **THEN** the plugin SHALL choose a non-colliding suffix rather than overwriting the existing conflict copy

#### Scenario: Conflict copy preserves extension
- **WHEN** the conflicted file has an extension
- **THEN** the plugin SHALL preserve that extension in the generated conflict copy filename

#### Scenario: Remote conflict cannot be downloaded
- **WHEN** the plugin cannot download the remote conflict version
- **THEN** it SHALL report the failure and SHALL NOT overwrite the local file

### Requirement: Destructive operation safety
The plugin SHALL treat file deletions as destructive operations and apply them conservatively.

#### Scenario: Local deletion from remote plan
- **WHEN** the Worker plan says a local file should be deleted because it was deleted remotely
- **THEN** the plugin SHALL use trash behavior when available or otherwise clearly report the deletion behavior before completing sync

#### Scenario: Remote deletion from local plan
- **WHEN** the Worker plan says a remote file should be deleted because it was deleted locally
- **THEN** the plugin SHALL include that path in `/v2/commit` only after confirming the file is still absent from the local manifest

### Requirement: No stale local writes
The plugin SHALL avoid overwriting a file that changed locally after the sync plan was created.

#### Scenario: File changes during sync
- **WHEN** a local file's current hash differs from the hash used to create the sync plan before the plugin writes to that path
- **THEN** the plugin SHALL stop or re-plan instead of overwriting the changed file

### Requirement: Directory safety
The plugin SHALL only apply file-level operations returned by the Worker and SHALL NOT delete directories blindly.

#### Scenario: Delete path refers to a folder
- **WHEN** a planned deletion path resolves to a folder or non-file object
- **THEN** the plugin SHALL skip the deletion and report a safety error
