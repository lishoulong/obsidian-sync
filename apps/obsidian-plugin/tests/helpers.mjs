import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import esbuild from "esbuild";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

export async function buildTestModules() {
  const outdir = path.join(tmpdir(), `vaultbridge-tests-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    "export class Notice { constructor(message, timeout) { globalThis.__vaultbridgeNotices = globalThis.__vaultbridgeNotices || []; globalThis.__vaultbridgeNotices.push({ message, timeout }); } }",
    "export const Platform = { isDesktopApp: false };",
    "export function requestUrl(input) { return globalThis.__vaultbridgeRequestUrl(input); }",
    "export function normalizePath(input) { return input.split('/').filter(Boolean).join('/'); }"
  ].join("\n"));

  const plugin = {
    name: "obsidian-stub",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: obsidianStubPath }));
    }
  };

  await esbuild.build({
    absWorkingDir: repoRoot,
    entryPoints: {
      autoMerge: "src/autoMerge.ts",
      syncEngine: "src/syncEngine.ts"
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outdir,
    plugins: [plugin],
    logLevel: "silent"
  });

  test.after(async () => {
    await rm(outdir, { recursive: true, force: true });
  });

  return {
    autoMerge: path.join(outdir, "autoMerge.js"),
    syncEngine: path.join(outdir, "syncEngine.js")
  };
}

export class MemoryVault {
  constructor(files) {
    this.files = new Map();
    this.folders = new Set();
    this.adapter = {
      writeBinary: async (filePath, content) => {
        this.writeBytes(filePath, new Uint8Array(content));
      },
      readBinary: async (filePath) => this.readBytes(filePath),
      stat: async (filePath) => {
        if (this.files.has(filePath)) return { type: "file", size: this.files.get(filePath).byteLength };
        if (this.folders.has(filePath)) return { type: "folder" };
        return null;
      },
      mkdir: async (folderPath) => {
        this.folders.add(folderPath);
      }
    };

    for (const [filePath, text] of Object.entries(files)) {
      this.writeText(filePath, text);
    }
  }

  getFiles() {
    return [...this.files.entries()].map(([filePath, bytes]) => this.fileObject(filePath, bytes));
  }

  getFileByPath(filePath) {
    const bytes = this.files.get(filePath);
    return bytes ? this.fileObject(filePath, bytes) : null;
  }

  getAbstractFileByPath(filePath) {
    return this.getFileByPath(filePath);
  }

  async readBinary(file) {
    return this.readBytes(file.path);
  }

  async modifyBinary(file, content) {
    this.writeBytes(file.path, new Uint8Array(content));
  }

  paths() {
    return [...this.files.keys()].sort();
  }

  readText(filePath) {
    return new TextDecoder().decode(this.readBytes(filePath));
  }

  writeText(filePath, text) {
    this.writeBytes(filePath, new TextEncoder().encode(text));
  }

  readBytes(filePath) {
    const bytes = this.files.get(filePath);
    if (!bytes) throw new Error(`${filePath} does not exist`);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  writeBytes(filePath, bytes) {
    this.files.set(filePath, new Uint8Array(bytes));
  }

  fileObject(filePath, bytes) {
    return { path: filePath, stat: { size: bytes.byteLength } };
  }
}

export function installSyncFetch({ plans, remoteFiles, modelResult, modelStatus = 200 }) {
  let syncCheckCalls = 0;
  const log = { blobCalls: 0, commitCalls: 0, modelCalls: 0 };
  installRequestUrl(async (init) => {
    const url = init.url;
    const body = init.body ? JSON.parse(init.body) : {};
    if (url === "https://worker.test/v2/sync/check") {
      const plan = plans[syncCheckCalls];
      syncCheckCalls += 1;
      if (!plan) throw new Error("Unexpected extra sync/check call");
      return jsonRequestResponse(plan);
    }
    if (url === "https://worker.test/v2/pull/file") {
      const text = remoteFiles[body.path];
      if (typeof text !== "string") throw new Error(`Missing remote file for ${body.path}`);
      return jsonRequestResponse(pullFileResponse(body.path, body.blobSha, text));
    }
    if (url === "https://worker.test/v2/blob") {
      log.blobCalls += 1;
      return jsonRequestResponse({ path: body.path, sha: "created-blob" });
    }
    if (url === "https://worker.test/v2/commit") {
      log.commitCalls += 1;
      return jsonRequestResponse({
        ok: true,
        protocol: 2,
        commitSha: "commit-1",
        treeSha: "tree-1",
        changed: body.blobs.length + body.patch.delete.length,
        deviceState: { version: 2, deviceId: body.deviceId, lastSyncedCommitSha: "commit-1" }
      });
    }
    throw new Error(`Unexpected requestUrl URL: ${url}`);
  });
  installFetch(async (url) => {
    if (url === "https://api.deepseek.com/chat/completions") {
      log.modelCalls += 1;
      if (modelStatus !== 200) return jsonResponse({ error: "model unavailable" }, modelStatus);
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(modelResult) } }] });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
  return log;
}

export function installRequestUrl(handler) {
  globalThis.__vaultbridgeRequestUrl = async (input) => handler(input);
}

export function installFetch(handler) {
  globalThis.window = {
    setTimeout,
    clearTimeout
  };
  globalThis.__vaultbridgeNotices = [];
  globalThis.fetch = async (url, init = {}) => handler(String(url), init);
}

export function jsonResponse(body, status = 200) {
  return {
    status,
    text: async () => JSON.stringify(body)
  };
}

export function jsonRequestResponse(body, status = 200) {
  const text = JSON.stringify(body);
  return {
    status,
    headers: {},
    arrayBuffer: new TextEncoder().encode(text).buffer,
    json: body,
    text
  };
}

export function pullFileResponse(filePath, blobSha, text) {
  const bytes = new TextEncoder().encode(text);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return {
    path: filePath,
    commitSha: "remote-commit",
    blobSha,
    encoding: "base64",
    content: Buffer.from(bytes).toString("base64"),
    size: bytes.byteLength,
    sha256: sha256(buffer)
  };
}

export function makePlan(overrides = {}) {
  const plan = {
    protocol: 2,
    deviceId: "test-device",
    bootstrap: false,
    baseCommitSha: null,
    remoteCommitSha: "remote",
    sessionToken: "session",
    sessionExpiresInSeconds: 120,
    download: [],
    deleteLocal: [],
    upload: [],
    deleteRemote: [],
    conflict: [],
    unchanged: [],
    counts: {
      download: 0,
      deleteLocal: 0,
      upload: 0,
      deleteRemote: 0,
      conflict: 0,
      unchanged: 0
    },
    nextDeviceState: null,
    ...overrides
  };
  plan.counts = {
    download: plan.download.length,
    deleteLocal: plan.deleteLocal.length,
    upload: plan.upload.length,
    deleteRemote: plan.deleteRemote.length,
    conflict: plan.conflict.length,
    unchanged: plan.unchanged.length
  };
  return plan;
}

export function testData(overrides = {}) {
  return {
    settings: testSettings(overrides),
    deviceState: { version: 2, deviceId: "test-device", lastSyncedCommitSha: "base-1" },
    lastResult: null,
    pendingConflicts: {},
    pendingDesktopGitConflict: null
  };
}

export function testSettings(overrides = {}) {
  return {
    workerUrl: "https://worker.test",
    syncToken: "sync-token",
    deviceId: "test-device",
    localPrefix: "",
    remotePrefix: "",
    maxFileBytes: 20 * 1024 * 1024,
    excludePatterns: [
      ".git/",
      ".vaultbridge/",
      ".DS_Store",
      ".remote-conflict-",
      ".auto-merge-proposal-",
      ".local-before-auto-merge-"
    ],
    autoMergeConflicts: true,
    autoMergeMode: "suggest",
    autoMergeEndpoint: "https://api.deepseek.com",
    autoMergeApiKey: "deepseek-key",
    autoMergeModel: "deepseek-v4-flash",
    autoMergeMaxFileBytes: 200 * 1024,
    autoMergeConfidenceThreshold: 0.9,
    desktopAutoGitPush: false,
    desktopAutoGitPushDelaySeconds: 60,
    desktopGitPullBeforePush: true,
    desktopGitCommitMessagePrefix: "VaultBridge desktop autosync",
    desktopWorkerSyncEnabled: false,
    ...overrides
  };
}

export function sha256(buffer) {
  return createHash("sha256").update(Buffer.from(buffer)).digest("hex");
}
