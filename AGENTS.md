# Agent Notes

## Release Checklist

BRAT updates this plugin from GitHub Releases, not only from the latest `main` commit. When shipping a user-visible plugin change:

1. Bump the version in all of these files:
   - `manifest.json`
   - `package.json`
   - `package-lock.json`
2. Run the full local verification:
   - `npm run check`
   - `npm run build`
   - `npm test`
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
gh release create vX.Y.Z main.js manifest.json styles.css \
  --repo lishoulong/obsidian-sync \
  --target main \
  --title "VaultBridge Sync X.Y.Z" \
  --notes "Release notes here."
```

If BRAT still reports no update, first check whether the latest GitHub Release, not just `main`, has the new `manifest.json` version.
