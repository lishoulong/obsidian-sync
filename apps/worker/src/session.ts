import { repositoryConfig, required } from "./config.js";
import { base64ToBytes, bytesToBase64 } from "./encoding.js";
import { httpError } from "./http.js";
import { isRecord } from "./types.js";
import type { Env, SessionPayload } from "./types.js";
export async function signSession(
  env: Env,
  payload: SessionPayload,
): Promise<string> {
  const encoded = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(required(env.SYNC_TOKEN, "SYNC_TOKEN")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded)),
  );
  return `${encoded}.${base64UrlEncode(signature)}`;
}
export async function verifySession(
  env: Env,
  token: unknown,
): Promise<SessionPayload> {
  if (typeof token !== "string" || !token.includes("."))
    throw httpError(400, "invalid_session", "sessionToken is required");
  const parts = token.split(".");
  const encoded = parts[0],
    suppliedSignature = parts[1];
  if (!encoded || !suppliedSignature)
    throw httpError(400, "invalid_session", "sessionToken is required");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(required(env.SYNC_TOKEN, "SYNC_TOKEN")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlDecode(suppliedSignature),
      new TextEncoder().encode(encoded),
    ))
  )
    throw httpError(401, "invalid_session", "session signature is invalid");
  let raw: unknown;
  try {
    raw = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(encoded)),
    ) as unknown;
  } catch {
    throw httpError(400, "invalid_session", "session payload is invalid");
  }
  if (
    !isRecord(raw) ||
    raw.v !== 2 ||
    typeof raw.deviceId !== "string" ||
    typeof raw.remoteCommitSha !== "string" ||
    typeof raw.repository !== "string" ||
    typeof raw.branch !== "string" ||
    (raw.baseCommitSha !== null && typeof raw.baseCommitSha !== "string") ||
    typeof raw.exp !== "number"
  )
    throw httpError(400, "invalid_session", "session payload is incomplete");
  const payload: SessionPayload = {
    v: 2,
    deviceId: raw.deviceId,
    remoteCommitSha: raw.remoteCommitSha,
    repository: raw.repository,
    branch: raw.branch,
    baseCommitSha: raw.baseCommitSha,
    exp: raw.exp,
  };
  if (
    !Number.isFinite(payload.exp) ||
    payload.exp < Math.floor(Date.now() / 1000)
  )
    throw httpError(
      409,
      "sync_session_expired",
      "The sync session expired; run /v2/sync/check again",
    );
  const config = repositoryConfig(env);
  if (
    payload.repository !== `${config.owner}/${config.repo}` ||
    payload.branch !== config.branch
  )
    throw httpError(
      409,
      "sync_session_stale",
      "The Worker repository configuration changed; run /v2/sync/check again",
    );
  return payload;
}
function base64UrlEncode(bytes: Uint8Array<ArrayBuffer>): string {
  return bytesToBase64(bytes)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  return base64ToBytes(
    value.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (value.length % 4)) % 4),
  );
}
