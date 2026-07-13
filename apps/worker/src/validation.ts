import { INTERNAL_PREFIX, MANIFEST_PATH } from "./constants.js";
import { httpError } from "./http.js";
import { cleanPath, ensureUserPath } from "./paths.js";
import { field, isRecord } from "./types.js";
import type { FileMeta, GitTreeMutation, Manifest } from "./types.js";
export function validatePatch(upsert: Manifest, deletePaths: string[]): void {
  for (const path of deletePaths)
    if (path in upsert)
      throw httpError(
        400,
        "patch_mismatch",
        `${path} cannot be uploaded and deleted in the same patch`,
      );
}
export function normalizeBlobEntries(
  input: unknown,
  manifest: Manifest,
  requiredUpsert: Manifest | null,
): GitTreeMutation[] {
  const blobs = Array.isArray(input) ? input : [];
  const entries: GitTreeMutation[] = [];
  const seen = new Set<string>();
  for (const item of blobs) {
    const path = cleanPath(field(item, "path"));
    ensureUserPath(path);
    const sha = normalizeSha(field(item, "sha"), `blob sha for ${path}`);
    if (!(path in manifest))
      throw httpError(
        400,
        "manifest_mismatch",
        `${path} is missing from files manifest`,
      );
    if (requiredUpsert && !(path in requiredUpsert))
      throw httpError(
        400,
        "patch_mismatch",
        `${path} blob is missing from upsert patch`,
      );
    if (seen.has(path)) throw httpError(400, "duplicate_path", path);
    seen.add(path);
    entries.push({ path, mode: "100644", type: "blob", sha });
  }
  if (requiredUpsert)
    for (const path of Object.keys(requiredUpsert))
      if (!seen.has(path))
        throw httpError(
          400,
          "patch_mismatch",
          `${path} upsert is missing a blob`,
        );
  return entries;
}
export function normalizeDeletePaths(input: unknown): string[] {
  const values = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const raw of values) {
    const path = cleanPath(raw);
    ensureUserPath(path);
    if (!seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}
export function normalizeDeletions(
  paths: string[],
  manifest: Manifest,
): GitTreeMutation[] {
  return paths
    .filter((path) => !(path in manifest))
    .map((path) => ({ path, mode: "100644", type: "blob", sha: null }));
}
export function sameMeta(
  a: FileMeta | undefined,
  b: FileMeta | undefined,
): boolean {
  return (
    (!a && !b) || Boolean(a && b && a.size === b.size && a.sha256 === b.sha256)
  );
}
export function normalizeManifest(files: unknown): Manifest {
  const result: Manifest = {};
  if (Array.isArray(files)) {
    for (const item of files) {
      const path = cleanPath(field(item, "path"));
      if (path === MANIFEST_PATH || path.startsWith(INTERNAL_PREFIX)) continue;
      result[path] = normalizeMeta(item);
    }
    return result;
  }
  if (isRecord(files)) {
    for (const [rawPath, value] of Object.entries(files)) {
      const path = cleanPath(rawPath);
      if (path === MANIFEST_PATH || path.startsWith(INTERNAL_PREFIX)) continue;
      result[path] = normalizeMeta(value);
    }
    return result;
  }
  throw httpError(400, "invalid_manifest", "files must be an array or object");
}
export function normalizeMeta(value: unknown): FileMeta {
  const size = Number(field(value, "size"));
  const rawSha = field(value, "sha256");
  const sha256 = String(rawSha || "").toLowerCase();
  if (!Number.isSafeInteger(size) || size < 0)
    throw httpError(400, "invalid_size", "invalid file size");
  if (!/^[0-9a-f]{64}$/.test(sha256))
    throw httpError(400, "invalid_sha256", "sha256 must be 64 hex characters");
  return { size, sha256 };
}
export function normalizeDeviceId(value: unknown): string {
  const deviceId = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(deviceId))
    throw httpError(
      400,
      "invalid_device_id",
      "deviceId must be 2-64 characters using letters, numbers, dot, underscore or hyphen",
    );
  return deviceId;
}
export function normalizeOptionalSha(
  value: unknown,
  name: string,
): string | null {
  return value == null || value === "" ? null : normalizeSha(value, name);
}
export function normalizeSha(value: unknown, name: string): string {
  const sha = String(value || "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw httpError(400, "invalid_sha", `${name} must be a 40-character SHA`);
  return sha;
}
export function normalizeMessage(value: unknown, deviceId: string): string {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 240)
    : `VaultBridge sync from ${deviceId} ${new Date().toISOString()}`;
}
