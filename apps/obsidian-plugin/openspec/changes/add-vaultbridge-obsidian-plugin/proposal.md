## Why

Shortcut-based sync is expensive to build, hard to maintain, and awkward to run from the Obsidian writing workflow. A dedicated Obsidian plugin can provide an in-vault "sync now" experience on mobile while reusing the existing VaultBridge Worker Protocol v2 for GitHub operations instead of trying to run a full Git client on iOS.

Existing desktop Git plugins do not directly solve the mobile problem because iOS Obsidian plugins cannot rely on native `git`, SSH agents, or desktop credential helpers. This change focuses on the actual product need: reliable one-click vault synchronization through the already deployed Worker.

## What Changes

- Add an Obsidian plugin project for `vaultbridge-sync`.
- Provide a mobile-compatible manual sync command inside Obsidian.
- Add plugin settings for Worker URL, sync token, device identity, and basic sync preferences.
- Scan the current Obsidian vault and build the Protocol v2 file manifest required by the Worker.
- Use the existing Worker endpoints:
  - `POST /v2/sync/check`
  - `POST /v2/pull/file`
  - `POST /v2/blob`
  - `POST /v2/commit`
- Apply the Worker sync plan to the local vault: downloads, local deletions, uploads, remote deletions, and conflicts.
- Preserve the current conflict policy: never auto-merge or overwrite a true conflict; write remote conflict copies beside local files and stop before push.
- Store compact device state in plugin data rather than inside the synced vault.
- Keep the plugin scoped to VaultBridge Protocol v2 sync; do not implement a full Git client.

## Capabilities

### New Capabilities

- `plugin-configuration`: Configure and persist Worker connection settings, sync token, device identity, and device sync state.
- `vault-manifest-scan`: Build a mobile-compatible manifest of vault files using Obsidian APIs and safe exclusion rules.
- `worker-protocol-sync`: Execute the VaultBridge Protocol v2 sync workflow against the Cloudflare Worker.
- `sync-conflict-safety`: Handle conflicts and destructive operations without silently losing user content.
- `obsidian-sync-ui`: Expose sync controls, status feedback, and errors inside Obsidian.

### Modified Capabilities

- None. This repository has no existing OpenSpec capabilities yet.

## Impact

- A new Obsidian plugin codebase will be added under this repository.
- The plugin will depend on the Obsidian plugin API and a TypeScript build toolchain.
- The plugin relies on the Cloudflare Worker in the same monorepo under `apps/worker` and the shared Protocol v2 contract in `docs/protocol-v2.md`.
- The Worker API is not expected to require a breaking change for the initial plugin MVP.
- Mobile behavior must avoid Node-only and Electron-only APIs so the plugin can run in Obsidian iOS.
- The first release targets manual synchronization; background sync and full Git features are explicitly out of scope.
