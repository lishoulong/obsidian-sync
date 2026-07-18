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

test("GitHub-first setup rejects a non-empty local vault", async () => {
  const { assertInitialSyncDirection } = await onboardingModule();
  assert.throws(() => assertInitialSyncDirection(preview({ mode: "remote", localFiles: 1 })), /empty local notes folder/);
});

test("local-first setup rejects a non-empty remote notes folder", async () => {
  const { assertInitialSyncDirection } = await onboardingModule();
  assert.throws(() => assertInitialSyncDirection(preview({ mode: "local", remoteFiles: 2 })), /empty remote notes folder/);
});

test("safe merge permits files on both sides", async () => {
  const { assertInitialSyncDirection } = await onboardingModule();
  assert.doesNotThrow(() => assertInitialSyncDirection(preview({ mode: "merge", localFiles: 3, remoteFiles: 4 })));
});

test("notes synchronization requires a private GitHub repository", async () => {
  const { assertPrivateRepository } = await onboardingModule();
  assert.doesNotThrow(() => assertPrivateRepository({ repository: { private: true } }));
  assert.throws(
    () => assertPrivateRepository({ repository: { fullName: "owner/public-notes", private: false } }),
    /requires a private GitHub repository/
  );
});

test("pairing deep links encode the Worker origin and one-time code", async () => {
  const { makePairingDeepLink } = await onboardingModule();
  assert.equal(
    makePairingDeepLink("https://worker.test/", "one time"),
    "obsidian://vaultbridge-connect?endpoint=https%3A%2F%2Fworker.test&code=one%20time"
  );
});

test("pairing endpoint accepts HTTPS origins and rejects paths or insecure hosts", async () => {
  const { validatePairingEndpoint } = await onboardingModule();
  assert.equal(validatePairingEndpoint("https://worker.test/"), "https://worker.test");
  assert.equal(validatePairingEndpoint("http://localhost:8787"), "http://localhost:8787");
  assert.throws(() => validatePairingEndpoint("http://worker.test"), /must use HTTPS/);
  assert.throws(() => validatePairingEndpoint("https://worker.test/health"), /only the Worker origin/);
});

test("first sync preview scans local files and counts remote paths without writing", async () => {
  const { previewInitialSync } = await onboardingModule();
  const vault = new MemoryVault({ "local.md": "local\n" });
  installSyncFetch({
    plans: [makePlan({
      download: [{ path: "remote.md", remoteBlobSha: "blob", size: 7, sha256: "hash" }],
      upload: [{ path: "local.md" }]
    })],
    remoteFiles: {}
  });
  const data = testData();
  data.onboarding = { initialSyncCompleted: false, mode: null, preview: null };

  const result = await previewInitialSync(vault, data, "merge");

  assert.equal(result.localFiles, 1);
  assert.equal(result.remoteFiles, 1);
  assert.equal(result.counts.download, 1);
  assert.equal(result.counts.upload, 1);
  assert.match(result.planDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(vault.paths(), ["local.md"]);
});

test("first sync digest changes when local content changes without changing plan counts", async () => {
  const { previewInitialSync } = await onboardingModule();
  const vault = new MemoryVault({ "local.md": "aaaa" });
  installSyncFetch({
    plans: [
      makePlan({ upload: [{ path: "local.md" }] }),
      makePlan({ upload: [{ path: "local.md" }] })
    ],
    remoteFiles: {}
  });
  const data = testData();
  data.onboarding = { initialSyncCompleted: false, mode: null, preview: null };

  const before = await previewInitialSync(vault, data, "merge");
  vault.writeText("local.md", "bbbb");
  data.hashCache = {};
  const after = await previewInitialSync(vault, data, "merge");

  assert.notEqual(before.planDigest, after.planDigest);
  assert.deepEqual(before.counts, after.counts);
});

test("local-first ignores repository files outside the configured notes folder", async () => {
  const { previewInitialSync } = await onboardingModule();
  const vault = new MemoryVault({ "local.md": "local\n" });
  installSyncFetch({
    plans: [makePlan({
      download: [{ path: "README.md", remoteBlobSha: "readme", size: 7, sha256: "hash" }],
      upload: [{ path: "vault/local.md" }]
    })],
    remoteFiles: {}
  });
  const data = testData();
  data.settings.remotePrefix = "vault/";
  data.onboarding = { initialSyncCompleted: false, mode: null, preview: null };

  const result = await previewInitialSync(vault, data, "local");

  assert.equal(result.remoteFiles, 0);
  assert.equal(result.counts.download, 0);
  assert.equal(result.counts.upload, 1);
});

let modulePromise;

async function onboardingModule() {
  if (!modulePromise) {
    modulePromise = buildTestModules().then((modules) => import(pathToFileURL(modules.onboarding).href));
  }
  return modulePromise;
}

function preview(overrides) {
  return {
    mode: "merge",
    localFiles: 0,
    remoteFiles: 0,
    remoteCommitSha: "remote",
    planDigest: "digest",
    counts: { download: 0, deleteLocal: 0, upload: 0, deleteRemote: 0, conflict: 0, unchanged: 0 },
    createdAt: new Date(0).toISOString(),
    ...overrides
  };
}
