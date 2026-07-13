const API_VERSION = "2022-11-28";
const MANIFEST_PATH = ".vaultbridge/manifest.json";
const INTERNAL_PREFIX = ".vaultbridge/";
const SESSION_TTL_SECONDS = 15 * 60;

export default {
  async fetch(request, env) {
    const ctx = createRequestContext(request);
    try {
      if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
      const url = new URL(request.url);
      log(ctx, "request_start", { path: url.pathname });
      if (url.pathname === "/health" && request.method === "GET") {
        const config = getConfigStatus(env);
        return cors(json({
          ok: true,
          service: "vaultbridge",
          version: "0.3.3",
          protocol: 2,
          mode: "self-hosted",
          configured: config.ok,
          missingConfig: config.missing,
          requestId: ctx.id
        }));
      }

      requireAuth(request, env);

      // Protocol v2
      if (url.pathname === "/v2/setup/check" && request.method === "GET") return cors(await setupCheckV2(env, ctx));
      if (url.pathname === "/v2/sync/check" && request.method === "POST") return cors(await syncCheckV2(request, env, ctx));
      if (url.pathname === "/v2/pull/file" && request.method === "POST") return cors(await pullFileV2(request, env, ctx));
      if (url.pathname === "/v2/blob" && request.method === "POST") return cors(await createBlob(request, env, ctx));
      if (url.pathname === "/v2/commit" && request.method === "POST") return cors(await commitV2(request, env, ctx));

      // v1 remains temporarily available for migration.
      if (url.pathname === "/v1/check" && request.method === "POST") return cors(await checkPushV1(request, env, ctx));
      if (url.pathname === "/v1/blob" && request.method === "POST") return cors(await createBlob(request, env, ctx));
      if (url.pathname === "/v1/commit" && request.method === "POST") return cors(await commitV1(request, env, ctx));

      log(ctx, "request_not_found", { path: url.pathname });
      return cors(json({ error: "not_found", requestId: ctx.id }, 404));
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      log(ctx, "request_error", { status, code: error.code || "internal_error", message: error.message });
      return cors(json({ error: error.code || "internal_error", message: error.message, details: error.details, requestId: ctx.id }, status));
    }
  }
};

async function setupCheckV2(env, ctx) {
  const config = repositoryConfig(env);
  const repository = await gh(env, "");
  const ref = await gh(env, `/git/ref/heads/${encodeURIComponent(config.branch)}`);
  log(ctx, "setup_check_success", {
    repository: `${config.owner}/${config.repo}`,
    branch: config.branch,
    commitSha: ref.object.sha
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
      headCommitSha: ref.object.sha
    },
    limits: {
      maxFileBytes: maxFileBytes(env)
    },
    manifestPath: MANIFEST_PATH
  });
}

async function syncCheckV2(request, env, ctx) {
  const body = await readJson(request);
  const deviceId = normalizeDeviceId(body.deviceId);
  const local = normalizeManifest(body.files || {});
  const lastSyncedCommitSha = normalizeOptionalSha(body.lastSyncedCommitSha, "lastSyncedCommitSha");
  const config = repositoryConfig(env);

  const ref = await gh(env, `/git/ref/heads/${encodeURIComponent(config.branch)}`);
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
    conflict: previewPaths(plan.conflict)
  });
  const sessionToken = await signSession(env, {
    v: 2,
    deviceId,
    repository: `${config.owner}/${config.repo}`,
    branch: config.branch,
    baseCommitSha: lastSyncedCommitSha,
    remoteCommitSha,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
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
    nextDeviceState: plan.conflict.length === 0 && plan.upload.length === 0 && plan.deleteRemote.length === 0
      ? { version: 2, deviceId, lastSyncedCommitSha: remoteCommitSha }
      : null
  });
}

function compareThreeWay({ local, remote, base, bootstrap }) {
  const download = [];
  const deleteLocal = [];
  const upload = [];
  const deleteRemote = [];
  const conflict = [];
  const unchanged = [];
  const paths = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)]);

  for (const path of [...paths].sort()) {
    const l = local[path];
    const r = remote[path];
    const b = base[path];

    if (bootstrap || !b) {
      if (l && r) {
        if (sameMeta(l, r)) unchanged.push({ path });
        else conflict.push({ path, reason: "no_common_base", remoteBlobSha: r.remoteBlobSha, remoteSize: r.size });
      } else if (l) {
        upload.push({ path, reason: "local_added" });
      } else if (r) {
        download.push({ path, reason: "remote_added", remoteBlobSha: r.remoteBlobSha, size: r.size, sha256: r.sha256 });
      }
      continue;
    }

    const localChanged = !sameMeta(l, b);
    const remoteChanged = !sameMeta(r, b);

    if (!localChanged && !remoteChanged) {
      unchanged.push({ path });
      continue;
    }
    if (!localChanged && remoteChanged) {
      if (r) download.push({ path, reason: "remote_modified", remoteBlobSha: r.remoteBlobSha, size: r.size, sha256: r.sha256 });
      else deleteLocal.push({ path, reason: "remote_deleted" });
      continue;
    }
    if (localChanged && !remoteChanged) {
      if (l) upload.push({ path, reason: b ? "local_modified" : "local_added" });
      else deleteRemote.push({ path, reason: "local_deleted" });
      continue;
    }

    // Both sides changed. Matching content or matching deletion has converged.
    if (sameMeta(l, r)) {
      unchanged.push({ path, reason: "converged" });
    } else {
      conflict.push({
        path,
        reason: conflictReason(l, r),
        remoteBlobSha: r?.remoteBlobSha,
        remoteSize: r?.size
      });
    }
  }

  return {
    download,
    deleteLocal,
    upload,
    deleteRemote,
    conflict,
    unchanged,
    counts: {
      download: download.length,
      deleteLocal: deleteLocal.length,
      upload: upload.length,
      deleteRemote: deleteRemote.length,
      conflict: conflict.length,
      unchanged: unchanged.length
    }
  };
}

function conflictReason(local, remote) {
  if (!local && remote) return "local_deleted_remote_modified";
  if (local && !remote) return "remote_deleted_local_modified";
  return "both_modified";
}

async function pullFileV2(request, env, ctx) {
  const body = await readJson(request);
  const session = await verifySession(env, body.sessionToken);
  const path = cleanPath(body.path);
  const blobSha = normalizeSha(body.blobSha, "blobSha");

  const manifest = await readManifestWithFallback(env, session.remoteCommitSha);
  if (!manifest[path] || manifest[path].remoteBlobSha !== blobSha) {
    throw httpError(409, "pull_snapshot_changed", "The requested file does not match the signed remote snapshot");
  }

  const blob = await gh(env, `/git/blobs/${blobSha}`);
  if (blob.encoding !== "base64" || typeof blob.content !== "string") throw httpError(502, "invalid_github_blob", "GitHub did not return base64 content");
  const content = blob.content.replace(/\n/g, "");
  const bytes = base64ToBytes(content);
  log(ctx, "pull_file_success", {
    deviceId: session.deviceId,
    remoteCommitSha: session.remoteCommitSha,
    path,
    blobSha,
    size: bytes.length
  });
  return json({
    requestId: ctx.id,
    path,
    commitSha: session.remoteCommitSha,
    blobSha,
    encoding: "base64",
    content,
    size: bytes.length,
    sha256: await sha256Hex(bytes)
  });
}

async function createBlob(request, env, ctx) {
  const body = await readJson(request);
  const path = cleanPath(body.path);
  ensureUserPath(path);
  if (body.encoding !== "base64") throw httpError(400, "invalid_encoding", "encoding must be base64");
  if (typeof body.content !== "string") throw httpError(400, "invalid_content", "content must be a base64 string");

  const approxBytes = Math.floor(body.content.length * 0.75);
  const max = maxFileBytes(env);
  if (approxBytes > max) throw httpError(413, "file_too_large", `file exceeds ${max} bytes`);

  const blob = await gh(env, "/git/blobs", { method: "POST", body: { content: body.content, encoding: "base64" } });
  log(ctx, "blob_create_success", { path, blobSha: blob.sha, approxBytes });
  return json({ requestId: ctx.id, path, sha: blob.sha });
}

async function commitV2(request, env, ctx) {
  const body = await readJson(request);
  const session = await verifySession(env, body.sessionToken);
  const deviceId = normalizeDeviceId(body.deviceId);
  if (deviceId !== session.deviceId) throw httpError(403, "device_mismatch", "deviceId does not match the signed session");

  const fullManifestMode = body.files !== undefined;
  const patchBody = body.patch && typeof body.patch === "object" ? body.patch : {};
  const upsert = normalizeManifest(patchBody.upload || body.upsert || {});
  const deletePaths = normalizeDeletePaths(patchBody.delete || body.delete);
  validatePatch(upsert, deletePaths);
  const manifest = fullManifestMode
    ? normalizeManifest(body.files || {})
    : await applyManifestPatch(env, session.remoteCommitSha, upsert, deletePaths);
  const blobs = normalizeBlobEntries(body.blobs, manifest, fullManifestMode ? null : upsert);
  const deletions = normalizeDeletions(deletePaths, manifest);
  const message = normalizeMessage(body.message, deviceId);

  const currentRef = await gh(env, `/git/ref/heads/${encodeURIComponent(branch(env))}`);
  if (currentRef.object.sha !== session.remoteCommitSha) {
    throw httpError(409, "sync_session_stale", "The remote branch changed after the sync plan was created");
  }

  const baseCommit = await gh(env, `/git/commits/${session.remoteCommitSha}`);
  const entries = [...blobs, ...deletions];
  const manifestBlob = await createManifestBlob(env, manifest);
  entries.push({ path: MANIFEST_PATH, mode: "100644", type: "blob", sha: manifestBlob.sha });

  const tree = await gh(env, "/git/trees", { method: "POST", body: { base_tree: baseCommit.tree.sha, tree: entries } });
  const newCommit = await gh(env, "/git/commits", {
    method: "POST",
    body: { message, tree: tree.sha, parents: [session.remoteCommitSha] }
  });
  await gh(env, `/git/refs/heads/${encodeURIComponent(branch(env))}`, {
    method: "PATCH",
    body: { sha: newCommit.sha, force: false }
  });

  log(ctx, "commit_success", {
    deviceId,
    previousCommitSha: session.remoteCommitSha,
    commitSha: newCommit.sha,
    changed: entries.length - 1,
    blobs: blobs.length,
    delete: deletions.length,
    mode: fullManifestMode ? "full" : "patch"
  });

  return json({
    ok: true,
    protocol: 2,
    requestId: ctx.id,
    commitSha: newCommit.sha,
    treeSha: tree.sha,
    changed: entries.length - 1,
    deviceState: { version: 2, deviceId, lastSyncedCommitSha: newCommit.sha }
  });
}

async function applyManifestPatch(env, remoteCommitSha, upsert, deletePaths) {
  const manifest = await readManifestWithFallback(env, remoteCommitSha);
  for (const path of deletePaths) delete manifest[path];
  for (const [path, meta] of Object.entries(upsert)) manifest[path] = meta;
  return manifest;
}

function validatePatch(upsert, deletePaths) {
  for (const path of deletePaths) {
    if (path in upsert) throw httpError(400, "patch_mismatch", `${path} cannot be uploaded and deleted in the same patch`);
  }
}

function normalizeBlobEntries(input, manifest, requiredUpsert) {
  const blobs = Array.isArray(input) ? input : [];
  const entries = [];
  const seen = new Set();
  for (const item of blobs) {
    const path = cleanPath(item.path);
    ensureUserPath(path);
    const sha = normalizeSha(item.sha, `blob sha for ${path}`);
    if (!(path in manifest)) throw httpError(400, "manifest_mismatch", `${path} is missing from files manifest`);
    if (requiredUpsert && !(path in requiredUpsert)) throw httpError(400, "patch_mismatch", `${path} blob is missing from upsert patch`);
    if (seen.has(path)) throw httpError(400, "duplicate_path", path);
    seen.add(path);
    entries.push({ path, mode: "100644", type: "blob", sha });
  }
  if (requiredUpsert) {
    for (const path of Object.keys(requiredUpsert)) {
      if (!seen.has(path)) throw httpError(400, "patch_mismatch", `${path} upsert is missing a blob`);
    }
  }
  return entries;
}

function normalizeDeletePaths(input) {
  const values = Array.isArray(input) ? input : [];
  const seen = new Set();
  const paths = [];
  for (const raw of values) {
    const path = cleanPath(raw);
    ensureUserPath(path);
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

function normalizeDeletions(paths, manifest) {
  const entries = [];
  for (const path of paths) {
    if (path in manifest) continue;
    entries.push({ path, mode: "100644", type: "blob", sha: null });
  }
  return entries;
}

async function createManifestBlob(env, manifest) {
  const content = JSON.stringify({ version: 2, generatedAt: new Date().toISOString(), files: serializeManifest(manifest) }, null, 2);
  return gh(env, "/git/blobs", {
    method: "POST",
    body: { content: bytesToBase64(new TextEncoder().encode(content)), encoding: "base64" }
  });
}

function serializeManifest(manifest) {
  const files = {};
  for (const [path, meta] of Object.entries(manifest)) {
    files[path] = { size: meta.size, sha256: meta.sha256 };
  }
  return files;
}

async function readManifestWithFallback(env, commitSha) {
  const manifest = await readRemoteManifest(env, commitSha);
  if (Object.keys(manifest).length > 0) return manifest;
  return buildManifestFromTree(env, commitSha);
}

async function buildManifestFromTree(env, commitSha) {
  const tree = await readRemoteTree(env, commitSha);
  const result = {};
  for (const [path, item] of Object.entries(tree)) {
    const blob = await gh(env, `/git/blobs/${item.sha}`);
    if (blob.encoding !== "base64" || typeof blob.content !== "string") throw httpError(502, "invalid_github_blob", `Unable to hash ${path}`);
    const bytes = base64ToBytes(blob.content.replace(/\n/g, ""));
    result[path] = { size: bytes.length, sha256: await sha256Hex(bytes), remoteBlobSha: item.sha };
  }
  return result;
}

async function readRemoteManifest(env, ref) {
  try {
    const data = await gh(env, `/contents/${encodePath(MANIFEST_PATH)}?ref=${encodeURIComponent(ref)}`);
    if (data.encoding !== "base64" || typeof data.content !== "string") return {};
    const text = new TextDecoder().decode(base64ToBytes(data.content.replace(/\n/g, "")));
    const parsed = JSON.parse(text);
    const normalized = normalizeManifest(parsed.files || {});

    const tree = await readRemoteTree(env, ref);
    const result = {};
    for (const [path, meta] of Object.entries(normalized)) {
      const item = tree[path];
      if (item) result[path] = { ...meta, remoteBlobSha: item.sha };
    }
    return result;
  } catch (error) {
    if (error.status === 404) return {};
    throw error;
  }
}

async function readRemoteTree(env, commitSha) {
  const commitObject = await gh(env, `/git/commits/${commitSha}`);
  const tree = await gh(env, `/git/trees/${commitObject.tree.sha}?recursive=1`);
  if (tree.truncated) throw httpError(413, "tree_too_large", "GitHub truncated the recursive tree; split the vault or implement paged traversal");
  const result = {};
  for (const item of tree.tree || []) {
    if (item.type !== "blob") continue;
    const path = cleanPath(item.path);
    if (path === MANIFEST_PATH || path.startsWith(INTERNAL_PREFIX) || path.startsWith(".git/")) continue;
    result[path] = { sha: item.sha, size: Number(item.size || 0) };
  }
  return result;
}

async function assertCommitExists(env, commitSha) {
  try {
    await gh(env, `/git/commits/${commitSha}`);
  } catch (error) {
    if (error.status === 404 || error.status === 422) throw httpError(409, "base_commit_unavailable", "The device base commit is no longer available; bootstrap is required");
    throw error;
  }
}

function sameMeta(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.size === b.size && a.sha256 === b.sha256;
}

async function signSession(env, payload) {
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(required(env.SYNC_TOKEN, "SYNC_TOKEN")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded)));
  return `${encoded}.${base64UrlEncode(signature)}`;
}

async function verifySession(env, token) {
  if (typeof token !== "string" || !token.includes(".")) throw httpError(400, "invalid_session", "sessionToken is required");
  const [encoded, suppliedSignature] = token.split(".");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(required(env.SYNC_TOKEN, "SYNC_TOKEN")), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("HMAC", key, base64UrlDecode(suppliedSignature), new TextEncoder().encode(encoded));
  if (!ok) throw httpError(401, "invalid_session", "session signature is invalid");
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded))); }
  catch { throw httpError(400, "invalid_session", "session payload is invalid"); }
  if (payload.v !== 2 || !payload.deviceId || !payload.remoteCommitSha) throw httpError(400, "invalid_session", "session payload is incomplete");
  if (!Number.isFinite(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)) throw httpError(409, "sync_session_expired", "The sync session expired; run /v2/sync/check again");
  const config = repositoryConfig(env);
  if (payload.repository && payload.repository !== `${config.owner}/${config.repo}`) throw httpError(409, "sync_session_stale", "The Worker repository configuration changed; run /v2/sync/check again");
  if (payload.branch && payload.branch !== config.branch) throw httpError(409, "sync_session_stale", "The Worker branch configuration changed; run /v2/sync/check again");
  return payload;
}

function base64UrlEncode(bytes) {
  return bytesToBase64(bytes).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function base64UrlDecode(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  return base64ToBytes(base64);
}

// ---- Protocol v1 compatibility ----
async function checkPushV1(request, env, ctx) {
  const body = await readJson(request);
  const clientManifest = normalizeManifest(body.files);
  const ref = await gh(env, `/git/ref/heads/${encodeURIComponent(branch(env))}`);
  const baseCommitSha = ref.object.sha;
  const commitObject = await gh(env, `/git/commits/${baseCommitSha}`);
  const remoteManifest = await readManifestWithFallback(env, baseCommitSha);
  const upload = Object.entries(clientManifest).filter(([path, meta]) => !sameMeta(meta, remoteManifest[path])).map(([path]) => path);
  const remove = Object.keys(remoteManifest).filter((path) => !(path in clientManifest));
  log(ctx, "v1_check_plan", { baseCommitSha, upload: upload.length, delete: remove.length });
  return json({ requestId: ctx.id, baseCommitSha, baseTreeSha: commitObject.tree.sha, upload, delete: remove });
}

async function commitV1(request, env, ctx) {
  const body = await readJson(request);
  const baseCommitSha = normalizeSha(body.baseCommitSha, "baseCommitSha");
  const manifest = normalizeManifest(body.files || {});
  const currentRef = await gh(env, `/git/ref/heads/${encodeURIComponent(branch(env))}`);
  if (currentRef.object.sha !== baseCommitSha) throw httpError(409, "remote_changed", "The branch changed after /v1/check");
  const config = repositoryConfig(env);
  const sessionToken = await signSession(env, {
    v: 2,
    deviceId: "legacy-v1",
    repository: `${config.owner}/${config.repo}`,
    branch: config.branch,
    baseCommitSha,
    remoteCommitSha: baseCommitSha,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  });
  const synthetic = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify({ ...body, deviceId: "legacy-v1", sessionToken, files: manifest })
  });
  return commitV2(synthetic, env, ctx);
}

function normalizeManifest(files) {
  const result = {};
  if (Array.isArray(files)) {
    for (const item of files) {
      const path = cleanPath(item.path);
      if (path === MANIFEST_PATH || path.startsWith(INTERNAL_PREFIX)) continue;
      result[path] = normalizeMeta(item);
    }
    return result;
  }
  if (files && typeof files === "object") {
    for (const [rawPath, value] of Object.entries(files)) {
      const path = cleanPath(rawPath);
      if (path === MANIFEST_PATH || path.startsWith(INTERNAL_PREFIX)) continue;
      result[path] = normalizeMeta(value);
    }
    return result;
  }
  throw httpError(400, "invalid_manifest", "files must be an array or object");
}

function normalizeMeta(value) {
  const size = Number(value?.size);
  const sha256 = String(value?.sha256 || "").toLowerCase();
  if (!Number.isSafeInteger(size) || size < 0) throw httpError(400, "invalid_size", "invalid file size");
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw httpError(400, "invalid_sha256", "sha256 must be 64 hex characters");
  return { size, sha256 };
}

function normalizeDeviceId(value) {
  const deviceId = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(deviceId)) throw httpError(400, "invalid_device_id", "deviceId must be 2-64 characters using letters, numbers, dot, underscore or hyphen");
  return deviceId;
}
function normalizeOptionalSha(value, name) { return value == null || value === "" ? null : normalizeSha(value, name); }
function normalizeSha(value, name) {
  const sha = String(value || "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw httpError(400, "invalid_sha", `${name} must be a 40-character SHA`);
  return sha;
}
function normalizeMessage(value, deviceId) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 240)
    : `VaultBridge sync from ${deviceId} ${new Date().toISOString()}`;
}
function ensureUserPath(path) {
  if (path === MANIFEST_PATH || path.startsWith(INTERNAL_PREFIX)) throw httpError(400, "reserved_path", `${INTERNAL_PREFIX} is reserved`);
}
function cleanPath(input) {
  if (typeof input !== "string") throw httpError(400, "invalid_path", "path must be a string");
  const path = input.normalize("NFC").replace(/^\/+/, "").replace(/\\/g, "/");
  if (!path || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === "..")) throw httpError(400, "invalid_path", input);
  if (path.startsWith(".git/")) throw httpError(400, "invalid_path", ".git is not allowed");
  return path;
}

function requireAuth(request, env) {
  if (!env.SYNC_TOKEN) throw httpError(500, "missing_config", "SYNC_TOKEN is not configured");
  if ((request.headers.get("authorization") || "") !== `Bearer ${env.SYNC_TOKEN}`) throw httpError(401, "unauthorized", "invalid sync token");
}
async function gh(env, path, options = {}) {
  if (!env.GITHUB_TOKEN) throw httpError(500, "missing_config", "GITHUB_TOKEN is not configured");
  const config = repositoryConfig(env);
  const response = await fetch(`https://api.github.com/repos/${config.owner}/${config.repo}${path}`, {
    method: options.method || "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "VaultBridge-Worker",
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? safeJson(text) : {};
  if (!response.ok) {
    const error = httpError(response.status, "github_error", data.message || `GitHub returned ${response.status}`);
    error.details = data;
    throw error;
  }
  return data;
}
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
function owner(env) { return repositoryConfig(env).owner; }
function repo(env) { return repositoryConfig(env).repo; }
function branch(env) { return repositoryConfig(env).branch; }
function repositoryConfig(env) {
  const combined = String(env.GITHUB_REPOSITORY || "").trim();
  const [combinedOwner, combinedRepo, extra] = combined ? combined.split("/") : [];
  if (extra) throw httpError(500, "invalid_config", "GITHUB_REPOSITORY must use owner/repo format");

  const owner = String(env.GITHUB_OWNER || combinedOwner || "").trim();
  const repo = String(env.GITHUB_REPO || combinedRepo || "").trim();
  const branch = String(env.GITHUB_BRANCH || "main").trim();

  validateGitHubName(owner, "GITHUB_OWNER");
  validateGitHubName(repo, "GITHUB_REPO");
  validateBranchName(branch);
  return { owner, repo, branch };
}
function getConfigStatus(env) {
  const missing = [];
  if (!env.SYNC_TOKEN) missing.push("SYNC_TOKEN");
  if (!env.GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
  try { repositoryConfig(env); }
  catch (error) {
    if (!env.GITHUB_REPOSITORY && !env.GITHUB_OWNER) missing.push("GITHUB_OWNER or GITHUB_REPOSITORY");
    if (!env.GITHUB_REPOSITORY && !env.GITHUB_REPO) missing.push("GITHUB_REPO or GITHUB_REPOSITORY");
    if (!missing.length) missing.push(error.message);
  }
  return { ok: missing.length === 0, missing };
}
function validateGitHubName(value, name) {
  if (!value) throw httpError(500, "missing_config", `${name} is required`);
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw httpError(500, "invalid_config", `${name} contains invalid characters`);
}
function validateBranchName(value) {
  if (!value) throw httpError(500, "missing_config", "GITHUB_BRANCH is required");
  if (value.includes("..") || value.startsWith("/") || value.endsWith("/") || value.includes("\\")) {
    throw httpError(500, "invalid_config", "GITHUB_BRANCH is invalid");
  }
}
function maxFileBytes(env) {
  const max = Number(env.MAX_FILE_BYTES || 20 * 1024 * 1024);
  if (!Number.isSafeInteger(max) || max <= 0) throw httpError(500, "invalid_config", "MAX_FILE_BYTES must be a positive integer");
  return max;
}
function required(value, name) { if (!value) throw httpError(500, "missing_config", `${name} is required`); return value; }
function encodePath(path) { return path.split("/").map(encodeURIComponent).join("/"); }
function safeJson(text) { try { return JSON.parse(text); } catch { return { message: text }; } }
async function readJson(request) { try { return await request.json(); } catch { throw httpError(400, "invalid_json", "request body must be JSON"); } }
function httpError(status, code, message) { const error = new Error(message); error.status = status; error.code = code; return error; }
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } }); }
function createRequestContext(request) {
  const url = new URL(request.url);
  return {
    id: crypto.randomUUID(),
    method: request.method,
    path: url.pathname
  };
}
function log(ctx, event, data = {}) {
  console.log(JSON.stringify({
    service: "vaultbridge",
    event,
    requestId: ctx.id,
    method: ctx.method,
    path: ctx.path,
    ...data
  }));
}
function previewPaths(entries) {
  return entries.slice(0, 8).map((entry) => entry.path).filter(Boolean);
}
function cors(response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
