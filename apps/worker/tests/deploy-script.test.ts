import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(packageRoot, "scripts/deploy.mjs");

test("deployment fails before Wrangler when a production D1 ID is missing", () => {
  const env = { ...process.env };
  delete env.D1_DATABASE_ID;
  const result = spawnSync(process.execPath, [scriptPath, "--check-only"], {
    cwd: packageRoot,
    env,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /D1_DATABASE_ID is missing or invalid/);
});

test("deployment accepts an injected D1 ID and removes its temporary config", async () => {
  const result = spawnSync(process.execPath, [scriptPath, "--check-only"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      D1_DATABASE_ID: "11111111-1111-4111-8111-111111111111",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Using D1 database/);
  const leftovers = (await readdir(packageRoot)).filter((name) =>
    name.startsWith(".wrangler.deploy."),
  );
  assert.deepEqual(leftovers, []);
});
