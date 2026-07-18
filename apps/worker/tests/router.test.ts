import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.ts";
import type { Env } from "../src/types.ts";

const request = (path: string, init?: RequestInit): Request =>
  new Request(`https://worker.test${path}`, init);

test("health is public and describes Protocol v2", async () => {
  const response = await worker.fetch(request("/health"), {});
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(body.ok, true);
  assert.equal(body.service, "vaultbridge");
  assert.equal(body.protocol, 2);
  assert.equal(body.configured, false);
  assert.equal(body.coreConfigured, false);
  assert.deepEqual(body.missingConfig, [
    "SYNC_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_OWNER or GITHUB_REPOSITORY",
    "GITHUB_REPO or GITHUB_REPOSITORY",
    "DB",
  ]);
  assert.deepEqual(body.readiness, {
    coreSync: {
      ready: false,
      missing: [
        "SYNC_TOKEN",
        "GITHUB_TOKEN",
        "GITHUB_OWNER or GITHUB_REPOSITORY",
        "GITHUB_REPO or GITHUB_REPOSITORY",
      ],
    },
    devicePairing: { ready: false, missing: ["DB"] },
  });
  assert.equal(typeof body.requestId, "string");
});

test("health distinguishes core sync configuration from D1 pairing readiness", async () => {
  const env: Env = {
    SYNC_TOKEN: "secret",
    GITHUB_TOKEN: "github-secret",
    GITHUB_OWNER: "owner",
    GITHUB_REPO: "notes",
  };
  const response = await worker.fetch(request("/health"), env);
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(body.configured, false);
  assert.equal(body.coreConfigured, true);
  assert.deepEqual(body.missingConfig, ["DB"]);
  assert.deepEqual(body.features, { devicePairing: false });
  assert.deepEqual(body.readiness, {
    coreSync: { ready: true, missing: [] },
    devicePairing: { ready: false, missing: ["DB"] },
  });
});

test("OPTIONS returns the CORS preflight response without authentication", async () => {
  const response = await worker.fetch(
    request("/v2/sync/check", { method: "OPTIONS" }),
    {},
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(
    response.headers.get("access-control-allow-methods"),
    "GET, POST, DELETE, OPTIONS",
  );
});

test("protected routes reject a missing bearer token", async () => {
  const env: Env = { SYNC_TOKEN: "secret" };
  const response = await worker.fetch(
    request("/v2/sync/check", { method: "POST" }),
    env,
  );
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 401);
  assert.equal(body.error, "unauthorized");
  assert.equal(typeof body.requestId, "string");
});

test("authenticated unknown routes return 404", async () => {
  const env: Env = { SYNC_TOKEN: "secret" };
  const response = await worker.fetch(
    request("/unknown", {
      headers: { authorization: "Bearer secret" },
    }),
    env,
  );
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 404);
  assert.equal(body.error, "not_found");
  assert.equal(typeof body.requestId, "string");
});
