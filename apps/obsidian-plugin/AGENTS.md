# Agent Notes

## Release Checklist

BRAT updates this plugin from GitHub Releases, not only from the latest `main` commit. When shipping a user-visible plugin change:

1. Bump the version in all of these files:
   - `apps/obsidian-plugin/manifest.json`
   - `apps/obsidian-plugin/package.json`
   - `pnpm-lock.yaml`
2. Run the full local verification:
   - `pnpm --filter @vaultbridge/obsidian-plugin check`
   - `pnpm --filter @vaultbridge/obsidian-plugin build`
   - `pnpm --filter @vaultbridge/obsidian-plugin test`
3. Commit and push the change to `origin/main`.
4. Create a matching GitHub Release tag, for example `v0.1.21`.
5. Upload the BRAT-required release assets:
   - `main.js`
   - `manifest.json`
   - `styles.css`
6. Verify the release exists and contains the expected assets:
   - `gh release view vX.Y.Z --repo lishoulong/obsidian-sync --json tagName,name,assets,targetCommitish,url`

Useful command:

```bash
gh release create vX.Y.Z apps/obsidian-plugin/main.js apps/obsidian-plugin/manifest.json apps/obsidian-plugin/styles.css \
  --repo lishoulong/obsidian-sync \
  --target main \
  --title "VaultBridge Sync X.Y.Z" \
  --notes "Release notes here."
```

If BRAT still reports no update, first check whether the latest GitHub Release, not just `main`, has the new `manifest.json` version.
