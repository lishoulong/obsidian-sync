## ADDED Requirements

### Requirement: Sync plan creation
The plugin SHALL create a Protocol v2 sync plan by sending the current device ID, last synced commit SHA, and local file manifest to the Worker.

#### Scenario: First sync has no base commit
- **WHEN** the plugin has no stored `lastSyncedCommitSha`
- **THEN** it SHALL call `/v2/sync/check` with `lastSyncedCommitSha` set to null

#### Scenario: Existing device state is used
- **WHEN** the plugin has a stored `lastSyncedCommitSha`
- **THEN** it SHALL include that commit SHA in `/v2/sync/check`

#### Scenario: Bootstrap conflict
- **WHEN** first sync has no base commit and the Worker reports same-path local and remote differences as conflicts
- **THEN** the plugin SHALL treat them as conflicts and SHALL NOT silently choose either side

### Requirement: Two-phase sync ordering
The plugin SHALL run manual sync as pull first, then push only when pull completes without conflicts.

#### Scenario: Pull produces conflicts
- **WHEN** the pull phase detects conflicts
- **THEN** the plugin SHALL stop before blob upload or commit

#### Scenario: Pull completes cleanly
- **WHEN** downloads and local deletions complete without conflict or stale-session errors
- **THEN** the plugin SHALL rescan the vault before deciding what to upload or delete remotely

### Requirement: Pull plan application
The plugin SHALL apply Worker `download` and `deleteLocal` plan entries before pushing local changes.

#### Scenario: Remote file download
- **WHEN** the sync plan contains a `download` entry
- **THEN** the plugin SHALL call `/v2/pull/file` for the specified blob and write the returned content to the vault path

#### Scenario: Remote deletion
- **WHEN** the sync plan contains a `deleteLocal` entry
- **THEN** the plugin SHALL remove the local file using the safest Obsidian-supported deletion behavior available

### Requirement: Push plan application
The plugin SHALL upload local changes and commit them through Protocol v2 after the pull phase has completed without conflicts.

#### Scenario: Local file upload
- **WHEN** the sync plan contains an `upload` entry
- **THEN** the plugin SHALL read the local file, base64 encode its bytes, and call `/v2/blob`

#### Scenario: Commit local changes
- **WHEN** all required blobs have been created and there are local changes or remote deletions to commit
- **THEN** the plugin SHALL call `/v2/commit` with a manifest patch, blob entries, device ID, and session token

### Requirement: Session staleness handling
The plugin SHALL stop safely when the Worker reports that the remote branch changed after the sync plan was created.

#### Scenario: Stale session response
- **WHEN** any Worker operation returns `sync_session_stale` or equivalent stale-plan error
- **THEN** the plugin SHALL stop the current sync, avoid further writes based on that plan, and tell the user to retry

#### Scenario: Expired session response
- **WHEN** any Worker operation returns `sync_session_expired`
- **THEN** the plugin SHALL discard the current session token, stop the current sync, and tell the user to retry

### Requirement: Partial network failure handling
The plugin SHALL fail safely when network or Worker errors interrupt sync.

#### Scenario: Download request fails
- **WHEN** a `/v2/pull/file` request fails before content is written
- **THEN** the plugin SHALL leave the existing local file unchanged and SHALL NOT advance device state

#### Scenario: Blob upload or commit fails
- **WHEN** `/v2/blob` or `/v2/commit` fails
- **THEN** the plugin SHALL NOT advance device state and SHALL report that remote sync did not complete

### Requirement: Worker authentication
The plugin SHALL authenticate Worker requests with the configured sync token.

#### Scenario: Authenticated Protocol v2 call
- **WHEN** the plugin calls a protected Worker endpoint
- **THEN** it SHALL send `Authorization: Bearer <SYNC_TOKEN>` and JSON content headers as required by Protocol v2
