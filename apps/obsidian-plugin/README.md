# VaultBridge Sync

VaultBridge Sync is an Obsidian plugin that syncs the current vault through the VaultBridge Cloudflare Worker Protocol v2.

It is intentionally not a full Git plugin. The plugin reads and writes vault files through Obsidian APIs, while the Worker owns GitHub blob, tree, commit, and branch operations.

## Install with BRAT

Add the repository root to BRAT:

```text
https://github.com/lishoulong/obsidian-sync
```

Do not use the monorepo subdirectory URL ending in `/tree/main/apps/obsidian-plugin`. BRAT installs and updates the plugin from the `main.js`, `manifest.json`, and `styles.css` assets attached to the latest GitHub Release.

## Development

Install dependencies:

```bash
pnpm install
```

Build once:

```bash
pnpm build
```

Watch during development:

```bash
pnpm dev
```

## Desktop Obsidian test install

1. Build the plugin with `pnpm build`.
2. Create a plugin folder in a test vault:

```text
<vault>/.obsidian/plugins/vaultbridge-sync/
```

3. Copy these files into that folder:

```text
manifest.json
main.js
styles.css
```

4. Reload Obsidian and enable "VaultBridge Sync" from Community plugins.

## Mobile testing

Obsidian Mobile can load community plugins from the vault's `.obsidian/plugins/` folder. For iOS testing, first verify the plugin in a throwaway vault, then sync or copy the built plugin folder to the mobile vault.

The plugin is designed with `isDesktopOnly: false` and avoids native Git, Node filesystem APIs, and Electron APIs.

## Configuration

Desktop and mobile use different sync paths by default.

On Obsidian desktop, VaultBridge Sync uses the local `git` command. You normally only need:

- `Git commit and push`
- `Automatic desktop Git push`
- `Auto Git idle delay`
- `Automatic desktop Git pull` and `Auto Git pull interval`
- `Pull before desktop push`
- `Files to commit`, for example `vault/` when notes live under a `vault` folder

Worker connection and mobile-device management remain available on desktop. Enable `Enable Worker sync on desktop` only when you intentionally want the desktop vault itself to run the mobile-style Worker sync or initial migration; desktop notes otherwise continue to use local Git.

On Obsidian mobile, VaultBridge Sync uses the Cloudflare Worker protocol and requires either:

- a one-time pairing link opened after this plugin is installed and enabled in
  the target vault; or
- a Worker URL plus the administrator `SYNC_TOKEN` for the first managing
  device.

The plugin generates and stores an internal per-device ID plus compact sync state in Obsidian plugin data, not in the synced vault. Users normally do not need to edit the device ID. A manually configured first device can create a five-minute pairing QR; the mobile plugin exchanges it for an independent, revocable device token without putting the Worker `SYNC_TOKEN` in the link.

`Test connection` checks Worker health, authentication, D1 pairing readiness,
repository, branch, and file-size limit. A paired device can use **Disconnect
this device** to revoke its own credential without deleting local notes.

For self-hosted use, follow the [Worker deployment guide](../../docs/self-host.zh-CN.md), then copy the Worker URL and `SYNC_TOKEN` into this plugin. The plugin never stores a GitHub token.

Cloudflare Worker secrets cannot be read back after they are set. Enter the same `SYNC_TOKEN` value in the Worker configuration and the plugin settings before testing the connection.

## First sync and automatic sync

New devices must choose and preview one of three first-sync modes before any files move: GitHub as the source requires an empty local notes folder, this device as the source requires an empty remote notes folder, and safe merge preserves the conservative conflict behavior. The plugin rechecks that the preview has not changed before it starts.

Automatic sync remains disabled until the reviewed first sync succeeds. It then runs when the app opens, when it returns to the foreground, after a debounced idle delay following edits, and on a configurable interval. Automatic runs are quiet — a no-op sync shows nothing, a successful sync shows a short summary, and repeated identical conflicts or errors notify only once. Disable the toggle to sync manually only.

Sync progress (per-file download/upload counters) is shown in a live notice and, on desktop, in the status bar; the status bar also shows the last sync outcome while idle. A running sync can be stopped with the `Cancel running sync` command.

Files larger than the sync size limit are skipped with a warning instead of failing the sync. If a sync would delete more files than the `Delete guard threshold` (default 20), it stops and asks you to confirm with the `Approve large delete for next sync` command. Use `Show pending conflicts` to list recorded conflicts and jump to the affected notes and conflict copies.

## Desktop Git autosync

On Obsidian desktop, the plugin can commit and push local vault changes with the local `git` command. Automatic Git push is disabled by default. When enabled, vault file changes are debounced and pushed after the configured idle delay. Before pushing, the plugin can run `git pull --rebase --autostash`.

Automatic desktop Git pull is enabled by default: the plugin pulls with `git pull --rebase --autostash` on startup, when the window regains focus, and on the configured interval, so changes pushed from mobile appear without waiting for a local edit. Auto pull silently disables itself for the session when the vault is not inside a Git repository. A manual `Desktop Git pull` command is also available.

If Git reports a rebase, merge, or push conflict, the plugin records a pending desktop Git conflict, pauses automatic Git push, and leaves the Git working tree for manual resolution. After resolving the files, run the `Continue desktop Git conflict` command or use the settings button to continue the rebase/merge and push.

When `Auto Merge Conflict` is enabled, the `Auto merge desktop Git conflict` command (or the settings button) resolves conflicted text files with the configured model: the local and remote sides are merged semantically, staged, and the rebase/merge continues and pushes once everything resolves. In `Apply locally` mode this also runs automatically when auto pull or auto push hits a conflict. Unsupported, oversized, or low-confidence files are left for manual resolution.

On mobile, conflicts reported by the Worker are handled separately: the plugin keeps the local file unchanged, writes the remote version as a sibling `.remote-conflict-...` file, and stops before pushing. After you merge the content and delete the conflict copy, the next sync treats the local file as the resolved version and pushes it instead of recreating the same conflict copy.

### Auto Merge Conflict

`Auto Merge Conflict` is an advanced Worker sync option for text conflicts. When enabled, the plugin sends the local and remote conflicted file contents to DeepSeek through its OpenAI-compatible API and asks the model to produce a semantic merge. Enter a DeepSeek API key, then choose a model such as `deepseek-v4-flash` or `deepseek-v4-pro`. The DeepSeek base URL, merge file-size limit, and apply confidence threshold use built-in defaults.

The default mode is `Suggest only`: the plugin creates an excluded sibling `.auto-merge-proposal-...` file, still writes the normal `.remote-conflict-...` copy, and stops before pushing. Review the proposal, merge anything you want into the original file, delete the conflict copy, then sync again.

`Apply locally` is stricter and only writes high-confidence model results back to the original file. Before writing, the plugin creates an excluded `.local-before-auto-merge-...` backup, verifies that the local file has not changed since the sync plan was created, records the conflict as resolved, re-plans, and continues sync. Unsupported files, large files, missing model settings, low confidence, or model warnings fall back to the normal manual conflict flow.
