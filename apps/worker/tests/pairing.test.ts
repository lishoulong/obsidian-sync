import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.ts";
import type { Env } from "../src/types.ts";

type Row = Record<string, unknown>;

class MemoryD1 {
  readonly pairingCodes: Row[] = [];
  readonly devices: Row[] = [];
  lastUsedWrites = 0;

  prepare(sql: string): MemoryStatement {
    return new MemoryStatement(this, sql);
  }

  async batch(
    statements: MemoryStatement[],
  ): Promise<{ success: true; meta: { changes: number } }[]> {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

class MemoryStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: MemoryD1,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): MemoryStatement {
    this.values = values;
    return this;
  }

  async first<T = Row>(): Promise<T | null> {
    const rows = this.rows();
    return (rows[0] as T | undefined) ?? null;
  }

  async all<T = Row>(): Promise<{ results: T[]; success: true }> {
    return { results: this.rows() as T[], success: true };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const normalized = normalize(this.sql);
    let changes = 0;

    if (normalized.startsWith("insert into pairing_codes")) {
      this.db.pairingCodes.push({
        code_hash: this.values[0],
        created_by_device_id: this.values[1],
        expires_at: this.values[2],
        consumed_nonce: null,
        consumed_at: null,
        created_at: this.values[3],
      });
      changes = 1;
    } else if (normalized.startsWith("insert into devices")) {
      const code = this.db.pairingCodes.find(
        (candidate) =>
          candidate.code_hash === this.values[4] &&
          candidate.consumed_nonce === this.values[5],
      );
      if (code) {
        this.db.devices.push({
          id: this.values[0],
          name: this.values[1],
          token_hash: this.values[2],
          created_at: this.values[3],
          last_used_at: null,
          revoked_at: null,
        });
        changes = 1;
      }
    } else if (normalized.startsWith("update pairing_codes")) {
      const recordsConsumedAt = normalized.includes("consumed_at");
      const codeHashIndex = recordsConsumedAt ? 2 : 1;
      const nowIndex = recordsConsumedAt ? 3 : 2;
      const row = this.db.pairingCodes.find(
        (candidate) => candidate.code_hash === this.values[codeHashIndex],
      );
      if (
        row &&
        row.consumed_nonce === null &&
        Number(row.expires_at) > Number(this.values[nowIndex])
      ) {
        row.consumed_nonce = this.values[0];
        if (recordsConsumedAt) row.consumed_at = this.values[1];
        changes = 1;
      }
    } else if (normalized.startsWith("delete from pairing_codes")) {
      const cutoff = Number(this.values[0]);
      const before = this.db.pairingCodes.length;
      const retained = this.db.pairingCodes.filter(
        (row) =>
          Number(row.expires_at) >= cutoff &&
          (row.consumed_at === null || Number(row.consumed_at) >= cutoff),
      );
      this.db.pairingCodes.splice(0, before, ...retained);
      changes = before - retained.length;
    } else if (normalized.startsWith("update devices")) {
      const updatesLastUsed = normalized.includes("last_used_at = ?");
      const row = this.db.devices.find((candidate) => {
        if (normalized.includes("where token_hash = ?"))
          return candidate.token_hash === this.lastValue();
        if (updatesLastUsed) {
          return (
            candidate.id === this.values[1] &&
            candidate.revoked_at === null &&
            (candidate.last_used_at === null ||
              Number(candidate.last_used_at) <= Number(this.values[2]))
          );
        }
        return candidate.id === this.lastValue();
      });
      if (row) {
        if (updatesLastUsed) {
          row.last_used_at = this.values[0];
          this.db.lastUsedWrites += 1;
        }
        if (normalized.includes("revoked_at = ?"))
          row.revoked_at = this.values[0];
        changes = 1;
      }
    }

    return { success: true, meta: { changes } };
  }

  private rows(): Row[] {
    const normalized = normalize(this.sql);
    if (normalized.includes("from pairing_codes")) {
      const row = this.db.pairingCodes.find(
        (candidate) => candidate.code_hash === this.values[0],
      );
      return row ? [selectAliases(this.sql, row)] : [];
    }
    if (normalized.includes("from devices")) {
      let rows = this.db.devices;
      if (normalized.includes("where token_hash = ?"))
        rows = rows.filter(
          (candidate) => candidate.token_hash === this.values[0],
        );
      else if (normalized.includes("where id = ?"))
        rows = rows.filter((candidate) => candidate.id === this.values[0]);
      if (normalized.includes("revoked_at is null"))
        rows = rows.filter((candidate) => candidate.revoked_at === null);
      return rows.map((row) => selectAliases(this.sql, row));
    }
    return [];
  }

  private lastValue(): unknown {
    return this.values[this.values.length - 1];
  }
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function selectAliases(sql: string, row: Row): Row {
  const selection = /select\s+(.+?)\s+from\s/is.exec(sql)?.[1];
  if (!selection || selection.trim() === "*") return { ...row };
  return Object.fromEntries(
    selection.split(",").map((expression) => {
      const match = expression.trim().match(/^(\w+)(?:\s+as\s+([\w]+))?$/i);
      assert.ok(match, `Fake D1 could not parse SELECT: ${sql}`);
      const source = match[1] as string;
      const target = (match[2] as string | undefined) ?? source;
      return [target, row[source]];
    }),
  );
}

const request = (path: string, init?: RequestInit): Request =>
  new Request(`https://worker.test${path}`, init);

const jsonRequest = (
  path: string,
  body: Record<string, unknown>,
  token?: string,
): Request =>
  request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const envWithDb = (db: MemoryD1): Env =>
  ({ SYNC_TOKEN: "legacy-secret", DB: db }) as unknown as Env;

async function createAndExchange(
  db: MemoryD1,
  name = "My iPhone",
): Promise<{ token: string; device: Row }> {
  const env = envWithDb(db);
  const created = await worker.fetch(
    jsonRequest("/v2/pairing/codes", {}, "legacy-secret"),
    env,
  );
  assert.equal(created.status, 201);
  const { code } = (await created.json()) as { code: string };
  const exchanged = await worker.fetch(
    jsonRequest("/v2/pairing/exchange", { code, deviceName: name }),
    env,
  );
  assert.equal(exchanged.status, 201);
  return (await exchanged.json()) as { token: string; device: Row };
}

test("legacy SYNC_TOKEN remains accepted for protected routes", async () => {
  const env = envWithDb(new MemoryD1());
  const response = await worker.fetch(
    request("/unknown", {
      headers: { authorization: "Bearer legacy-secret" },
    }),
    env,
  );
  assert.equal(response.status, 404);
});

test("creates a one-time code and exchanges it for a device token", async () => {
  const db = new MemoryD1();
  const env = envWithDb(db);
  const created = await worker.fetch(
    jsonRequest("/v2/pairing/codes", {}, "legacy-secret"),
    env,
  );
  assert.equal(created.status, 201);
  const creation = (await created.json()) as Row;
  assert.equal(typeof creation.code, "string");
  assert.equal(typeof creation.expiresAt, "string");

  const exchanged = await worker.fetch(
    jsonRequest("/v2/pairing/exchange", {
      code: creation.code,
      deviceName: "Alice's iPhone",
    }),
    env,
  );
  assert.equal(exchanged.status, 201);
  const result = (await exchanged.json()) as {
    token: string;
    device: Row;
  };
  assert.equal(typeof result.token, "string");
  assert.ok(result.token.length >= 32);
  assert.equal(result.device.name, "Alice's iPhone");
  assert.equal(typeof result.device.id, "string");
  assert.equal(typeof result.device.createdAt, "string");

  const authenticated = await worker.fetch(
    request("/unknown", {
      headers: { authorization: `Bearer ${result.token}` },
    }),
    env,
  );
  assert.equal(authenticated.status, 404);
});

test("rejects an expired pairing code", async () => {
  const db = new MemoryD1();
  const env = envWithDb(db);
  const created = await worker.fetch(
    jsonRequest("/v2/pairing/codes", {}, "legacy-secret"),
    env,
  );
  const { code } = (await created.json()) as { code: string };
  assert.equal(db.pairingCodes.length, 1);
  db.pairingCodes[0]!.expires_at = Date.now() - 1_000;

  const response = await worker.fetch(
    jsonRequest("/v2/pairing/exchange", { code, deviceName: "Late phone" }),
    env,
  );
  assert.equal(response.status, 410);
  const body = (await response.json()) as Row;
  assert.equal(body.error, "pairing_code_expired");
});

test("rejects replay of an already consumed pairing code", async () => {
  const db = new MemoryD1();
  const env = envWithDb(db);
  const created = await worker.fetch(
    jsonRequest("/v2/pairing/codes", {}, "legacy-secret"),
    env,
  );
  const { code } = (await created.json()) as { code: string };
  const first = await worker.fetch(
    jsonRequest("/v2/pairing/exchange", { code, deviceName: "First phone" }),
    env,
  );
  assert.equal(first.status, 201);

  const replay = await worker.fetch(
    jsonRequest("/v2/pairing/exchange", { code, deviceName: "Second phone" }),
    env,
  );
  assert.equal(replay.status, 409);
  const body = (await replay.json()) as Row;
  assert.equal(body.error, "pairing_code_consumed");
});

test("rejects oversized public pairing exchange bodies before parsing", async () => {
  const env = envWithDb(new MemoryD1());
  const response = await worker.fetch(
    request("/v2/pairing/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "x", padding: "x".repeat(4096) }),
    }),
    env,
  );
  const body = (await response.json()) as Row;

  assert.equal(response.status, 413);
  assert.equal(body.error, "payload_too_large");
});

test("lists paired devices and revokes one device", async () => {
  const db = new MemoryD1();
  const env = envWithDb(db);
  const { token, device } = await createAndExchange(db);

  const listed = await worker.fetch(
    request("/v2/devices", {
      headers: { authorization: "Bearer legacy-secret" },
    }),
    env,
  );
  assert.equal(listed.status, 200);
  const listBody = (await listed.json()) as { devices: Row[] };
  assert.equal(listBody.devices.length, 1);
  assert.equal(listBody.devices[0]?.id, device.id);
  assert.equal(listBody.devices[0]?.name, "My iPhone");
  assert.equal(listBody.devices[0]?.revokedAt, null);
  assert.equal("token_hash" in (listBody.devices[0] ?? {}), false);

  const revoked = await worker.fetch(
    request(`/v2/devices/${String(device.id)}`, {
      method: "DELETE",
      headers: { authorization: "Bearer legacy-secret" },
    }),
    env,
  );
  assert.equal(revoked.status, 204);

  const afterRevocation = await worker.fetch(
    request("/unknown", {
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(afterRevocation.status, 401);
});

test("device tokens cannot create pairing codes or list devices", async () => {
  const db = new MemoryD1();
  const env = envWithDb(db);
  const { token } = await createAndExchange(db);

  const create = await worker.fetch(
    jsonRequest("/v2/pairing/codes", {}, token),
    env,
  );
  assert.equal(create.status, 403);
  assert.equal(((await create.json()) as Row).error, "administrator_required");

  const list = await worker.fetch(
    request("/v2/devices", {
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(list.status, 403);
  assert.equal(((await list.json()) as Row).error, "administrator_required");
});

test("device tokens can revoke only their own device", async () => {
  const db = new MemoryD1();
  const env = envWithDb(db);
  const first = await createAndExchange(db, "First phone");
  const second = await createAndExchange(db, "Second phone");

  const revokeOther = await worker.fetch(
    request(`/v2/devices/${String(second.device.id)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${first.token}` },
    }),
    env,
  );
  assert.equal(revokeOther.status, 403);
  assert.equal(
    ((await revokeOther.json()) as Row).error,
    "device_management_forbidden",
  );

  const secondStillActive = await worker.fetch(
    request("/unknown", {
      headers: { authorization: `Bearer ${second.token}` },
    }),
    env,
  );
  assert.equal(secondStillActive.status, 404);

  const revokeSelf = await worker.fetch(
    request(`/v2/devices/${String(first.device.id)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${first.token}` },
    }),
    env,
  );
  assert.equal(revokeSelf.status, 204);

  const firstRevoked = await worker.fetch(
    request("/unknown", {
      headers: { authorization: `Bearer ${first.token}` },
    }),
    env,
  );
  assert.equal(firstRevoked.status, 401);
});

test("device last-used writes are throttled to once per hour", async () => {
  const db = new MemoryD1();
  const env = envWithDb(db);
  const { token } = await createAndExchange(db);
  const authenticatedRequest = (): Request =>
    request("/unknown", {
      headers: { authorization: `Bearer ${token}` },
    });

  assert.equal((await worker.fetch(authenticatedRequest(), env)).status, 404);
  assert.equal(db.lastUsedWrites, 1);
  assert.equal((await worker.fetch(authenticatedRequest(), env)).status, 404);
  assert.equal(db.lastUsedWrites, 1);

  db.devices[0]!.last_used_at = Date.now() - 60 * 60 * 1_000 - 1;
  assert.equal((await worker.fetch(authenticatedRequest(), env)).status, 404);
  assert.equal(db.lastUsedWrites, 2);
});

test("scheduled cleanup removes stale pairing codes and retains recent codes", async () => {
  const db = new MemoryD1();
  const now = Date.now();
  const day = 24 * 60 * 60 * 1_000;
  db.pairingCodes.push(
    {
      code_hash: "expired-over-a-day",
      expires_at: now - day - 60_000,
      consumed_nonce: null,
      consumed_at: null,
    },
    {
      code_hash: "consumed-over-a-day",
      expires_at: now + day,
      consumed_nonce: "nonce-old",
      consumed_at: now - day - 60_000,
    },
    {
      code_hash: "recently-expired",
      expires_at: now - 60_000,
      consumed_nonce: null,
      consumed_at: null,
    },
    {
      code_hash: "recently-consumed",
      expires_at: now + day,
      consumed_nonce: "nonce-new",
      consumed_at: now - 60_000,
    },
    {
      code_hash: "active",
      expires_at: now + day,
      consumed_nonce: null,
      consumed_at: null,
    },
  );

  const scheduledWorker = worker as unknown as {
    scheduled(
      controller: { cron: string; scheduledTime: number },
      env: Env,
      context: {
        waitUntil(promise: Promise<unknown>): void;
        passThroughOnException(): void;
      },
    ): Promise<void>;
  };
  await scheduledWorker.scheduled(
    { cron: "0 3 * * *", scheduledTime: now },
    envWithDb(db),
    {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
    },
  );

  assert.deepEqual(
    db.pairingCodes.map((row) => row.code_hash),
    ["recently-expired", "recently-consumed", "active"],
  );
});
