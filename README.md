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

The plugin requires:

- Worker URL, for example `https://vaultbridge.open-proxy.workers.dev`
- `SYNC_TOKEN` configured on the Worker
- Stable device ID, for example `fred-iphone`

The plugin stores compact device state in Obsidian plugin data, not in the synced vault.

## Desktop Git autosync

On Obsidian desktop, the plugin can commit and push local vault changes with the local `git` command. Automatic Git push is disabled by default. When enabled, vault file changes are debounced and pushed after the configured idle delay. Before pushing, the plugin can run `git pull --rebase --autostash`.

If Git reports a rebase, merge, or push conflict, the plugin stops and leaves the Git working tree for manual resolution. It does not auto-merge conflicts.

On mobile, conflicts reported by the Worker are handled separately: the plugin keeps the local file unchanged, writes the remote version as a sibling `.remote-conflict-...` file, and stops before pushing.
