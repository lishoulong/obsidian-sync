## ADDED Requirements

### Requirement: Manual sync command
The plugin SHALL expose a manual sync command inside Obsidian.

#### Scenario: Command palette sync
- **WHEN** the user runs the plugin's sync command from the Obsidian command palette
- **THEN** the plugin SHALL start the manual sync workflow if no sync is already running

#### Scenario: Ribbon sync
- **WHEN** the user activates the plugin's ribbon sync control
- **THEN** the plugin SHALL start the same manual sync workflow as the command palette command

### Requirement: Manual-first synchronization
The plugin SHALL make manual sync the MVP's primary and reliable synchronization mode.

#### Scenario: Obsidian is closed or suspended
- **WHEN** Obsidian is not running or iOS suspends the app
- **THEN** the plugin SHALL NOT promise reliable background synchronization

### Requirement: Sync status feedback
The plugin SHALL show clear status feedback during and after sync.

#### Scenario: Sync starts
- **WHEN** a sync begins
- **THEN** the plugin SHALL indicate that synchronization is in progress

#### Scenario: Sync succeeds
- **WHEN** a sync completes successfully
- **THEN** the plugin SHALL show counts for relevant downloads, uploads, deletions, conflicts, or unchanged files when available

#### Scenario: Push creates a commit
- **WHEN** `/v2/commit` succeeds and returns a commit SHA
- **THEN** the plugin SHALL include the new commit SHA or an abbreviated form in the sync result

#### Scenario: Sync fails
- **WHEN** a sync fails
- **THEN** the plugin SHALL show a user-readable error without exposing full secrets

### Requirement: Prevent concurrent syncs
The plugin SHALL prevent overlapping sync operations in the same Obsidian session.

#### Scenario: Sync already running
- **WHEN** the user triggers sync while another sync is in progress
- **THEN** the plugin SHALL ignore or queue the second trigger and inform the user that sync is already running

### Requirement: Mobile-compatible UI
The plugin SHALL use Obsidian-compatible UI surfaces that work on desktop and mobile.

#### Scenario: Running on iOS Obsidian
- **WHEN** the plugin is installed on Obsidian Mobile
- **THEN** its settings, command, status feedback, and conflict notices SHALL be usable without desktop-only UI APIs
