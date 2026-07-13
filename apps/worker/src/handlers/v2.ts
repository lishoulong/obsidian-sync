import { MANIFEST_PATH, SESSION_TTL_SECONDS } from "../constants.js";
import { branch, maxFileBytes, repositoryConfig } from "../config.js";
import { base64ToBytes, sha256Hex } from "../encoding.js";
import { gh } from "../github.js";
import { httpError, json, readJson } from "../http.js";
import {
  applyManifestPatch,
  assertCommitExists,
  createManifestBlob,
  readManifestWithFallback,
} from "../manifest.js";
import { log, previewPaths } from "../observability.js";
import { cleanPath, ensureUserPath } from "../paths.js";
import { signSession, verifySession } from "../session.js";
import { compareThreeWay } from "../sync-plan.js";
import {
  normalizeBlobEntries,
  normalizeDeletePaths,
  normalizeDeletions,
  normalizeDeviceId,
  normalizeManifest,
  normalizeMessage,
  normalizeOptionalSha,
  normalizeSha,
  validatePatch,
} from "../validation.js";
import { field, isRecord } from "../types.js";
import type {
  Env,
  GitBlob,
  GitCommit,
  GitRef,
  GitRepository,
  GitTree,
  RequestContext,
} from "../types.js";

export async function setupCheckV2(
  env: Env,
  ctx: RequestContext,
): Promise<Response> {
  const config = repositoryConfig(env);
  const repository = await gh<GitRepository>(env, "");
  const ref = await gh<GitRef>(
    env,
    `/git/ref/heads/${encodeURIComponent(config.branch)}`,
  );
  log(ctx, "setup_check_success", {
    repository: `${config.owner}/${config.repo}`,
    branch: config.branch,
    commitSha: ref.object.sha,
  });

  return json({
    ok: true,
    protocol: 2,
    mode: "self-hosted",
    requestId: ctx.id,
    repository: {
      owner: config.owner,
      repo: config.repo,
      fullName: repository.full_name || `${config.owner}/${config.repo}`,
      private: Boolean(repository.private),
      defaultBranch: repository.default_branch,
      branch: config.branch,
      headCommitSha: ref.object.sha,
    },
    limits: {
      maxFileBytes: maxFileBytes(env),
    },
    manifestPath: MANIFEST_PATH,
  });
}

export async function syncCheckV2(
  request: Request,
  env: Env,
  ctx: RequestContext,
): Promise<Response> {
  const body = await readJson(request);
  const deviceId = normalizeDeviceId(field(body, "deviceId"));
  const local = normalizeManifest(field(body, "files") || {});
  const lastSyncedCommitSha = normalizeOptionalSha(
    field(body, "lastSyncedCommitSha"),
    "lastSyncedCommitSha",
  );
  const config = repositoryConfig(env);

  const ref = await gh<GitRef>(
    env,
    `/git/ref/heads/${encodeURIComponent(config.branch)}`,
  );
  const remoteCommitSha = ref.object.sha;
  const remote = await readManifestWithFallback(env, remoteCommitSha);

  let base = {};
  let bootstrap = false;
  if (lastSyncedCommitSha) {
    await assertCommitExists(env, lastSyncedCommitSha);
    base = await readManifestWithFallback(env, lastSyncedCommitSha);
  } else {
    bootstrap = true;
  }

  const plan = compareThreeWay({ local, remote, base, bootstrap });
  log(ctx, "sync_check_plan", {
    deviceId,
    bootstrap,
    baseCommitSha: lastSyncedCommitSha,
    remoteCommitSha,
    localFiles: Object.keys(local).length,
    remoteFiles: Object.keys(remote).length,
    baseFiles: Object.keys(base).length,
    counts: plan.counts,
    download: previewPaths(plan.download),
    deleteLocal: previewPaths(plan.deleteLocal),
    upload: previewPaths(plan.upload),
    deleteRemote: previewPaths(plan.deleteRemote),
    conflict: previewPaths(plan.conflict),
  });
  const sessionToken = await signSession(env, {
    v: 2,
    deviceId,
    repository: `${config.owner}/${config.repo}`,
    branch: config.branch,
    baseCommitSha: lastSyncedCommitSha,
    remoteCommitSha,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  });

  return json({
    protocol: 2,
    requestId: ctx.id,
    deviceId,
    bootstrap,
    baseCommitSha: lastSyncedCommitSha,
    remoteCommitSha,
    sessionToken,
    sessionExpiresInSeconds: SESSION_TTL_SECONDS,
    ...plan,
    nextDeviceState:
      plan.conflict.length === 0 &&
      plan.upload.length === 0 &&
      plan.deleteRemote.length === 0
        ? { version: 2, deviceId, lastSyncedCommitSha: remoteCommitSha }
        : null,
  });
}

export async function pullFileV2(
  request: Request,
  env: Env,
  ctx: RequestContext,
): Promise<Response> {
  const body = await readJson(request);
  const session = await verifySession(env, field(body, "sessionToken"));
  const path = cleanPath(field(body, "path"));
  const blobSha = normalizeSha(field(body, "blobSha"), "blobSha");

  const manifest = await readManifestWithFallback(env, session.remoteCommitSha);
  if (!manifest[path] || manifest[path].remoteBlobSha !== blobSha) {
    throw httpError(
      409,
      "pull_snapshot_changed",
      "The requested file does not match the signed remote snapshot",
    );
  }

  const blob = await gh<GitBlob>(env, `/git/blobs/${blobSha}`);
  if (blob.encoding !== "base64" || typeof blob.content !== "string")
    throw httpError(
      502,
      "invalid_github_blob",
      "GitHub did not return base64 content",
    );
  const content = blob.content.replace(/\n/g, "");
  const bytes = base64ToBytes(content);
  log(ctx, "pull_file_success", {
    deviceId: session.deviceId,
    remoteCommitSha: session.remoteCommitSha,
    path,
    blobSha,
    size: bytes.length,
  });
  return json({
    requestId: ctx.id,
    path,
    commitSha: session.remoteCommitSha,
    blobSha,
    encoding: "base64",
    content,
    size: bytes.length,
    sha256: await sha256Hex(bytes),
  });
}

export async function createBlob(
  request: Request,
  env: Env,
  ctx: RequestContext,
): Promise<Response> {
  const body = await readJson(request);
  const path = cleanPath(field(body, "path"));
  ensureUserPath(path);
  const encoding = field(body, "encoding");
  const content = field(body, "content");
  if (encoding !== "base64")
    throw httpError(400, "invalid_encoding", "encoding must be base64");
  if (typeof content !== "string")
    throw httpError(400, "invalid_content", "content must be a base64 string");

  const approxBytes = Math.floor(content.length * 0.75);
  const max = maxFileBytes(env);
  if (approxBytes > max)
    throw httpError(413, "file_too_large", `file exceeds ${max} bytes`);

  const blob = await gh<GitBlob>(env, "/git/blobs", {
    method: "POST",
    body: { content, encoding: "base64" },
  });
  log(ctx, "blob_create_success", { path, blobSha: blob.sha, approxBytes });
  return json({ requestId: ctx.id, path, sha: blob.sha });
}

export async function commitV2(
  request: Request,
  env: Env,
  ctx: RequestContext,
): Promise<Response> {
  const body = await readJson(request);
  const session = await verifySession(env, field(body, "sessionToken"));
  const deviceId = normalizeDeviceId(field(body, "deviceId"));
  if (deviceId !== session.deviceId)
    throw httpError(
      403,
      "device_mismatch",
      "deviceId does not match the signed session",
    );

  const fullManifestMode = field(body, "files") !== undefined;
  const patchBody = isRecord(field(body, "patch")) ? field(body, "patch") : {};
  const upsert = normalizeManifest(
    field(patchBody, "upload") || field(body, "upsert") || {},
  );
  const deletePaths = normalizeDeletePaths(
    field(patchBody, "delete") || field(body, "delete"),
  );
  validatePatch(upsert, deletePaths);
  const manifest = fullManifestMode
    ? normalizeManifest(field(body, "files") || {})
    : await applyManifestPatch(
        env,
        session.remoteCommitSha,
        upsert,
        deletePaths,
      );
  const blobs = normalizeBlobEntries(
    field(body, "blobs"),
    manifest,
    fullManifestMode ? null : upsert,
  );
  const deletions = normalizeDeletions(deletePaths, manifest);
  const message = normalizeMessage(field(body, "message"), deviceId);

  const currentRef = await gh<GitRef>(
    env,
    `/git/ref/heads/${encodeURIComponent(branch(env))}`,
  );
  if (currentRef.object.sha !== session.remoteCommitSha) {
    throw httpError(
      409,
      "sync_session_stale",
      "The remote branch changed after the sync plan was created",
    );
  }

  const baseCommit = await gh<GitCommit>(
    env,
    `/git/commits/${session.remoteCommitSha}`,
  );
  const entries = [...blobs, ...deletions];
  const manifestBlob = await createManifestBlob(env, manifest);
  entries.push({
    path: MANIFEST_PATH,
    mode: "100644",
    type: "blob",
    sha: manifestBlob.sha,
  });

  const tree = await gh<GitTree>(env, "/git/trees", {
    method: "POST",
    body: { base_tree: baseCommit.tree.sha, tree: entries },
  });
  if (!tree.sha)
    throw httpError(
      502,
      "invalid_github_tree",
      "GitHub did not return a tree SHA",
    );
  const newCommit = await gh<GitCommit>(env, "/git/commits", {
    method: "POST",
    body: { message, tree: tree.sha, parents: [session.remoteCommitSha] },
  });
  if (!newCommit.sha)
    throw httpError(
      502,
      "invalid_github_commit",
      "GitHub did not return a commit SHA",
    );
  await gh(env, `/git/refs/heads/${encodeURIComponent(branch(env))}`, {
    method: "PATCH",
    body: { sha: newCommit.sha, force: false },
  });

  log(ctx, "commit_success", {
    deviceId,
    previousCommitSha: session.remoteCommitSha,
    commitSha: newCommit.sha,
    changed: entries.length - 1,
    blobs: blobs.length,
    delete: deletions.length,
    mode: fullManifestMode ? "full" : "patch",
  });

  return json({
    ok: true,
    protocol: 2,
    requestId: ctx.id,
    commitSha: newCommit.sha,
    treeSha: tree.sha,
    changed: entries.length - 1,
    deviceState: { version: 2, deviceId, lastSyncedCommitSha: newCommit.sha },
  });
}
