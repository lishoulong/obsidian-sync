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

test("Auto Merge calls DeepSeek-compatible base_url /chat/completions", async () => {
  const modules = await buildTestModules();
  const { requestAutoMerge } = await import(pathToFileURL(modules.autoMerge).href);
  const calls = [];
  installFetch(async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            status: "merged",
            confidence: 0.98,
            mergedContent: "merged",
            summary: "ok",
            warnings: [],
            requiresReview: false
          })
        }
      }]
    });
  });

  const result = await requestAutoMerge({
    settings: testSettings(),
    path: "note.md",
    localContent: "local",
    remoteContent: "remote"
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(calls[0].body.model, "deepseek-v4-flash");
  assert.equal(calls[0].body.response_format.type, "json_object");
  assert.match(calls[0].body.messages[0].content, /clean final file/);
  assert.match(calls[0].body.messages[0].content, /no Git conflict markers/);
  assert.equal(result.mergedContent, "merged");
});

test("Auto Merge rejects model output that still contains conflict markers", async () => {
  const modules = await buildTestModules();
  const { requestAutoMerge } = await import(pathToFileURL(modules.autoMerge).href);
  installFetch(async () => jsonResponse({
    choices: [{
      message: {
        content: JSON.stringify({
          status: "merged",
          confidence: 0.99,
          mergedContent: [
            "# Note",
            "<<<<<<< local",
            "old",
            "=======",
            "new",
            ">>>>>>> remote",
            ""
          ].join("\n"),
          summary: "Kept both versions.",
          warnings: [],
          requiresReview: false
        })
      }
    }]
  }));

  await assert.rejects(
    () => requestAutoMerge({
      settings: testSettings(),
      path: "note.md",
      localContent: "old",
      remoteContent: "new"
    }),
    /unresolved conflict markers/
  );
});

test("Auto Merge retries transient model failures", async () => {
  const modules = await buildTestModules();
  const { requestAutoMerge } = await import(pathToFileURL(modules.autoMerge).href);
  let calls = 0;
  installFetch(async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ error: "temporarily unavailable" }, 503);
    return jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            status: "merged",
            confidence: 0.96,
            mergedContent: "merged after retry",
            summary: "ok",
            warnings: [],
            requiresReview: false
          })
        }
      }]
    });
  });

  const result = await requestAutoMerge({
    settings: testSettings(),
    path: "note.md",
    localContent: "local",
    remoteContent: "remote"
  });

  assert.equal(calls, 2);
  assert.equal(result.mergedContent, "merged after retry");
});

test("Auto Merge does not retry non-retryable auth failures", async () => {
  const modules = await buildTestModules();
  const { requestAutoMerge } = await import(pathToFileURL(modules.autoMerge).href);
  let calls = 0;
  installFetch(async () => {
    calls += 1;
    return jsonResponse({ error: "unauthorized" }, 401);
  });

  await assert.rejects(
    () => requestAutoMerge({
      settings: testSettings(),
      path: "note.md",
      localContent: "local",
      remoteContent: "remote"
    }),
    /401/
  );
  assert.equal(calls, 1);
});

test("Auto Merge keeps a full chat/completions endpoint compatible", async () => {
  const modules = await buildTestModules();
  const { requestAutoMerge } = await import(pathToFileURL(modules.autoMerge).href);
  let requestedUrl = "";
  installFetch(async (url) => {
    requestedUrl = url;
    return jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            status: "merged",
            confidence: 1,
            mergedContent: "merged",
            summary: "ok",
            warnings: [],
            requiresReview: false
          })
        }
      }]
    });
  });

  await requestAutoMerge({
    settings: { ...testSettings(), autoMergeEndpoint: "https://api.deepseek.com/chat/completions" },
    path: "note.md",
    localContent: "local",
    remoteContent: "remote"
  });

  assert.equal(requestedUrl, "https://api.deepseek.com/chat/completions");
});

test("Auto Merge lists DeepSeek-compatible models from base_url /models", async () => {
  const modules = await buildTestModules();
  const { listAutoMergeModels } = await import(pathToFileURL(modules.autoMerge).href);
  let requestedUrl = "";
  installFetch(async (url, init) => {
    requestedUrl = url;
    assert.equal(init.method, "GET");
    assert.equal(init.headers.authorization, "Bearer deepseek-key");
    return jsonResponse({
      data: [
        { id: "deepseek-v4-pro" },
        { id: "deepseek-v4-flash" },
        { id: "deepseek-v4-flash" },
        { name: "ignored" }
      ]
    });
  });

  const models = await listAutoMergeModels(testSettings());

  assert.equal(requestedUrl, "https://api.deepseek.com/models");
  assert.deepEqual(models, ["deepseek-v4-flash", "deepseek-v4-pro"]);
});

test("Suggest mode writes an auto-merge proposal and preserves manual conflict flow", async () => {
  const modules = await buildTestModules();
  const { SyncEngine } = await import(pathToFileURL(modules.syncEngine).href);
  const vault = new MemoryVault({ "note.md": "local paragraph\n" });
  const fetchLog = installSyncFetch({
    plans: [
      makePlan({
        remoteCommitSha: "remote-1",
        sessionToken: "session-1",
        conflict: [{ path: "note.md", remoteBlobSha: "remote-blob" }]
      })
    ],
    remoteFiles: {
      "note.md": "remote paragraph\n"
    },
    modelResult: {
      status: "merged",
      confidence: 0.83,
      mergedContent: "local paragraph\nremote paragraph\n",
      summary: "Combined both paragraphs.",
      warnings: [],
      requiresReview: true
    }
  });
  const data = testData({ autoMergeMode: "suggest" });

  const result = await new SyncEngine({
    vault,
    fileManager: {},
    data,
    saveData: async (next) => {
      data.settings = next.settings;
      data.deviceState = next.deviceState;
      data.lastResult = next.lastResult;
      data.pendingConflicts = next.pendingConflicts;
    },
    updateStatus: () => {}
  }).syncNow();

  const paths = vault.paths();
  const proposalPath = paths.find((item) => item.includes(".auto-merge-proposal-"));
  const conflictPath = paths.find((item) => item.includes(".remote-conflict-"));
  assert.equal(result.status, "conflict");
  assert.ok(proposalPath, "expected an auto-merge proposal file");
  assert.ok(conflictPath, "expected the normal remote conflict copy");
  assert.equal(vault.readText("note.md"), "local paragraph\n");
  assert.match(vault.readText(proposalPath), /Combined both paragraphs/);
  assert.equal(vault.readText(conflictPath), "remote paragraph\n");
  assert.equal(fetchLog.commitCalls, 0);
});

test("Apply mode writes a backup, applies high-confidence merge, and commits", async () => {
  const modules = await buildTestModules();
  const { SyncEngine } = await import(pathToFileURL(modules.syncEngine).href);
  const vault = new MemoryVault({ "note.md": "local item\n" });
  const fetchLog = installSyncFetch({
    plans: [
      makePlan({
        remoteCommitSha: "remote-2",
        sessionToken: "session-1",
        conflict: [{ path: "note.md", remoteBlobSha: "remote-blob" }]
      }),
      makePlan({
        remoteCommitSha: "remote-2",
        sessionToken: "session-2",
        upload: [{ path: "note.md" }]
      })
    ],
    remoteFiles: {
      "note.md": "remote item\n"
    },
    modelResult: {
      status: "merged",
      confidence: 0.96,
      mergedContent: "local item\nremote item\n",
      summary: "Merged both items.",
      warnings: [],
      requiresReview: false
    }
  });
  const data = testData({ autoMergeMode: "apply" });

  const result = await new SyncEngine({
    vault,
    fileManager: {},
    data,
    saveData: async (next) => {
      data.settings = next.settings;
      data.deviceState = next.deviceState;
      data.lastResult = next.lastResult;
      data.pendingConflicts = next.pendingConflicts;
    },
    updateStatus: () => {}
  }).syncNow();

  const backupPath = vault.paths().find((item) => item.includes(".local-before-auto-merge-"));
  assert.equal(result.status, "success");
  assert.equal(result.commitSha, "commit-1");
  assert.ok(backupPath, "expected a local backup before applying merge");
  assert.equal(vault.readText(backupPath), "local item\n");
  assert.equal(vault.readText("note.md"), "local item\nremote item\n");
  assert.equal(fetchLog.blobCalls, 1);
  assert.equal(fetchLog.commitCalls, 1);
  assert.equal(data.deviceState.lastSyncedCommitSha, "commit-1");
});

test("Apply mode falls back to manual conflict when confidence is low", async () => {
  const modules = await buildTestModules();
  const { SyncEngine } = await import(pathToFileURL(modules.syncEngine).href);
  const vault = new MemoryVault({ "note.md": "local\n" });
  const fetchLog = installSyncFetch({
    plans: [
      makePlan({
        remoteCommitSha: "remote-3",
        sessionToken: "session-1",
        conflict: [{ path: "note.md", remoteBlobSha: "remote-blob" }]
      })
    ],
    remoteFiles: {
      "note.md": "remote\n"
    },
    modelResult: {
      status: "merged",
      confidence: 0.4,
      mergedContent: "merged\n",
      summary: "Low confidence.",
      warnings: [],
      requiresReview: false
    }
  });
  const data = testData({ autoMergeMode: "apply" });

  const result = await new SyncEngine({
    vault,
    fileManager: {},
    data,
    saveData: async (next) => {
      data.settings = next.settings;
      data.deviceState = next.deviceState;
      data.lastResult = next.lastResult;
      data.pendingConflicts = next.pendingConflicts;
    },
    updateStatus: () => {}
  }).syncNow();

  assert.equal(result.status, "conflict");
  assert.equal(vault.readText("note.md"), "local\n");
  assert.ok(vault.paths().some((item) => item.includes(".auto-merge-proposal-")));
  assert.ok(vault.paths().some((item) => item.includes(".remote-conflict-")));
  assert.equal(fetchLog.commitCalls, 0);
});

test("Apply mode falls back to manual conflict when Auto Merge retries are exhausted", async () => {
  const modules = await buildTestModules();
  const { SyncEngine } = await import(pathToFileURL(modules.syncEngine).href);
  const vault = new MemoryVault({ "note.md": "local\n" });
  const fetchLog = installSyncFetch({
    plans: [
      makePlan({
        remoteCommitSha: "remote-4",
        sessionToken: "session-1",
        conflict: [{ path: "note.md", remoteBlobSha: "remote-blob" }]
      })
    ],
    remoteFiles: {
      "note.md": "remote\n"
    },
    modelStatus: 503
  });
  const data = testData({ autoMergeMode: "apply" });

  const result = await new SyncEngine({
    vault,
    fileManager: {},
    data,
    saveData: async (next) => {
      data.settings = next.settings;
      data.deviceState = next.deviceState;
      data.lastResult = next.lastResult;
      data.pendingConflicts = next.pendingConflicts;
    },
    updateStatus: () => {}
  }).syncNow();

  assert.equal(result.status, "conflict");
  assert.equal(vault.readText("note.md"), "local\n");
  assert.ok(vault.paths().some((item) => item.includes(".remote-conflict-")));
  assert.ok(!vault.paths().some((item) => item.includes(".local-before-auto-merge-")));
  assert.ok(!vault.paths().some((item) => item.includes(".auto-merge-proposal-")));
  assert.equal(fetchLog.modelCalls, 3);
  assert.equal(fetchLog.commitCalls, 0);
  assert.match(data.lastResult.diagnostics.autoMergeWarnings.join("\n"), /after 3 attempts/);
});

async function buildTestModules() {
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

class MemoryVault {
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

function installSyncFetch({ plans, remoteFiles, modelResult, modelStatus = 200 }) {
  let syncCheckCalls = 0;
  const log = { blobCalls: 0, commitCalls: 0, modelCalls: 0 };
  installFetch(async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : {};
    if (url === "https://worker.test/v2/sync/check") {
      const plan = plans[syncCheckCalls];
      syncCheckCalls += 1;
      if (!plan) throw new Error("Unexpected extra sync/check call");
      return jsonResponse(plan);
    }
    if (url === "https://worker.test/v2/pull/file") {
      const text = remoteFiles[body.path];
      if (typeof text !== "string") throw new Error(`Missing remote file for ${body.path}`);
      return jsonResponse(pullFileResponse(body.path, body.blobSha, text));
    }
    if (url === "https://worker.test/v2/blob") {
      log.blobCalls += 1;
      return jsonResponse({ path: body.path, sha: "created-blob" });
    }
    if (url === "https://worker.test/v2/commit") {
      log.commitCalls += 1;
      return jsonResponse({
        ok: true,
        protocol: 2,
        commitSha: "commit-1",
        treeSha: "tree-1",
        changed: body.blobs.length + body.patch.delete.length,
        deviceState: { version: 2, deviceId: body.deviceId, lastSyncedCommitSha: "commit-1" }
      });
    }
    if (url === "https://api.deepseek.com/chat/completions") {
      log.modelCalls += 1;
      if (modelStatus !== 200) return jsonResponse({ error: "model unavailable" }, modelStatus);
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(modelResult) } }] });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
  return log;
}

function installFetch(handler) {
  globalThis.window = {
    setTimeout,
    clearTimeout
  };
  globalThis.__vaultbridgeNotices = [];
  globalThis.fetch = async (url, init = {}) => handler(String(url), init);
}

function jsonResponse(body, status = 200) {
  return {
    status,
    text: async () => JSON.stringify(body)
  };
}

function pullFileResponse(filePath, blobSha, text) {
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

function makePlan(overrides = {}) {
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

function testData(overrides = {}) {
  return {
    settings: testSettings(overrides),
    deviceState: { version: 2, deviceId: "test-device", lastSyncedCommitSha: "base-1" },
    lastResult: null,
    pendingConflicts: {},
    pendingDesktopGitConflict: null
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

function sha256(buffer) {
  return createHash("sha256").update(Buffer.from(buffer)).digest("hex");
}
