import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import esbuild from "esbuild";
import { testData } from "./helpers.mjs";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

test("pairing saves a device credential with auto sync disabled", async () => {
  const { Plugin } = await loadMainModule();
  const saved = [];
  const requests = installLifecycleHarness({ confirmed: true, saved });
  const plugin = makePlugin(Plugin);

  await plugin.handlePairingLink({ endpoint: "https://worker.test", code: "PAIR-ME" });

  assert.deepEqual(requests.map(({ method, path }) => `${method} ${path}`), [
    "POST /v2/pairing/exchange",
    "GET /health",
    "GET /v2/setup/check"
  ]);
  assert.equal(requests[0].authorization, undefined, "pairing exchange must remain public");
  assert.equal(requests[1].authorization, undefined, "health check must remain public");
  assert.equal(requests[2].authorization, "Bearer issued-device-token");
  assert.equal(plugin.data.settings.workerUrl, "https://worker.test");
  assert.equal(plugin.data.settings.syncToken, "issued-device-token");
  assert.equal(plugin.data.settings.workerCredentialKind, "device");
  assert.equal(plugin.data.settings.deviceId, "issued-device-id");
  assert.equal(plugin.data.settings.workerAutoSync, false);
  assert.equal(plugin.data.onboarding.initialSyncCompleted, false);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].settings.syncToken, "issued-device-token");
});

test("pairing a public repository revokes the issued credential and saves nothing", async () => {
  const { Plugin } = await loadMainModule();
  const saved = [];
  const requests = installLifecycleHarness({ repositoryPrivate: false, saved });
  const plugin = makePlugin(Plugin);
  const original = structuredClone(plugin.data);

  await plugin.handlePairingLink({ endpoint: "https://worker.test", code: "PAIR-ME" });

  assert.equal(saved.length, 0);
  assert.deepEqual(plugin.data, original);
  assertSelfRevoked(requests);
});

test("cancelling target confirmation revokes the issued credential and saves nothing", async () => {
  const { Plugin } = await loadMainModule();
  const saved = [];
  const requests = installLifecycleHarness({ confirmed: false, saved });
  const plugin = makePlugin(Plugin);
  const original = structuredClone(plugin.data);

  await plugin.handlePairingLink({ endpoint: "https://worker.test", code: "PAIR-ME" });

  assert.equal(saved.length, 0);
  assert.deepEqual(plugin.data, original);
  assertSelfRevoked(requests);
});

test("a post-exchange validation failure revokes the issued credential and saves nothing", async () => {
  const { Plugin } = await loadMainModule();
  const saved = [];
  const requests = installLifecycleHarness({ invalidHealth: true, saved });
  const plugin = makePlugin(Plugin);
  const original = structuredClone(plugin.data);

  await plugin.handlePairingLink({ endpoint: "https://worker.test", code: "PAIR-ME" });

  assert.equal(saved.length, 0);
  assert.deepEqual(plugin.data, original);
  assertSelfRevoked(requests);
});

test("a credential persistence failure rolls back memory and revokes the issued credential", async () => {
  const { Plugin } = await loadMainModule();
  const saved = [];
  const requests = installLifecycleHarness({ confirmed: true, saveError: new Error("disk full"), saved });
  const plugin = makePlugin(Plugin);
  const original = structuredClone(plugin.data);

  await plugin.handlePairingLink({ endpoint: "https://worker.test", code: "PAIR-ME" });

  assert.equal(saved.length, 0);
  assert.deepEqual(plugin.data, original);
  assertSelfRevoked(requests);
});

test("disconnect revokes first, clears connection state, and leaves local notes unchanged", async () => {
  const { Plugin } = await loadMainModule();
  const saved = [];
  const requests = installLifecycleHarness({ confirmed: true, saved });
  const plugin = makePlugin(Plugin, {
    settings: {
      workerCredentialKind: "device",
      workerAutoSync: true
    },
    onboarding: {
      initialSyncCompleted: true,
      mode: "remote",
      preview: {
        mode: "remote",
        localFiles: 0,
        remoteFiles: 1,
        remoteCommitSha: "remote",
        planDigest: "digest",
        counts: { download: 1, deleteLocal: 0, upload: 0, deleteRemote: 0, conflict: 0, unchanged: 0 },
        createdAt: "2026-07-18T00:00:00.000Z"
      }
    }
  });
  plugin.app.vault.files.set("note.md", "keep me");

  assert.equal(await plugin.disconnectCurrentDevice(), true);

  assert.deepEqual(requests.map(({ method, path }) => `${method} ${path}`), ["DELETE /v2/devices/test-device"]);
  assert.equal(plugin.data.settings.workerUrl, "");
  assert.equal(plugin.data.settings.syncToken, "");
  assert.equal(plugin.data.settings.workerCredentialKind, null);
  assert.equal(plugin.data.settings.workerAutoSync, false);
  assert.equal(plugin.data.deviceState, null);
  assert.deepEqual(plugin.data.onboarding, { initialSyncCompleted: false, mode: null, preview: null });
  assert.equal(plugin.app.vault.files.get("note.md"), "keep me");
  assert.equal(saved.length, 1);
});

test("disconnect keeps the credential and onboarding state when remote revocation fails", async () => {
  const { Plugin } = await loadMainModule();
  const saved = [];
  installLifecycleHarness({ confirmed: true, revokeStatus: 503, saved });
  const plugin = makePlugin(Plugin, {
    settings: { workerCredentialKind: "device", workerAutoSync: true },
    onboarding: { initialSyncCompleted: true, mode: null, preview: null }
  });
  const original = structuredClone(plugin.data);

  await assert.rejects(() => plugin.disconnectCurrentDevice(), /revoke failed/);

  assert.deepEqual(plugin.data, original);
  assert.equal(saved.length, 0);
});

let mainModulePromise;

function loadMainModule() {
  mainModulePromise ||= buildMainModule();
  return mainModulePromise;
}

async function buildMainModule() {
  const outdir = path.join(tmpdir(), `vaultbridge-main-tests-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(outdir, { recursive: true });
  const obsidianStubPath = path.join(outdir, "obsidian-stub.mjs");
  const qrcodeStubPath = path.join(outdir, "qrcode-stub.mjs");
  await writeFile(obsidianStubPath, OBSIDIAN_STUB);
  await writeFile(qrcodeStubPath, "export default { toDataURL: async () => 'data:image/png;base64,test' };\n");

  await esbuild.build({
    absWorkingDir: repoRoot,
    entryPoints: { main: "src/main.ts" },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outdir,
    plugins: [{
      name: "obsidian-stub",
      setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: obsidianStubPath }));
        build.onResolve({ filter: /^qrcode$/ }, () => ({ path: qrcodeStubPath }));
      }
    }],
    logLevel: "silent"
  });

  test.after(async () => rm(outdir, { recursive: true, force: true }));
  const loaded = await import(pathToFileURL(path.join(outdir, "main.js")).href);
  return { Plugin: loaded.default };
}

function makePlugin(Plugin, overrides = {}) {
  const app = {
    vault: {
      files: new Map(),
      getName: () => "Mobile vault"
    }
  };
  const plugin = new Plugin(app, {});
  const base = testData();
  plugin.data = {
    ...base,
    ...overrides,
    settings: { ...base.settings, ...(overrides.settings || {}) },
    onboarding: { ...base.onboarding, ...(overrides.onboarding || {}) }
  };
  return plugin;
}

function installLifecycleHarness({
  confirmed = true,
  repositoryPrivate = true,
  invalidHealth = false,
  revokeStatus = 204,
  saveError = null,
  saved = []
} = {}) {
  globalThis.__vaultbridgeModalDecision = confirmed;
  globalThis.__vaultbridgeSaveData = async (data) => {
    if (saveError) throw saveError;
    saved.push(structuredClone(data));
  };
  globalThis.__vaultbridgeNotices = [];
  const requests = [];
  globalThis.__vaultbridgeRequestUrl = async (input) => {
    const url = new URL(input.url);
    requests.push({
      method: input.method,
      path: url.pathname,
      authorization: input.headers?.authorization
    });
    if (url.pathname === "/v2/pairing/exchange") {
      return response({
        token: "issued-device-token",
        device: { id: "issued-device-id", name: "Mobile vault", createdAt: "2026-07-18T00:00:00.000Z" }
      }, 201);
    }
    if (url.pathname === "/health") {
      return response(invalidHealth
        ? { ok: true, service: "not-vaultbridge", protocol: 2 }
        : { ok: true, service: "vaultbridge", protocol: 2 });
    }
    if (url.pathname === "/v2/setup/check") {
      return response({
        ok: true,
        repository: { fullName: "owner/private-notes", private: repositoryPrivate, branch: "main" }
      });
    }
    if (url.pathname === "/v2/devices/issued-device-id" || url.pathname === "/v2/devices/test-device") {
      return response(revokeStatus === 204 ? {} : { error: "revoke_failed", message: "revoke failed" }, revokeStatus);
    }
    throw new Error(`Unexpected request: ${input.method} ${url.pathname}`);
  };
  return requests;
}

function assertSelfRevoked(requests) {
  const revoke = requests.at(-1);
  assert.deepEqual(
    { method: revoke.method, path: revoke.path, authorization: revoke.authorization },
    { method: "DELETE", path: "/v2/devices/issued-device-id", authorization: "Bearer issued-device-token" }
  );
}

function response(body, status = 200) {
  const text = JSON.stringify(body);
  return { status, headers: {}, arrayBuffer: new TextEncoder().encode(text).buffer, json: body, text };
}

const OBSIDIAN_STUB = `
export class Plugin {
  constructor(app) { this.app = app; }
  async saveData(data) { return globalThis.__vaultbridgeSaveData(data); }
}
export class Modal {
  constructor(app) { this.app = app; this.contentEl = new Element(); }
  setTitle() {}
  open() { this.onOpen(); }
  close() { this.onClose(); }
}
class Element {
  createEl() { return new Element(); }
  createDiv() { return new Element(); }
  createSpan() { return new Element(); }
  empty() {}
}
export class Setting {
  constructor() {}
  setName() { return this; }
  setDesc() { return this; }
  addButton(configure) {
    const button = new Button();
    configure(button);
    const chooseConfirm = globalThis.__vaultbridgeModalDecision !== false;
    if ((chooseConfirm && button.text !== "Cancel") || (!chooseConfirm && button.text === "Cancel")) button.click();
    return this;
  }
  addToggle() { return this; }
  addText() { return this; }
  addDropdown() { return this; }
}
class Button {
  setButtonText(text) { this.text = text; return this; }
  setCta() { return this; }
  onClick(click) { this.click = click; return this; }
}
export class PluginSettingTab {}
export class Notice {
  constructor(message, timeout) {
    globalThis.__vaultbridgeNotices.push({ message, timeout });
  }
}
export class FileManager {}
export class TFile {}
export class TFolder {}
export class Vault {}
export const Platform = { isDesktopApp: false };
export function requestUrl(input) { return globalThis.__vaultbridgeRequestUrl(input); }
export function normalizePath(input) { return input.split("/").filter(Boolean).join("/"); }
`;
