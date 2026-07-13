import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import esbuild from "esbuild";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

test("scanVault hashes every file on a cold scan", async () => {
  const { scanVault } = await loadScanner();
  const vault = fakeVault([
    fakeFile("a.md", "alpha", 1000),
    fakeFile("b.md", "beta", 2000)
  ]);

  const scan = await scanVault(vault, testSettings());

  assert.equal(vault.readCount(), 2);
  assert.equal(scan.manifest["a.md"].sha256, sha256("alpha"));
  assert.equal(scan.hashCache["b.md"].mtime, 2000);
  assert.equal(scan.hashCache["b.md"].sha256, sha256("beta"));
});

test("scanVault reuses cached hashes when mtime and size match", async () => {
  const { scanVault } = await loadScanner();
  const vault = fakeVault([
    fakeFile("a.md", "alpha", 1000),
    fakeFile("b.md", "beta", 2000)
  ]);

  const first = await scanVault(vault, testSettings());
  const second = await scanVault(vault, testSettings(), first.hashCache);

  assert.equal(vault.readCount(), 2, "second scan should not read any file");
  assert.deepEqual(second.manifest, first.manifest);
});

test("scanVault rehashes files whose mtime or size changed", async () => {
  const { scanVault } = await loadScanner();
  const fileA = fakeFile("a.md", "alpha", 1000);
  const fileB = fakeFile("b.md", "beta", 2000);
  const vault = fakeVault([fileA, fileB]);

  const first = await scanVault(vault, testSettings());
  fileA.setContent("alpha changed", 1500);

  const second = await scanVault(vault, testSettings(), first.hashCache);

  assert.equal(vault.readCount(), 3, "only the changed file is re-read");
  assert.equal(second.manifest["a.md"].sha256, sha256("alpha changed"));
  assert.equal(second.hashCache["a.md"].mtime, 1500);
  assert.equal(second.manifest["b.md"].sha256, sha256("beta"));
});

test("scanVault drops cache entries for files that disappeared", async () => {
  const { scanVault } = await loadScanner();
  const files = [fakeFile("a.md", "alpha", 1000), fakeFile("b.md", "beta", 2000)];
  const vault = fakeVault(files);

  const first = await scanVault(vault, testSettings());
  files.pop();
  const second = await scanVault(vault, testSettings(), first.hashCache);

  assert.equal("b.md" in second.hashCache, false);
  assert.equal("b.md" in second.manifest, false);
});

test("scanVault skips oversized files instead of failing", async () => {
  const { scanVault } = await loadScanner();
  const vault = fakeVault([
    fakeFile("a.md", "alpha", 1000),
    fakeFile("big.bin", "x".repeat(64), 2000)
  ]);

  const scan = await scanVault(vault, testSettings({ maxFileBytes: 32 }));

  assert.deepEqual(Object.keys(scan.manifest), ["a.md"]);
  assert.deepEqual(scan.oversized, ["big.bin"]);
  assert.ok(scan.skipped.includes("big.bin"));
  assert.equal("big.bin" in scan.hashCache, false);
});

test("scanVault does not cache excluded files", async () => {
  const { scanVault } = await loadScanner();
  const vault = fakeVault([
    fakeFile("a.md", "alpha", 1000),
    fakeFile(".git/config", "git", 1000),
    fakeFile("note.remote-conflict-20260101-000000.md", "copy", 1000)
  ]);

  const scan = await scanVault(vault, testSettings());

  assert.deepEqual(Object.keys(scan.manifest), ["a.md"]);
  assert.deepEqual(Object.keys(scan.hashCache), ["a.md"]);
  assert.equal(scan.skipped.length, 2);
});

let scannerModulePromise = null;

function loadScanner() {
  scannerModulePromise = scannerModulePromise || buildScannerModule();
  return scannerModulePromise;
}

async function buildScannerModule() {
  const outdir = path.join(tmpdir(), `vaultbridge-scanner-tests-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(outdir, { recursive: true });
  const obsidianStubPath = path.join(outdir, "obsidian-stub.mjs");
  await writeFile(obsidianStubPath, [
    "export class TFile {}",
    "export class TFolder {}",
    "export class PluginSettingTab {}",
    "export class Setting {",
    "  constructor() {}",
    "  setName() { return this; }",
    "  setDesc() { return this; }",
    "  addButton() { return this; }",
    "  addToggle() { return this; }",
    "  addText() { return this; }",
    "  addDropdown() { return this; }",
    "}",
    "export class Notice { constructor() {} }",
    "export const Platform = { isDesktopApp: false };",
    "export function normalizePath(input) { return input.split('/').filter(Boolean).join('/'); }"
  ].join("\n"));

  await esbuild.build({
    absWorkingDir: repoRoot,
    entryPoints: { vaultScanner: "src/vaultScanner.ts" },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outdir,
    plugins: [{
      name: "obsidian-stub",
      setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: obsidianStubPath }));
      }
    }],
    logLevel: "silent"
  });

  test.after(async () => {
    await rm(outdir, { recursive: true, force: true });
  });

  return await import(pathToFileURL(path.join(outdir, "vaultScanner.js")).href);
}

function fakeFile(filePath, content, mtime) {
  let bytes = Buffer.from(content, "utf8");
  const file = {
    path: filePath,
    stat: { size: bytes.byteLength, mtime },
    bytes: () => bytes,
    setContent(next, nextMtime) {
      bytes = Buffer.from(next, "utf8");
      file.stat = { size: bytes.byteLength, mtime: nextMtime };
    }
  };
  return file;
}

function fakeVault(files) {
  let reads = 0;
  return {
    getFiles: () => files,
    async readBinary(file) {
      reads += 1;
      const bytes = file.bytes();
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    readCount: () => reads
  };
}

function testSettings(overrides = {}) {
  return {
    workerUrl: "https://worker.test",
    syncToken: "sync-token",
    deviceId: "test-device",
    localPrefix: "",
    remotePrefix: "",
    maxFileBytes: 20 * 1024 * 1024,
    excludePatterns: [".git/", ".vaultbridge/", ".DS_Store"],
    ...overrides
  };
}

function sha256(content) {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}
