import { httpError } from "./http.js";
import type { AuthPrincipal, Env } from "./types.js";

const LAST_USED_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function requireAuth(
  request: Request,
  env: Env,
): Promise<AuthPrincipal> {
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  if (token && env.SYNC_TOKEN && token === env.SYNC_TOKEN)
    return { kind: "legacy", deviceId: null };

  if (token && env.DB) {
    const tokenHash = await sha256Hex(token);
    const device = await env.DB.prepare(
      "SELECT id, last_used_at FROM devices WHERE token_hash = ?1 AND revoked_at IS NULL LIMIT 1",
    )
      .bind(tokenHash)
      .first<{ id: string; last_used_at: number | null }>();
    if (device) {
      const now = Date.now();
      if (
        device.last_used_at === null ||
        device.last_used_at <= now - LAST_USED_UPDATE_INTERVAL_MS
      ) {
        await env.DB.prepare(
          "UPDATE devices SET last_used_at = ?1 WHERE id = ?2 AND revoked_at IS NULL AND (last_used_at IS NULL OR last_used_at <= ?3)",
        )
          .bind(now, device.id, now - LAST_USED_UPDATE_INTERVAL_MS)
          .run();
      }
      return { kind: "device", deviceId: device.id };
    }
  }

  if (!env.SYNC_TOKEN && !env.DB)
    throw httpError(
      500,
      "missing_config",
      "SYNC_TOKEN or DB authentication is not configured",
    );
  throw httpError(401, "unauthorized", "invalid sync token");
}
