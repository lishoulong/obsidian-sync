import { httpError } from "./http.js";
import type { Env } from "./types.js";

export function requireAuth(request: Request, env: Env): void {
  if (!env.SYNC_TOKEN)
    throw httpError(500, "missing_config", "SYNC_TOKEN is not configured");
  if (
    (request.headers.get("authorization") || "") !== `Bearer ${env.SYNC_TOKEN}`
  )
    throw httpError(401, "unauthorized", "invalid sync token");
}
