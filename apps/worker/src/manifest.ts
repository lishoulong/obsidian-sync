import { INTERNAL_PREFIX, MANIFEST_PATH } from "./constants.js";
import { base64ToBytes, bytesToBase64, sha256Hex } from "./encoding.js";
import { gh } from "./github.js";
import { HttpError, httpError } from "./http.js";
import { cleanPath, encodePath } from "./paths.js";
import { normalizeManifest } from "./validation.js";
import { field, isRecord } from "./types.js";
import type {
  Env,
  GitBlob,
  GitCommit,
  GitTree,
  Manifest,
  RemoteManifest,
} from "./types.js";
export async function applyManifestPatch(
  env: Env,
  remoteCommitSha: string,
  upsert: Manifest,
  deletePaths: string[],
): Promise<Manifest> {
  const manifest: Manifest = await readManifestWithFallback(
    env,
    remoteCommitSha,
  );
  for (const path of deletePaths) delete manifest[path];
  for (const [path, meta] of Object.entries(upsert)) manifest[path] = meta;
  return manifest;
}
export async function createManifestBlob(
  env: Env,
  manifest: Manifest,
): Promise<GitBlob> {
  const content = JSON.stringify(
    {
      version: 2,
      generatedAt: new Date().toISOString(),
      files: serializeManifest(manifest),
    },
    null,
    2,
  );
  return gh<GitBlob>(env, "/git/blobs", {
    method: "POST",
    body: {
      content: bytesToBase64(new TextEncoder().encode(content)),
      encoding: "base64",
    },
  });
}
function serializeManifest(manifest: Manifest): Manifest {
  const files: Manifest = {};
  for (const [path, meta] of Object.entries(manifest))
    files[path] = { size: meta.size, sha256: meta.sha256 };
  return files;
}
export async function readManifestWithFallback(
  env: Env,
  commitSha: string,
): Promise<RemoteManifest> {
  const manifest = await readRemoteManifest(env, commitSha);
  return Object.keys(manifest).length > 0
    ? manifest
    : buildManifestFromTree(env, commitSha);
}
async function buildManifestFromTree(
  env: Env,
  commitSha: string,
): Promise<RemoteManifest> {
  const tree = await readRemoteTree(env, commitSha);
  const result: RemoteManifest = {};
  for (const [path, item] of Object.entries(tree)) {
    const blob = await gh<GitBlob>(env, `/git/blobs/${item.sha}`);
    if (blob.encoding !== "base64" || typeof blob.content !== "string")
      throw httpError(502, "invalid_github_blob", `Unable to hash ${path}`);
    const bytes = base64ToBytes(blob.content.replace(/\n/g, ""));
    result[path] = {
      size: bytes.length,
      sha256: await sha256Hex(bytes),
      remoteBlobSha: item.sha,
    };
  }
  return result;
}
async function readRemoteManifest(
  env: Env,
  ref: string,
): Promise<RemoteManifest> {
  try {
    const data = await gh<unknown>(
      env,
      `/contents/${encodePath(MANIFEST_PATH)}?ref=${encodeURIComponent(ref)}`,
    );
    const encoding = field(data, "encoding"),
      content = field(data, "content");
    if (encoding !== "base64" || typeof content !== "string") return {};
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(base64ToBytes(content.replace(/\n/g, ""))),
    ) as unknown;
    const normalized = normalizeManifest(field(parsed, "files") ?? {});
    const tree = await readRemoteTree(env, ref);
    const result: RemoteManifest = {};
    for (const [path, meta] of Object.entries(normalized)) {
      const item = tree[path];
      if (item) result[path] = { ...meta, remoteBlobSha: item.sha };
    }
    return result;
  } catch (error: unknown) {
    if (error instanceof HttpError && error.status === 404) return {};
    throw error;
  }
}
async function readRemoteTree(
  env: Env,
  commitSha: string,
): Promise<Record<string, { sha: string; size: number }>> {
  const commitObject = await gh<GitCommit>(env, `/git/commits/${commitSha}`);
  const tree = await gh<GitTree>(
    env,
    `/git/trees/${commitObject.tree.sha}?recursive=1`,
  );
  if (tree.truncated)
    throw httpError(
      413,
      "tree_too_large",
      "GitHub truncated the recursive tree; split the vault or implement paged traversal",
    );
  const result: Record<string, { sha: string; size: number }> = {};
  for (const item of tree.tree ?? []) {
    if (item.type !== "blob") continue;
    const path = cleanPath(item.path);
    if (
      path === MANIFEST_PATH ||
      path.startsWith(INTERNAL_PREFIX) ||
      path.startsWith(".git/")
    )
      continue;
    result[path] = { sha: item.sha, size: Number(item.size || 0) };
  }
  return result;
}
export async function assertCommitExists(
  env: Env,
  commitSha: string,
): Promise<void> {
  try {
    await gh<GitCommit>(env, `/git/commits/${commitSha}`);
  } catch (error: unknown) {
    if (
      error instanceof HttpError &&
      (error.status === 404 || error.status === 422)
    )
      throw httpError(
        409,
        "base_commit_unavailable",
        "The device base commit is no longer available; bootstrap is required",
      );
    throw error;
  }
}
