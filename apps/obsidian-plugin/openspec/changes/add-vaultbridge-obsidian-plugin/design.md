## Context

The same monorepo provides a Cloudflare Worker under `apps/worker` that implements VaultBridge Protocol v2. The Worker owns GitHub API access, three-way comparison, blob creation, commit creation, branch ref updates, and repository-level `.vaultbridge/manifest.json` maintenance.

The `apps/obsidian-plugin` application replaces the iOS Shortcut client. The plugin must run inside Obsidian Mobile, where native `git`, SSH agents, Node filesystem modules, and Electron APIs are not reliable options. The plugin should therefore behave as a VaultBridge client, not as a general Git client.

Key constraints:

- Obsidian Mobile plugins must avoid desktop-only assumptions.
- Vault file access should use Obsidian's Vault APIs where possible.
- Network calls should use Obsidian-compatible request APIs rather than desktop-only HTTP assumptions.
- Plugin data should be stored with Obsidian plugin data APIs, not as files inside the synced vault.
- User content safety is more important than automatic conflict resolution.

## Goals / Non-Goals

**Goals:**

- Provide a manual "sync now" workflow inside Obsidian on desktop and mobile.
- Support iOS Obsidian as a first-class target.
- Reuse the existing Worker Protocol v2 endpoints without requiring full Git inside the plugin.
- Generate the local file manifest required by Protocol v2.
- Apply downloads, uploads, local deletions, remote deletions, and conflicts safely.
- Preserve compact per-device sync state across Obsidian restarts.
- Surface sync state and errors clearly inside Obsidian.

**Non-Goals:**

- Implement a full Git client.
- Support branch switching, commit graph browsing, rebase, merge, submodules, or arbitrary remotes.
- Run reliable background sync while Obsidian is closed or suspended by iOS.
- Auto-merge conflicting note edits.
- Store GitHub credentials in the plugin.
- Replace the Cloudflare Worker.

## Decisions

### Use the Worker as the Git boundary

The plugin will only call VaultBridge Protocol v2. GitHub token storage, Git object creation, commit creation, and branch updates remain server-side in the Worker.

Alternatives considered:

- Run native `git` from the plugin. Rejected because this is not viable on Obsidian Mobile.
- Use a JavaScript Git implementation in the plugin. Rejected for MVP because it reintroduces mobile memory, SSH, merge, and repository-size complexity.
- Call GitHub REST directly from the plugin. Rejected because it would expose GitHub credentials and duplicate Worker logic.

### Treat the plugin as a sync client, not a repository manager

The plugin will expose sync operations and status, not Git concepts. User-facing language should focus on "sync", "upload", "download", "conflict", and "last synced", not "tree", "blob", "ref", or "rebase".

Alternatives considered:

- Mirror desktop Git plugin UX. Rejected because it implies capabilities the plugin will not provide.
- Hide all details. Rejected because conflict and destructive-operation feedback must be visible.

### Store device state in plugin data

The plugin will store settings and compact device state through Obsidian plugin data APIs. The vault content itself must not contain device-specific state such as `lastSyncedCommitSha`.

Alternatives considered:

- Store `device-state.json` inside the vault. Rejected because it would sync device-local state across devices and create feedback loops.
- Store state in a hidden `.vaultbridge/` folder in the vault. Rejected because `.vaultbridge/` is reserved for repository-level Worker state.

### Use conservative exclusion rules

The manifest scanner will exclude internal sync state, Git metadata, OS noise, and volatile Obsidian workspace/cache files. The MVP should avoid synchronizing plugin-private data and device-local workspace state.

Alternatives considered:

- Sync every file in the vault. Rejected because it risks syncing volatile state and device-local plugin data.
- Sync only Markdown files. Rejected because Obsidian vaults often include attachments that users expect to move with notes.

### Make conflicts explicit and non-destructive

When Protocol v2 reports conflicts, the plugin will keep the local file unchanged, download the remote version, write it as a conflict sibling file, and stop before pushing.

Alternatives considered:

- Prefer local changes. Rejected because it can silently lose remote work.
- Prefer remote changes. Rejected because it can silently lose mobile work.
- Auto-merge Markdown. Rejected for MVP because incorrect merges are worse than visible conflict files.

### Start with manual sync

The MVP will expose manual sync via command palette and ribbon. Startup or interval sync can be considered later while Obsidian is open, but reliable background sync while iOS suspends Obsidian is out of scope.

Alternatives considered:

- Build background sync first. Rejected because iOS suspension and Obsidian lifecycle make this an unreliable primary promise.
- Keep using Shortcuts as the main trigger. Rejected because the purpose of this change is to avoid Shortcut complexity.

## Risks / Trade-offs

- Mobile file scanning may be slow on large vaults -> Use progress feedback, skip unsupported/oversized files, and keep scanning logic incremental where practical.
- Binary attachment hashing may increase memory usage -> Avoid unnecessary string conversion for binary content and respect Worker file-size limits.
- Files can change during sync -> Re-scan before commit and avoid applying a stale plan when the Worker reports a stale session.
- Token storage in plugin data may be less protected than native Keychain -> Keep GitHub credentials out of the plugin and document that `SYNC_TOKEN` grants Worker sync access.
- Deleting files is risky -> Use Obsidian trash behavior when possible and surface deletion counts before/after sync.
- Worker Protocol v2 may lack some plugin-specific feedback fields -> Keep MVP compatible with current endpoints; defer protocol changes unless implementation discovers a hard blocker.
- Obsidian API behavior differs across desktop/mobile -> Verify the plugin on iOS Obsidian before considering the MVP complete.

## Migration Plan

1. Create the Obsidian plugin project in this repository.
2. Implement settings and a connection test against the deployed Worker.
3. Implement vault manifest scanning and local device state persistence.
4. Implement manual pull/push/sync orchestration through Protocol v2.
5. Validate on desktop Obsidian for development ergonomics.
6. Validate on iOS Obsidian with a test vault and test GitHub repository.
7. Switch the real vault only after conflict, download, upload, and deletion behavior have been manually verified.

Rollback is operational rather than code-based: disable mobile Worker sync, use the desktop Git workflow where available, or reinstall a previous plugin release. Since device state is plugin-local and conflicts are written as additional files, disabling the plugin should not remove user content.

## Open Questions

- Should `.obsidian/` be entirely excluded in MVP, or should selected stable configuration files be opt-in?
- Should the plugin support attachments in the first release, or initially limit itself to Markdown and small text files?
- What is the safest default for `deleteLocal`: trash locally, skip with warning, or require a user confirmation mode?
- Should `SYNC_TOKEN` be stored directly in plugin data, or should desktop/mobile-specific secure storage be explored later?
- Should the Worker expose a dedicated lightweight `POST /v2/sync/test` endpoint, or is `/health` plus authenticated `/v2/sync/check` enough?
