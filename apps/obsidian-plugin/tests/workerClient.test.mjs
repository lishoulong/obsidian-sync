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
  installRequestUrl(async () => {
    calls += 1;
    if (calls < 3) throw new TypeError("fetch failed");
    return jsonRequestResponse({ protocol: 2, remoteCommitSha: "abc" });
  });

  const client = new WorkerClient(testSettings(), [1, 1, 1]);
  const plan = await client.syncCheck("device", null, {});

  assert.equal(calls, 3);
  assert.equal(plan.remoteCommitSha, "abc");
});

test("syncCheck retries retryable HTTP statuses", async () => {
  const { WorkerClient } = await loadWorkerClient();
  let calls = 0;
  installRequestUrl(async () => {
    calls += 1;
    if (calls === 1) return jsonRequestResponse({ error: "upstream", message: "bad gateway" }, 502);
    return jsonRequestResponse({ protocol: 2, remoteCommitSha: "abc" });
  });

  const client = new WorkerClient(testSettings(), [1, 1, 1]);
  const plan = await client.syncCheck("device", null, {});

  assert.equal(calls, 2);
  assert.equal(plan.remoteCommitSha, "abc");
});

test("syncCheck does not retry authentication failures", async () => {
  const { WorkerClient } = await loadWorkerClient();
  let calls = 0;
  installRequestUrl(async () => {
    calls += 1;
    return jsonRequestResponse({ error: "unauthorized", message: "bad token" }, 401);
  });

  const client = new WorkerClient(testSettings(), [1, 1, 1]);
  await assert.rejects(() => client.syncCheck("device", null, {}), /bad token/);
  assert.equal(calls, 1);
});

test("syncCheck surfaces the last error after retries are exhausted", async () => {
  const { WorkerClient } = await loadWorkerClient();
  let calls = 0;
  installRequestUrl(async () => {
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
  installRequestUrl(async () => {
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

test("syncCheck sends authenticated JSON through Obsidian requestUrl", async () => {
  const { WorkerClient } = await loadWorkerClient();
  let request;
  installRequestUrl(async (input) => {
    request = input;
    return jsonRequestResponse({ protocol: 2, remoteCommitSha: "abc" });
  });

  const client = new WorkerClient(testSettings(), []);
  await client.syncCheck("device", "base", { "note.md": { size: 4, sha256: "hash" } });

  assert.equal(request.url, "https://worker.test/v2/sync/check");
  assert.equal(request.method, "POST");
  assert.equal(request.headers.authorization, "Bearer sync-token");
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.throw, false);
  assert.deepEqual(JSON.parse(request.body), {
    deviceId: "device",
    lastSyncedCommitSha: "base",
    files: { "note.md": { size: 4, sha256: "hash" } }
  });
});

test("syncCheck times out stalled requestUrl calls", async () => {
  const { WorkerClient } = await loadWorkerClient();
  installRequestUrl(() => new Promise(() => {}));

  const client = new WorkerClient(testSettings(), [], 5);
  await assert.rejects(() => client.syncCheck("device", null, {}), /timed out/);
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
    "export function requestUrl(input) { return globalThis.__vaultbridgeRequestUrl(input); }",
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

function installRequestUrl(handler) {
  const original = globalThis.__vaultbridgeRequestUrl;
  globalThis.__vaultbridgeRequestUrl = handler;
  test.after(() => {
    globalThis.__vaultbridgeRequestUrl = original;
  });
}

function jsonRequestResponse(body, status = 200) {
  return {
    status,
    headers: {},
    arrayBuffer: new ArrayBuffer(0),
    json: body,
    text: JSON.stringify(body)
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
