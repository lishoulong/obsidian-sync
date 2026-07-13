import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  buildTestModules,
  installFetch,
  installSyncFetch,
  jsonResponse,
  makePlan,
  MemoryVault,
  testData,
  testSettings
} from "./helpers.mjs";


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
