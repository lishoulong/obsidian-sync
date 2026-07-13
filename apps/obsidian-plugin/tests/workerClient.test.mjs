import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import esbuild from "esbuild";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

test("syncCheck retries transient network failures", async () => {
  const { WorkerClient } = await loadWorkerClient();
  let calls = 0;
  installFetch(async () => {
    calls += 1;
    if (calls < 3) throw new TypeError("fetch failed");
    return jsonResponse({ protocol: 2, remoteCommitSha: "abc" });
  });

  const client = new WorkerClient(testSettings(), [1, 1, 1]);
  const plan = await client.syncCheck("device", null, {});

  assert.equal(calls, 3);
  assert.equal(plan.remoteCommitSha, "abc");
});

test("syncCheck retries retryable HTTP statuses", async () => {
  const { WorkerClient } = await loadWorkerClient();
  let calls = 0;
  installFetch(async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ error: "upstream", message: "bad gateway" }, 502);
    return jsonResponse({ protocol: 2, remoteCommitSha: "abc" });
  });

  const client = new WorkerClient(testSettings(), [1, 1, 1]);
  const plan = await client.syncCheck("device", null, {});

  assert.equal(calls, 2);
  assert.equal(plan.remoteCommitSha, "abc");
});

test("syncCheck does not retry authentication failures", async () => {
  const { WorkerClient } = await loadWorkerClient();
  let calls = 0;
  installFetch(async () => {
    calls += 1;
    return jsonResponse({ error: "unauthorized", message: "bad token" }, 401);
  });

  const client = new WorkerClient(testSettings(), [1, 1, 1]);
  await assert.rejects(() => client.syncCheck("device", null, {}), /bad token/);
  assert.equal(calls, 1);
});

test("syncCheck surfaces the last error after retries are exhausted", async () => {
  const { WorkerClient } = await loadWorkerClient();
  let calls = 0;
  installFetch(async () => {
    calls += 1;
    throw new TypeError("fetch failed");
  });

  const client = new WorkerClient(testSettings(), [1, 1]);
  await assert.rejects(() => client.syncCheck("device", null, {}), /fetch failed/);
  assert.equal(calls, 3);
});

test("commit never retries", async () => {
  const { WorkerClient } = await loadWorkerClient();
  let calls = 0;
  installFetch(async () => {
    calls += 1;
    throw new TypeError("fetch failed");
  });

  const client = new WorkerClient(testSettings(), [1, 1, 1]);
  await assert.rejects(() => client.commit({
    deviceId: "device",
    sessionToken: "session",
    message: "msg",
    patch: { upload: {}, delete: [] },
    blobs: []
  }), /fetch failed/);
  assert.equal(calls, 1);
});

let workerClientModulePromise = null;

function loadWorkerClient() {
  workerClientModulePromise = workerClientModulePromise || buildWorkerClientModule();
  return workerClientModulePromise;
}

async function buildWorkerClientModule() {
  const outdir = path.join(tmpdir(), `vaultbridge-workerclient-tests-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    entryPoints: { workerClient: "src/workerClient.ts" },
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

  return await import(pathToFileURL(path.join(outdir, "workerClient.js")).href);
}

function installFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  test.after(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(body, status = 200) {
  return {
    status,
    async text() {
      return JSON.stringify(body);
    }
  };
}

function testSettings(overrides = {}) {
  return {
    workerUrl: "https://worker.test",
    syncToken: "sync-token",
    deviceId: "test-device",
    localPrefix: "",
    remotePrefix: "",
    ...overrides
  };
}
