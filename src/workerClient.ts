import { arrayBufferToBase64 } from "./encoding";
import {
  BlobEntry,
  CommitResponse,
  DeviceState,
  FileManifest,
  PullFileResponse,
  SyncPlan,
  VaultBridgeError,
  VaultBridgeSettings
} from "./types";
import { normalizeWorkerUrl } from "./settings";

interface WorkerErrorBody {
  error?: string;
  message?: string;
  requestId?: string;
}

const REQUEST_TIMEOUT_MS = 120000;

export class WorkerClient {
  private settings: VaultBridgeSettings;

  constructor(settings: VaultBridgeSettings) {
    this.settings = settings;
  }

  async health(): Promise<{ ok: boolean; service: string; protocol: number; version?: string }> {
    return this.request("GET", "/health", null, false);
  }

  async syncCheck(deviceId: string, lastSyncedCommitSha: string | null, files: FileManifest): Promise<SyncPlan> {
    return this.request("POST", "/v2/sync/check", { deviceId, lastSyncedCommitSha, files }, true);
  }

  async pullFile(sessionToken: string, path: string, blobSha: string): Promise<PullFileResponse> {
    return this.request("POST", "/v2/pull/file", { sessionToken, path, blobSha }, true);
  }

  async createBlob(path: string, content: ArrayBuffer): Promise<BlobEntry> {
    return this.request("POST", "/v2/blob", { path, encoding: "base64", content: arrayBufferToBase64(content) }, true);
  }

  async commit(input: {
    deviceId: string;
    sessionToken: string;
    message: string;
    patch: {
      upload: FileManifest;
      delete: string[];
    };
    blobs: BlobEntry[];
  }): Promise<CommitResponse> {
    return this.request("POST", "/v2/commit", input, true);
  }

  private async request<T>(method: string, path: string, body: unknown, authenticated: boolean): Promise<T> {
    const url = `${normalizeWorkerUrl(this.settings.workerUrl)}${path}`;
    const headers: Record<string, string> = {};
    if (authenticated) headers.authorization = `Bearer ${this.settings.syncToken}`;

    let response: Response;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      response = await fetch(url, {
        method,
        headers: {
          ...headers,
          "content-type": "application/json"
        },
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Network request failed.";
      throw new VaultBridgeError("network_error", `${method} ${path} failed: ${message}`);
    } finally {
      window.clearTimeout(timeout);
    }

    const text = await response.text();
    const parsed = parseJson(text);
    if (response.status < 200 || response.status >= 300) {
      const requestHint = parsed.requestId ? ` [requestId ${parsed.requestId}]` : "";
      throw new VaultBridgeError(parsed.error || `http_${response.status}`, `${sanitizeError(parsed.message || `Worker returned ${response.status}`)}${requestHint}`);
    }

    return parsed as T;
  }
}

function parseJson(text: string): WorkerErrorBody & Record<string, unknown> {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { message: text };
  }
}

function sanitizeError(message: string): string {
  return message.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/g, "Bearer [redacted]");
}

export function syncMessage(deviceId: string): string {
  return `VaultBridge sync from ${deviceId} ${new Date().toISOString()}`;
}

export function stateCommitSha(state: DeviceState | null): string | null {
  return state?.lastSyncedCommitSha || null;
}
