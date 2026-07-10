import { requestUrl } from "obsidian";
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
    files: FileManifest;
    blobs: BlobEntry[];
    delete: string[];
  }): Promise<CommitResponse> {
    return this.request("POST", "/v2/commit", input, true);
  }

  private async request<T>(method: string, path: string, body: unknown, authenticated: boolean): Promise<T> {
    const url = `${normalizeWorkerUrl(this.settings.workerUrl)}${path}`;
    const headers: Record<string, string> = {};
    if (authenticated) headers.authorization = `Bearer ${this.settings.syncToken}`;

    let response;
    try {
      response = await requestUrl({
        url,
        method,
        contentType: "application/json",
        headers,
        body: body == null ? undefined : JSON.stringify(body),
        throw: false
      });
    } catch (error) {
      throw new VaultBridgeError("network_error", error instanceof Error ? error.message : "Network request failed.");
    }

    if (response.status < 200 || response.status >= 300) {
      const parsed = parseWorkerError(response.json, response.text);
      const requestHint = parsed.requestId ? ` [requestId ${parsed.requestId}]` : "";
      throw new VaultBridgeError(parsed.error || `http_${response.status}`, `${sanitizeError(parsed.message || `Worker returned ${response.status}`)}${requestHint}`);
    }

    return response.json as T;
  }
}

function parseWorkerError(json: unknown, text: string): WorkerErrorBody {
  if (json && typeof json === "object") return json as WorkerErrorBody;
  try {
    return JSON.parse(text) as WorkerErrorBody;
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
