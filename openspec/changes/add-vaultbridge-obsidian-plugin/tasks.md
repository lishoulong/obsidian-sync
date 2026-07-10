## 1. Project Setup

- [x] 1.1 Create the Obsidian plugin TypeScript project structure.
- [x] 1.2 Add `manifest.json` with `isDesktopOnly: false`, plugin ID, name, and minimum app version.
- [x] 1.3 Add build scripts, TypeScript configuration, bundler configuration, and dependency lockfile.
- [x] 1.4 Add development install instructions for desktop Obsidian and mobile testing.

## 2. Configuration And State

- [x] 2.1 Define settings and persisted data models for Worker URL, sync token, device ID, exclusions, max file size, and device state.
- [x] 2.2 Implement settings load/save using Obsidian plugin data APIs.
- [x] 2.3 Implement settings UI with validation and masked sync-token display.
- [x] 2.4 Add a Worker connection test that validates Protocol v2 compatibility without modifying vault files.
- [x] 2.5 Ensure sync token and device state are never written into the synced vault manifest.

## 3. Vault Manifest Scanner

- [x] 3.1 Implement mobile-compatible vault file enumeration using Obsidian APIs.
- [x] 3.2 Implement safe path normalization and validation for vault-relative paths.
- [x] 3.3 Implement default exclusion rules for `.git/`, `.vaultbridge/`, OS noise, volatile Obsidian state, plugin-private state, and conflict copies.
- [x] 3.4 Implement file byte reading, size calculation, and SHA-256 hashing for supported file types.
- [x] 3.5 Add oversized file handling that stops or skips safely with a clear error.

## 4. Worker Protocol Client

- [x] 4.1 Implement authenticated JSON requests through Obsidian-compatible request APIs.
- [x] 4.2 Implement `/v2/sync/check` request and response parsing.
- [x] 4.3 Implement `/v2/pull/file` request and base64 response decoding.
- [x] 4.4 Implement `/v2/blob` upload request for local file bytes.
- [x] 4.5 Implement `/v2/commit` request and response parsing.
- [x] 4.6 Normalize Worker errors into user-readable plugin errors without leaking secrets.

## 5. Sync Orchestration

- [x] 5.1 Implement single-flight protection so only one sync can run at a time.
- [x] 5.2 Implement manual sync as pull first, stop on conflict, then push only after a clean pull.
- [x] 5.3 Apply download entries without overwriting files that changed after the plan was created.
- [x] 5.4 Apply local deletions conservatively using Obsidian trash behavior when available.
- [x] 5.5 Re-scan after pull before deciding upload and remote deletion work.
- [x] 5.6 Upload local changes as blobs and commit the complete current manifest.
- [x] 5.7 Persist `nextDeviceState` or `deviceState` only after the corresponding phase succeeds.
- [x] 5.8 Stop safely on stale, expired, interrupted, or failed sync sessions without advancing device state.

## 6. Conflict Safety

- [x] 6.1 Detect Worker conflict entries and stop before push.
- [x] 6.2 Download remote conflict versions when a remote blob SHA is available.
- [x] 6.3 Generate timestamped `remote-conflict` sibling filenames that preserve extensions and avoid collisions.
- [x] 6.4 Write conflict copies without modifying the local conflicted file.
- [x] 6.5 Report conflict counts and conflict-copy paths to the user.

## 7. Obsidian UI

- [x] 7.1 Add command palette command for manual sync.
- [x] 7.2 Add ribbon control for manual sync.
- [x] 7.3 Add status feedback for idle, syncing, success, conflict, and error states.
- [x] 7.4 Show sync summaries with download, upload, deletion, conflict, and commit information.
- [x] 7.5 Ensure UI surfaces work on desktop Obsidian and iOS Obsidian without desktop-only APIs.

## 8. Verification

- [ ] 8.1 Verify the plugin builds and loads in desktop Obsidian.
- [ ] 8.2 Verify the plugin loads and basic UI works in iOS Obsidian.
- [ ] 8.3 Verify first-run bootstrap behavior with an empty local test vault.
- [ ] 8.4 Verify first-run bootstrap conflict behavior when local and remote contain same-path different files.
- [ ] 8.5 Verify download, upload, local deletion, remote deletion, and conflict-copy flows against a test Worker/repository.
- [ ] 8.6 Verify network failure, stale session, expired session, and unauthorized token error handling.
- [ ] 8.7 Verify sync token masking and absence of device state from the vault manifest.
