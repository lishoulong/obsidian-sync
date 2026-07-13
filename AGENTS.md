# Project Contract

## Architecture Decisions

- This repository is a pnpm monorepo with the Obsidian plugin in `apps/obsidian-plugin` and the Cloudflare Worker in `apps/worker`.
- Desktop Obsidian uses local Git by default. Mobile Obsidian uses Worker Protocol v2 because native Git is not a reliable mobile dependency.
- The Worker owns GitHub credentials and Git object/ref operations. The plugin must not store a GitHub token or call GitHub directly.
- Protocol v2 is the compatibility boundary between the plugin and Worker. Keep `docs/protocol-v2.md` synchronized with both implementations.
- iOS Shortcuts are not a supported client and must not be reintroduced without an explicit architecture decision.

## Verification

Run `pnpm verify` from the repository root. Plugin release-specific instructions are in `apps/obsidian-plugin/AGENTS.md`.
