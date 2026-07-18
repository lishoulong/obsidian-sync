# VaultBridge Worker

Cloudflare Worker service for VaultBridge Protocol v2. Wrangler uses `src/index.ts` as the stable entry point and automatically transpiles TypeScript and bundles its ES module dependency graph for deployment; no separate Rollup or esbuild configuration is required.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lishoulong/obsidian-sync/tree/main/apps/worker)

The Worker is self-hosted per user. It connects one private GitHub notes repository and stores one-time pairing codes plus revocable device credential hashes in the `DB` D1 binding. It never stores note content in D1.

## Source layout

- `index.ts`: stable Wrangler entry point
- `worker.ts`: routing, health response, authentication boundary, and error envelope
- `handlers/v2.ts`: Protocol v2 request orchestration
- `handlers/v1.ts`: temporary Protocol v1 compatibility adapter
- `sync-plan.ts`: pure three-way comparison logic
- `manifest.ts`: manifest and Git tree reads/writes
- `session.ts`: signed sync sessions
- `github.ts`: GitHub REST client
- `validation.ts`: request normalization and validation
- `paths.ts`: user and internal path rules
- `config.ts`: repository and size configuration
- `auth.ts`: bearer-token authentication
- `pairing.ts`: one-time pairing codes and revocable device credentials
- `encoding.ts`: Base64 and SHA-256 helpers
- `http.ts`: JSON responses and HTTP errors
- `observability.ts`: request context and structured logs
- `constants.ts`: shared protocol constants

## Commands

From the monorepo root:

```bash
pnpm --filter @vaultbridge/worker check
pnpm --filter @vaultbridge/worker test
pnpm --filter @vaultbridge/worker build
```

`check` runs the TypeScript compiler in no-emit mode so type errors fail before deployment. Tests are written in TypeScript and run directly with `tsx`. The build command runs `wrangler deploy --dry-run`; Wrangler transpiles and bundles the TypeScript modules and writes only ignored temporary output under `.wrangler/`. Production deployment continues to use `pnpm deploy:worker`.

From the monorepo root, `pnpm deploy:worker` deploys this package. In the
standalone repository created by Deploy to Cloudflare, use `npm run deploy` (or
`pnpm deploy`); Cloudflare replaces the public all-zero D1 placeholder with the
database it provisions. For an existing or manual deployment, create the
database with `pnpm exec wrangler d1 create vaultbridge`, export its ID as
`D1_DATABASE_ID`, then deploy. The script writes an ignored temporary config,
applies D1 migrations, deploys, and deletes the temporary file, so a personal
database ID is never committed to the public template. Set `GITHUB_TOKEN` and
`SYNC_TOKEN` as Worker secrets.
