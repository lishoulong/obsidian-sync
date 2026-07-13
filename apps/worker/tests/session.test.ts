import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "../src/http.ts";
import { signSession, verifySession } from "../src/session.ts";
import type { Env, SessionPayload } from "../src/types.ts";

const env: Env = {
  SYNC_TOKEN: "test-session-secret",
  GITHUB_OWNER: "vaultbridge",
  GITHUB_REPO: "test-vault",
  GITHUB_BRANCH: "main",
};

const payload = (exp: number): SessionPayload => ({
  v: 2,
  deviceId: "phone-1",
  repository: "vaultbridge/test-vault",
  branch: "main",
  baseCommitSha: "a".repeat(40),
  remoteCommitSha: "b".repeat(40),
  exp,
});

async function expectSessionError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof HttpError &&
      error.status === status &&
      error.code === code,
  );
}

test("signed sessions round-trip their payload", async () => {
  const expected = payload(Math.floor(Date.now() / 1000) + 60);
  const token = await signSession(env, expected);

  assert.deepEqual(await verifySession(env, token), expected);
});

test("tampered session signatures are rejected", async () => {
  const token = await signSession(
    env,
    payload(Math.floor(Date.now() / 1000) + 60),
  );
  const [encoded, signature] = token.split(".");
  assert.ok(encoded && signature);
  const replacement = signature.startsWith("A") ? "B" : "A";
  const tampered = `${encoded}.${replacement}${signature.slice(1)}`;

  await expectSessionError(
    verifySession(env, tampered),
    401,
    "invalid_session",
  );
});

test("expired sessions are rejected", async () => {
  const token = await signSession(
    env,
    payload(Math.floor(Date.now() / 1000) - 1),
  );

  await expectSessionError(
    verifySession(env, token),
    409,
    "sync_session_expired",
  );
});
