# VaultBridge Sync

VaultBridge Sync is an Obsidian plugin that syncs the current vault through the VaultBridge Cloudflare Worker Protocol v2.

It is intentionally not a full Git plugin. The plugin reads and writes vault files through Obsidian APIs, while the Worker owns GitHub blob, tree, commit, and branch operations.

## Development

Install dependencies:

```bash
npm install
```

Build once:

```bash
npm run build
```

Watch during development:

```bash
npm run dev
```

## Desktop Obsidian test install

1. Build the plugin with `npm run build`.
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
- `Pull before desktop push`
- `Files to commit`, for example `vault/` when notes live under a `vault` folder

Worker settings are hidden on desktop by default. Enable `Enable Worker sync on desktop` only when you intentionally want to run the mobile-style Worker sync workflow from a desktop vault.

On Obsidian mobile, VaultBridge Sync uses the Cloudflare Worker protocol and requires:

- Worker URL, for example `https://vaultbridge.example.workers.dev`
- `SYNC_TOKEN` configured on the Worker
- Stable device ID, for example `fred-iphone`

The plugin stores compact device state in Obsidian plugin data, not in the synced vault.

`Test connection` checks the Worker health, authenticates with `SYNC_TOKEN`, and verifies that the self-hosted Worker can access its configured GitHub repository and branch.

For self-hosted use, deploy the VaultBridge Worker against your own GitHub repository, then copy the Worker URL and `SYNC_TOKEN` into this plugin. The plugin never stores a GitHub token.

## Desktop Git autosync

On Obsidian desktop, the plugin can commit and push local vault changes with the local `git` command. Automatic Git push is disabled by default. When enabled, vault file changes are debounced and pushed after the configured idle delay. Before pushing, the plugin can run `git pull --rebase --autostash`.

If Git reports a rebase, merge, or push conflict, the plugin records a pending desktop Git conflict, pauses automatic Git push, and leaves the Git working tree for manual resolution. After resolving the files, run the `Continue desktop Git conflict` command or use the settings button to continue the rebase/merge and push. It does not auto-merge conflicts.

On mobile, conflicts reported by the Worker are handled separately: the plugin keeps the local file unchanged, writes the remote version as a sibling `.remote-conflict-...` file, and stops before pushing. After you merge the content and delete the conflict copy, the next sync treats the local file as the resolved version and pushes it instead of recreating the same conflict copy.
