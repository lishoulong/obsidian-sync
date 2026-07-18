import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  buildTestModules,
  installSyncFetch,
  makePlan,
  MemoryVault,
  testData
} from "./helpers.mjs";

test("delete guard stops sync when local deletions exceed the threshold", async () => {
  const modules = await buildTestModules();
  const { SyncEngine } = await import(pathToFileURL(modules.syncEngine).href);
  const vault = new MemoryVault({ "a.md": "a\n", "b.md": "b\n", "c.md": "c\n" });
  const fetchLog = installSyncFetch({
    plans: [
      makePlan({
        remoteCommitSha: "remote-1",
        sessionToken: "session-1",
        deleteLocal: [{ path: "a.md" }, { path: "b.md" }, { path: "c.md" }]
      })
    ],
    remoteFiles: {}
  });
  const data = testData({ deleteGuardThreshold: 2 });

  const result = await new SyncEngine({
    vault,
    fileManager: {},
    data,
    saveData: async () => {},
    updateStatus: () => {}
  }).syncNow();

  assert.equal(result.status, "error");
  assert.match(result.message, /delete guard threshold/);
  assert.deepEqual(vault.paths(), ["a.md", "b.md", "c.md"]);
  assert.equal(fetchLog.commitCalls, 0);
});

test("delete guard stops sync when remote deletions exceed the threshold", async () => {
  const modules = await buildTestModules();
  const { SyncEngine } = await import(pathToFileURL(modules.syncEngine).href);
  const vault = new MemoryVault({ "keep.md": "keep\n" });
  const fetchLog = installSyncFetch({
    plans: [
      makePlan({ remoteCommitSha: "remote-1", sessionToken: "session-1" }),
      makePlan({
        remoteCommitSha: "remote-1",
        sessionToken: "session-2",
        deleteRemote: [{ path: "x.md" }, { path: "y.md" }, { path: "z.md" }]
      })
    ],
    remoteFiles: {}
  });
  const data = testData({ deleteGuardThreshold: 2 });

  const result = await new SyncEngine({
    vault,
    fileManager: {},
    data,
    saveData: async () => {},
    updateStatus: () => {}
  }).syncNow();

  assert.equal(result.status, "error");
  assert.match(result.message, /remote file\(s\) would be deleted/);
  assert.equal(fetchLog.commitCalls, 0);
  assert.equal(fetchLog.blobCalls, 0);
});

test("approved large delete lets remote deletions commit", async () => {
  const modules = await buildTestModules();
  const { SyncEngine } = await import(pathToFileURL(modules.syncEngine).href);
  const vault = new MemoryVault({ "keep.md": "keep\n" });
  const fetchLog = installSyncFetch({
    plans: [
      makePlan({ remoteCommitSha: "remote-1", sessionToken: "session-1" }),
      makePlan({
        remoteCommitSha: "remote-1",
        sessionToken: "session-2",
        deleteRemote: [{ path: "x.md" }, { path: "y.md" }, { path: "z.md" }]
      })
    ],
    remoteFiles: {}
  });
  const data = testData({ deleteGuardThreshold: 2 });

  const result = await new SyncEngine({
    vault,
    fileManager: {},
    data,
    saveData: async () => {},
    updateStatus: () => {},
    largeDeleteApproved: true
  }).syncNow();

  assert.equal(result.status, "success");
  assert.equal(result.counts.deletedRemote, 3);
  assert.equal(fetchLog.commitCalls, 1);
});

test("guard is disabled when the threshold is zero", async () => {
  const modules = await buildTestModules();
  const { SyncEngine } = await import(pathToFileURL(modules.syncEngine).href);
  const vault = new MemoryVault({ "keep.md": "keep\n" });
  const fetchLog = installSyncFetch({
    plans: [
      makePlan({ remoteCommitSha: "remote-1", sessionToken: "session-1" }),
      makePlan({
        remoteCommitSha: "remote-1",
        sessionToken: "session-2",
        deleteRemote: [{ path: "x.md" }, { path: "y.md" }, { path: "z.md" }]
      })
    ],
    remoteFiles: {}
  });
  const data = testData({ deleteGuardThreshold: 0 });

  const result = await new SyncEngine({
    vault,
    fileManager: {},
    data,
    saveData: async () => {},
    updateStatus: () => {}
  }).syncNow();

  assert.equal(result.status, "success");
  assert.equal(result.counts.deletedRemote, 3);
  assert.equal(fetchLog.commitCalls, 1);
});

test("sync never deletes repository files outside the configured notes folder", async () => {
  const modules = await buildTestModules();
  const { SyncEngine } = await import(pathToFileURL(modules.syncEngine).href);
  const vault = new MemoryVault({ "note.md": "keep\n" });
  const fetchLog = installSyncFetch({
    plans: [
      makePlan({
        remoteCommitSha: "remote-1",
        sessionToken: "session-1",
        unchanged: [{ path: "vault/note.md" }, { path: "README.md" }]
      }),
      makePlan({
        remoteCommitSha: "remote-1",
        sessionToken: "session-2",
        deleteRemote: [{ path: "README.md" }],
        unchanged: [{ path: "vault/note.md" }]
      })
    ],
    remoteFiles: {}
  });
  const data = testData({ remotePrefix: "vault/" });

  const result = await new SyncEngine({
    vault,
    fileManager: {},
    data,
    saveData: async () => {},
    updateStatus: () => {}
  }).syncNow();

  assert.equal(result.status, "success");
  assert.equal(result.counts.deletedRemote, 0);
  assert.equal(fetchLog.commitCalls, 0);
});
