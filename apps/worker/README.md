# VaultBridge Worker

Cloudflare Worker service for VaultBridge Protocol v2. Wrangler uses `src/index.ts` as the stable entry point and automatically transpiles TypeScript and bundles its ES module dependency graph for deployment; no separate Rollup or esbuild configuration is required.

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
