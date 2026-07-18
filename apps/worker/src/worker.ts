import { getWorkerReadiness } from "./config.js";
import { requireAuth } from "./auth.js";
import { cors, json } from "./http.js";
import { checkPushV1, commitV1 } from "./handlers/v1.js";
import {
  commitV2,
  createBlob,
  pullFileV2,
  setupCheckV2,
  syncCheckV2,
} from "./handlers/v2.js";
import { createRequestContext, log } from "./observability.js";
import { HttpError } from "./http.js";
import type { Env } from "./types.js";
import {
  createPairingCode,
  cleanupPairingCodes,
  exchangePairingCode,
  listDevices,
  revokeDevice,
} from "./pairing.js";

export default {
  async scheduled(
    controller: { scheduledTime: number },
    env: Env,
  ): Promise<void> {
    await cleanupPairingCodes(env, controller.scheduledTime);
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const ctx = createRequestContext(request);
    try {
      if (request.method === "OPTIONS")
        return cors(new Response(null, { status: 204 }));
      const url = new URL(request.url);
      log(ctx, "request_start", { path: url.pathname });
      if (url.pathname === "/health" && request.method === "GET") {
        const readiness = getWorkerReadiness(env);
        return cors(
          json({
            ok: true,
            service: "vaultbridge",
            version: "0.4.0",
            protocol: 2,
            mode: "self-hosted",
            configured: readiness.configured,
            coreConfigured: readiness.coreSync.ready,
            missingConfig: readiness.missing,
            readiness: {
              coreSync: readiness.coreSync,
              devicePairing: readiness.devicePairing,
            },
            features: {
              devicePairing: readiness.devicePairing.ready,
            },
            requestId: ctx.id,
          }),
        );
      }
      if (url.pathname === "/v2/pairing/exchange" && request.method === "POST")
        return cors(await exchangePairingCode(request, env));
      const principal = await requireAuth(request, env);
      if (url.pathname === "/v2/pairing/codes" && request.method === "POST")
        return cors(await createPairingCode(request, env, principal));
      if (url.pathname === "/v2/devices" && request.method === "GET")
        return cors(await listDevices(env, principal));
      if (
        url.pathname.startsWith("/v2/devices/") &&
        request.method === "DELETE"
      )
        return cors(
          await revokeDevice(
            url.pathname.slice("/v2/devices/".length),
            env,
            principal,
          ),
        );
      if (url.pathname === "/v2/setup/check" && request.method === "GET")
        return cors(await setupCheckV2(env, ctx));
      if (url.pathname === "/v2/sync/check" && request.method === "POST")
        return cors(await syncCheckV2(request, env, ctx));
      if (url.pathname === "/v2/pull/file" && request.method === "POST")
        return cors(await pullFileV2(request, env, ctx));
      if (url.pathname === "/v2/blob" && request.method === "POST")
        return cors(await createBlob(request, env, ctx));
      if (url.pathname === "/v2/commit" && request.method === "POST")
        return cors(await commitV2(request, env, ctx));
      if (url.pathname === "/v1/check" && request.method === "POST")
        return cors(await checkPushV1(request, env, ctx));
      if (url.pathname === "/v1/blob" && request.method === "POST")
        return cors(await createBlob(request, env, ctx));
      if (url.pathname === "/v1/commit" && request.method === "POST")
        return cors(await commitV1(request, env, ctx));
      log(ctx, "request_not_found", { path: url.pathname });
      return cors(json({ error: "not_found", requestId: ctx.id }, 404));
    } catch (error: unknown) {
      const known = error instanceof HttpError;
      const status = known ? error.status : 500;
      const code = known ? error.code : "internal_error";
      const message =
        error instanceof Error ? error.message : "Unknown internal error";
      const details = known ? error.details : undefined;
      log(ctx, "request_error", { status, code, message });
      return cors(
        json({ error: code, message, details, requestId: ctx.id }, status),
      );
    }
  },
};
