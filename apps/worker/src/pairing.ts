import { sha256Hex } from "./auth.js";
import { httpError, json, readJson } from "./http.js";
import { field, isRecord } from "./types.js";
import type { AuthPrincipal, D1DatabaseLike, Env } from "./types.js";

const DEFAULT_PAIRING_TTL_SECONDS = 300;
const MAX_PAIRING_TTL_SECONDS = 600;
const PAIRING_CODE_RETENTION_MS = 24 * 60 * 60 * 1000;
const PAIRING_EXCHANGE_MAX_BODY_BYTES = 4 * 1024;

interface PairingCodeRow {
  expires_at: number;
  consumed_nonce: string | null;
}

interface DeviceRow {
  id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

function requireDatabase(env: Env): D1DatabaseLike {
  if (!env.DB)
    throw httpError(
      503,
      "pairing_unavailable",
      "D1 pairing database is not configured",
    );
  return env.DB;
}

function requireAdministrator(principal: AuthPrincipal): void {
  if (principal.kind !== "legacy")
    throw httpError(
      403,
      "administrator_required",
      "the administrator SYNC_TOKEN is required for device management",
    );
}

function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function deviceName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "Mobile device";
  if (!name || name.length > 80)
    throw httpError(
      400,
      "invalid_device_name",
      "deviceName must be 1-80 characters",
    );
  return name;
}

export async function createPairingCode(
  request: Request,
  env: Env,
  principal: AuthPrincipal,
): Promise<Response> {
  requireAdministrator(principal);
  const db = requireDatabase(env);
  const body =
    request.headers.get("content-length") === "0"
      ? {}
      : await readOptionalJson(request);
  const requestedTtl = Number(
    field(body, "expiresInSeconds") ?? DEFAULT_PAIRING_TTL_SECONDS,
  );
  if (
    !Number.isInteger(requestedTtl) ||
    requestedTtl < 60 ||
    requestedTtl > MAX_PAIRING_TTL_SECONDS
  )
    throw httpError(
      400,
      "invalid_pairing_ttl",
      "expiresInSeconds must be between 60 and 600",
    );

  const code = randomToken();
  const now = Date.now();
  const expiresAt = now + requestedTtl * 1000;
  await db
    .prepare(
      "INSERT INTO pairing_codes (code_hash, created_by_device_id, expires_at, consumed_nonce, consumed_at, created_at) VALUES (?1, ?2, ?3, NULL, NULL, ?4)",
    )
    .bind(await sha256Hex(code), principal.deviceId, expiresAt, now)
    .run();
  return json({ code, expiresAt: new Date(expiresAt).toISOString() }, 201);
}

export async function exchangePairingCode(
  request: Request,
  env: Env,
): Promise<Response> {
  const db = requireDatabase(env);
  const body = await readJson(request, PAIRING_EXCHANGE_MAX_BODY_BYTES);
  if (!isRecord(body))
    throw httpError(400, "invalid_request", "request body must be an object");
  const code = String(field(body, "code") || "").trim();
  if (!code) throw httpError(400, "invalid_pairing_code", "code is required");
  const codeHash = await sha256Hex(code);
  const existing = await db
    .prepare(
      "SELECT expires_at, consumed_nonce FROM pairing_codes WHERE code_hash = ?1 LIMIT 1",
    )
    .bind(codeHash)
    .first<PairingCodeRow>();
  if (!existing)
    throw httpError(404, "invalid_pairing_code", "pairing code was not found");
  if (existing.consumed_nonce)
    throw httpError(
      409,
      "pairing_code_consumed",
      "pairing code has already been used",
    );
  const now = Date.now();
  if (existing.expires_at <= now)
    throw httpError(410, "pairing_code_expired", "pairing code has expired");

  const id = crypto.randomUUID();
  const name = deviceName(field(body, "deviceName"));
  const token = randomToken(48);
  const tokenHash = await sha256Hex(token);
  const consumptionNonce = crypto.randomUUID();
  const results = await db.batch([
    db
      .prepare(
        "UPDATE pairing_codes SET consumed_nonce = ?1, consumed_at = ?2 WHERE code_hash = ?3 AND consumed_nonce IS NULL AND expires_at > ?4",
      )
      .bind(consumptionNonce, now, codeHash, now),
    db
      .prepare(
        "INSERT INTO devices (id, name, token_hash, created_at, last_used_at, revoked_at) SELECT ?1, ?2, ?3, ?4, NULL, NULL FROM pairing_codes WHERE code_hash = ?5 AND consumed_nonce = ?6",
      )
      .bind(id, name, tokenHash, now, codeHash, consumptionNonce),
  ]);
  if (
    (results[0]?.meta?.changes ?? 0) !== 1 ||
    (results[1]?.meta?.changes ?? 0) !== 1
  )
    throw httpError(
      409,
      "pairing_code_consumed",
      "pairing code has already been used",
    );

  return json(
    { token, device: { id, name, createdAt: new Date(now).toISOString() } },
    201,
  );
}

export async function listDevices(
  env: Env,
  principal: AuthPrincipal,
): Promise<Response> {
  requireAdministrator(principal);
  const result = await requireDatabase(env)
    .prepare(
      "SELECT id, name, created_at, last_used_at, revoked_at FROM devices ORDER BY created_at DESC",
    )
    .all<DeviceRow>();
  return json({
    devices: (result.results ?? []).map((device) => ({
      id: device.id,
      name: device.name,
      createdAt: new Date(device.created_at).toISOString(),
      lastUsedAt:
        device.last_used_at === null
          ? null
          : new Date(device.last_used_at).toISOString(),
      revokedAt:
        device.revoked_at === null
          ? null
          : new Date(device.revoked_at).toISOString(),
    })),
  });
}

export async function revokeDevice(
  deviceId: string,
  env: Env,
  principal: AuthPrincipal,
): Promise<Response> {
  const id = decodeURIComponent(deviceId).trim();
  if (!id) throw httpError(400, "invalid_device_id", "device id is required");
  if (principal.kind === "device" && principal.deviceId !== id)
    throw httpError(
      403,
      "device_management_forbidden",
      "a device token may only revoke its own device",
    );
  const result = await requireDatabase(env)
    .prepare(
      "UPDATE devices SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
    )
    .bind(Date.now(), id)
    .run();
  if ((result.meta?.changes ?? 0) !== 1)
    throw httpError(404, "device_not_found", "active device was not found");
  return new Response(null, { status: 204 });
}

export async function cleanupPairingCodes(
  env: Env,
  now = Date.now(),
): Promise<number> {
  const cutoff = now - PAIRING_CODE_RETENTION_MS;
  const result = await requireDatabase(env)
    .prepare(
      "DELETE FROM pairing_codes WHERE expires_at < ?1 OR (consumed_at IS NOT NULL AND consumed_at < ?1)",
    )
    .bind(cutoff)
    .run();
  return result.meta?.changes ?? 0;
}

async function readOptionalJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw httpError(400, "invalid_json", "request body must be JSON");
  }
}
