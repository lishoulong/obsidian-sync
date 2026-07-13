import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "../src/http.ts";
import { cleanPath, encodePath, ensureUserPath } from "../src/paths.ts";
import {
  normalizeDeletePaths,
  normalizeDeviceId,
  normalizeManifest,
  normalizeMeta,
  normalizeOptionalSha,
  normalizeSha,
  validatePatch,
} from "../src/validation.ts";

const sha256 = "a".repeat(64);
const commitSha = "b".repeat(40);

function expectHttpError(
  callback: () => unknown,
  status: number,
  code: string,
): void {
  assert.throws(
    callback,
    (error: unknown) =>
      error instanceof HttpError &&
      error.status === status &&
      error.code === code,
  );
}

test("cleanPath normalizes safe paths and encodePath preserves separators", () => {
  assert.equal(cleanPath("/Notes\\Today.md"), "Notes/Today.md");
  assert.equal(
    encodePath("Notes/你好 world.md"),
    "Notes/%E4%BD%A0%E5%A5%BD%20world.md",
  );
});

test("cleanPath rejects traversal, empty segments, and Git internals", () => {
  for (const path of ["../secret", "Notes//Today.md", ".git/config", "\0bad"])
    expectHttpError(() => cleanPath(path), 400, "invalid_path");
});

test("ensureUserPath rejects the reserved VaultBridge namespace", () => {
  expectHttpError(
    () => ensureUserPath(".vaultbridge/manifest.json"),
    400,
    "reserved_path",
  );
  assert.doesNotThrow(() => ensureUserPath("Notes/Today.md"));
});

test("manifest normalization accepts object and legacy array forms", () => {
  const expected = { "Notes/Today.md": { size: 12, sha256 } };

  assert.deepEqual(
    normalizeManifest({
      "Notes/Today.md": { size: 12, sha256: sha256.toUpperCase() },
      ".vaultbridge/manifest.json": { size: 1, sha256 },
    }),
    expected,
  );
  assert.deepEqual(
    normalizeManifest([{ path: "Notes/Today.md", size: 12, sha256 }]),
    expected,
  );
});

test("metadata, device IDs, and Git SHAs are validated", () => {
  assert.deepEqual(normalizeMeta({ size: 0, sha256 }), { size: 0, sha256 });
  assert.equal(normalizeDeviceId(" phone-1 "), "phone-1");
  assert.equal(normalizeSha(commitSha.toUpperCase(), "commit"), commitSha);
  assert.equal(normalizeOptionalSha("", "commit"), null);

  expectHttpError(
    () => normalizeMeta({ size: -1, sha256 }),
    400,
    "invalid_size",
  );
  expectHttpError(
    () => normalizeMeta({ size: 1, sha256: "bad" }),
    400,
    "invalid_sha256",
  );
  expectHttpError(() => normalizeDeviceId("x"), 400, "invalid_device_id");
  expectHttpError(() => normalizeSha("bad", "commit"), 400, "invalid_sha");
});

test("delete paths are normalized, deduplicated, and checked against uploads", () => {
  assert.deepEqual(
    normalizeDeletePaths(["Notes/A.md", "/Notes/A.md", "Notes/B.md"]),
    ["Notes/A.md", "Notes/B.md"],
  );
  expectHttpError(
    () => normalizeDeletePaths([".vaultbridge/state.json"]),
    400,
    "reserved_path",
  );
  expectHttpError(
    () => validatePatch({ "Notes/A.md": { size: 1, sha256 } }, ["Notes/A.md"]),
    400,
    "patch_mismatch",
  );
});
