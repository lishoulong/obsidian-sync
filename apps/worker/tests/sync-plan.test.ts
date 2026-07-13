import assert from "node:assert/strict";
import test from "node:test";

import { compareThreeWay } from "../src/sync-plan.ts";

interface TestFileMeta {
  sha256: string;
  size: number;
  remoteBlobSha: string;
}

const meta = (
  sha256: string,
  size = 1,
  remoteBlobSha = sha256.repeat(40),
): TestFileMeta => ({
  sha256: sha256.repeat(64),
  size,
  remoteBlobSha,
});
const base = meta("a");
const local = meta("b");
const remote = meta("c", 2, "c".repeat(40));

test("bootstrap classifies additions, matches, and conflicts conservatively", () => {
  const plan = compareThreeWay({
    bootstrap: true,
    base: {},
    local: {
      "conflict.md": local,
      "local.md": local,
      "same.md": base,
    },
    remote: {
      "conflict.md": remote,
      "remote.md": remote,
      "same.md": base,
    },
  });

  assert.deepEqual(plan.upload, [{ path: "local.md", reason: "local_added" }]);
  assert.deepEqual(plan.download, [
    {
      path: "remote.md",
      reason: "remote_added",
      remoteBlobSha: remote.remoteBlobSha,
      size: remote.size,
      sha256: remote.sha256,
    },
  ]);
  assert.deepEqual(plan.conflict, [
    {
      path: "conflict.md",
      reason: "no_common_base",
      remoteBlobSha: remote.remoteBlobSha,
      remoteSize: remote.size,
    },
  ]);
  assert.deepEqual(plan.unchanged, [{ path: "same.md" }]);
  assert.deepEqual(plan.counts, {
    download: 1,
    deleteLocal: 0,
    upload: 1,
    deleteRemote: 0,
    conflict: 1,
    unchanged: 1,
  });
});

test("three-way comparison covers one-sided changes and deletions", () => {
  const plan = compareThreeWay({
    bootstrap: false,
    base: {
      "local-deleted.md": base,
      "local-modified.md": base,
      "remote-deleted.md": base,
      "remote-modified.md": base,
      "unchanged.md": base,
    },
    local: {
      "local-modified.md": local,
      "remote-deleted.md": base,
      "remote-modified.md": base,
      "unchanged.md": base,
    },
    remote: {
      "local-deleted.md": base,
      "local-modified.md": base,
      "remote-modified.md": remote,
      "unchanged.md": base,
    },
  });

  assert.deepEqual(plan.upload, [
    { path: "local-modified.md", reason: "local_modified" },
  ]);
  assert.deepEqual(plan.deleteRemote, [
    { path: "local-deleted.md", reason: "local_deleted" },
  ]);
  assert.deepEqual(plan.download, [
    {
      path: "remote-modified.md",
      reason: "remote_modified",
      remoteBlobSha: remote.remoteBlobSha,
      size: remote.size,
      sha256: remote.sha256,
    },
  ]);
  assert.deepEqual(plan.deleteLocal, [
    { path: "remote-deleted.md", reason: "remote_deleted" },
  ]);
  assert.deepEqual(plan.unchanged, [{ path: "unchanged.md" }]);
});

test("three-way comparison identifies convergence and each conflict reason", () => {
  const plan = compareThreeWay({
    bootstrap: false,
    base: {
      "both-modified.md": base,
      "converged.md": base,
      "local-deleted.md": base,
      "remote-deleted.md": base,
    },
    local: {
      "both-modified.md": local,
      "converged.md": local,
      "remote-deleted.md": local,
    },
    remote: {
      "both-modified.md": remote,
      "converged.md": local,
      "local-deleted.md": remote,
    },
  });

  assert.deepEqual(plan.unchanged, [
    { path: "converged.md", reason: "converged" },
  ]);
  assert.deepEqual(
    plan.conflict.map(({ path, reason }) => ({ path, reason })),
    [
      { path: "both-modified.md", reason: "both_modified" },
      { path: "local-deleted.md", reason: "local_deleted_remote_modified" },
      { path: "remote-deleted.md", reason: "remote_deleted_local_modified" },
    ],
  );
});
