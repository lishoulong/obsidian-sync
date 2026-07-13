import { SESSION_TTL_SECONDS } from "../constants.js";
import { branch, repositoryConfig } from "../config.js";
import { gh } from "../github.js";
import { httpError, json, readJson } from "../http.js";
import { readManifestWithFallback } from "../manifest.js";
import { log } from "../observability.js";
import { signSession } from "../session.js";
import { normalizeManifest, normalizeSha, sameMeta } from "../validation.js";
import { commitV2 } from "./v2.js";
import { field } from "../types.js";
import type { Env, GitCommit, GitRef, RequestContext } from "../types.js";

export async function checkPushV1(
  request: Request,
  env: Env,
  ctx: RequestContext,
): Promise<Response> {
  const body = await readJson(request);
  const clientManifest = normalizeManifest(field(body, "files"));
  const ref = await gh<GitRef>(
    env,
    `/git/ref/heads/${encodeURIComponent(branch(env))}`,
  );
  const baseCommitSha = ref.object.sha;
  const commitObject = await gh<GitCommit>(
    env,
    `/git/commits/${baseCommitSha}`,
  );
  const remoteManifest = await readManifestWithFallback(env, baseCommitSha);
  const upload = Object.entries(clientManifest)
    .filter(([path, meta]) => !sameMeta(meta, remoteManifest[path]))
    .map(([path]) => path);
  const remove = Object.keys(remoteManifest).filter(
    (path) => !(path in clientManifest),
  );
  log(ctx, "v1_check_plan", {
    baseCommitSha,
    upload: upload.length,
    delete: remove.length,
  });
  return json({
    requestId: ctx.id,
    baseCommitSha,
    baseTreeSha: commitObject.tree.sha,
    upload,
    delete: remove,
  });
}

export async function commitV1(
  request: Request,
  env: Env,
  ctx: RequestContext,
): Promise<Response> {
  const body = await readJson(request);
  const baseCommitSha = normalizeSha(
    field(body, "baseCommitSha"),
    "baseCommitSha",
  );
  const manifest = normalizeManifest(field(body, "files") || {});
  const currentRef = await gh<GitRef>(
    env,
    `/git/ref/heads/${encodeURIComponent(branch(env))}`,
  );
  if (currentRef.object.sha !== baseCommitSha)
    throw httpError(
      409,
      "remote_changed",
      "The branch changed after /v1/check",
    );
  const config = repositoryConfig(env);
  const sessionToken = await signSession(env, {
    v: 2,
    deviceId: "legacy-v1",
    repository: `${config.owner}/${config.repo}`,
    branch: config.branch,
    baseCommitSha,
    remoteCommitSha: baseCommitSha,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  });
  const synthetic = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify({
      ...(typeof body === "object" && body !== null ? body : {}),
      deviceId: "legacy-v1",
      sessionToken,
      files: manifest,
    }),
  });
  return commitV2(synthetic, env, ctx);
}
