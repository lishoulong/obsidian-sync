import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import esbuild from "esbuild";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

test("pairing QR is generated locally as an SVG data URL", async () => {
  const outdir = path.join(tmpdir(), `vaultbridge-qr-tests-${process.pid}-${Date.now()}`);
  await mkdir(outdir, { recursive: true });
  test.after(async () => rm(outdir, { recursive: true, force: true }));
  await esbuild.build({
    absWorkingDir: repoRoot,
    entryPoints: { pairingQr: "src/pairingQr.ts" },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "node20",
    outdir,
    logLevel: "silent"
  });
  const { createPairingQrDataUrl } = await import(pathToFileURL(path.join(outdir, "pairingQr.js")).href);

  const result = await createPairingQrDataUrl(
    "obsidian://vaultbridge-connect?endpoint=https%3A%2F%2Fworker.test&code=ABC123"
  );

  assert.match(result, /^data:image\/svg\+xml;charset=utf-8,/);
  assert.match(decodeURIComponent(result.split(",", 2)[1]), /<svg/);
  assert.ok(result.length > 500, "generated QR should contain non-empty SVG data");
});
