## ADDED Requirements

### Requirement: Vault file manifest generation
The plugin SHALL scan the current Obsidian vault and generate a Protocol v2 manifest mapping each syncable path to file size and SHA-256 hash.

#### Scenario: Manifest includes syncable files
- **WHEN** the vault contains Markdown notes and supported attachment files
- **THEN** the plugin SHALL include each syncable file path with its byte size and lowercase hexadecimal SHA-256 hash

#### Scenario: Manifest paths are vault-relative
- **WHEN** the plugin adds files to the manifest
- **THEN** each manifest key SHALL be a normalized vault-relative path without a leading slash

### Requirement: Safe exclusion rules
The plugin SHALL exclude paths that are internal, volatile, or unsafe to synchronize.

#### Scenario: Internal paths are excluded
- **WHEN** the vault contains `.git/`, `.vaultbridge/`, `.DS_Store`, or plugin-private state
- **THEN** the plugin SHALL exclude those files from the manifest

#### Scenario: Conflict copies are excluded from automatic upload
- **WHEN** the vault contains files created by the plugin with a `remote-conflict` suffix
- **THEN** the plugin SHALL exclude those files from automatic upload unless the user explicitly renames or opts them in

#### Scenario: Volatile Obsidian workspace files are excluded
- **WHEN** the vault contains volatile workspace or cache files
- **THEN** the plugin SHALL exclude them according to the configured default exclusion rules

### Requirement: Mobile-compatible file access
The plugin SHALL use Obsidian-compatible file APIs for scanning and reading vault content.

#### Scenario: Running on Obsidian Mobile
- **WHEN** the plugin runs on iOS Obsidian
- **THEN** manifest scanning SHALL NOT require Node `fs`, Node `path`, Electron APIs, native `git`, or a desktop filesystem adapter

### Requirement: Oversized file handling
The plugin SHALL handle files that exceed the configured maximum sync size without corrupting local or remote state.

#### Scenario: File exceeds maximum size
- **WHEN** a vault file is larger than the configured maximum sync size
- **THEN** the plugin SHALL skip or block sync with a clear error before attempting to upload the file

### Requirement: Path correctness
The plugin SHALL normalize and validate vault paths before including them in the manifest or sending them to the Worker.

#### Scenario: Unicode and spaced filenames
- **WHEN** a syncable file path contains Unicode characters or spaces
- **THEN** the plugin SHALL preserve the user's filename while sending a normalized vault-relative path

#### Scenario: Unsafe path segment
- **WHEN** a file path would resolve outside the vault or contains an empty, current-directory, or parent-directory segment
- **THEN** the plugin SHALL exclude it and report a manifest error
