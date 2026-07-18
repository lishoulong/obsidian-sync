import { arrayBufferToBase64 } from "./encoding";
import { requestUrl, type RequestUrlResponse } from "obsidian";
import {
  BlobEntry,
  CommitResponse,
  DeviceState,
  DeviceListResponse,
  FileManifest,
  PullFileResponse,
  PairingCodeResponse,
  PairingExchangeResponse,
  SyncPlan,
  VaultBridgeError,
  VaultBridgeSettings,
  WorkerHealthResponse,
  WorkerSetupCheckResponse
} from "./types";
import { normalizeWorkerUrl } from "./settings";

interface WorkerErrorBody {
  error?: string;
  message?: string;
  requestId?: string;
}

const REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 4000];
const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504]);
export const PAIRING_CREATE_PATH = "/v2/pairing/codes";
export const PAIRING_EXCHANGE_PATH = "/v2/pairing/exchange";

export class WorkerClient {
  private settings: VaultBridgeSettings;
  private retryDelaysMs: number[];
  private requestTimeoutMs: number;

  constructor(
    settings: VaultBridgeSettings,
    retryDelaysMs: number[] = DEFAULT_RETRY_DELAYS_MS,
    requestTimeoutMs = REQUEST_TIMEOUT_MS
  ) {
    this.settings = settings;
    this.retryDelaysMs = retryDelaysMs;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async health(): Promise<WorkerHealthResponse> {
    return this.request("GET", "/health", null, false, true);
  }

  async setupCheck(): Promise<WorkerSetupCheckResponse> {
    return this.request("GET", "/v2/setup/check", null, true, true);
  }

  async createPairingCode(expiresInSeconds = 300): Promise<PairingCodeResponse> {
    return this.request("POST", PAIRING_CREATE_PATH, { expiresInSeconds }, true, false);
  }

  async exchangePairingCode(code: string, deviceName?: string): Promise<PairingExchangeResponse> {
    const body: { code: string; deviceName?: string } = { code: code.trim() };
    if (deviceName?.trim()) body.deviceName = deviceName.trim();
    return this.request("POST", PAIRING_EXCHANGE_PATH, body, false, false);
  }

  async listDevices(): Promise<DeviceListResponse> {
    return this.request("GET", "/v2/devices", null, true, true);
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const id = deviceId.trim();
    if (!id) throw new Error("Device ID is required.");
    await this.request("DELETE", `/v2/devices/${encodeURIComponent(id)}`, null, true, false);
  }

  async syncCheck(deviceId: string, lastSyncedCommitSha: string | null, files: FileManifest): Promise<SyncPlan> {
    return this.request("POST", "/v2/sync/check", { deviceId, lastSyncedCommitSha, files }, true, true);
  }

  async pullFile(sessionToken: string, path: string, blobSha: string): Promise<PullFileResponse> {
    return this.request("POST", "/v2/pull/file", { sessionToken, path, blobSha }, true, true);
  }

  async createBlob(path: string, content: ArrayBuffer): Promise<BlobEntry> {
    return this.request("POST", "/v2/blob", { path, encoding: "base64", content: arrayBufferToBase64(content) }, true, true);
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
    // Never retried: a commit that reached the Worker may have been applied
    // even when the response is lost, and replaying it could double-commit.
    return this.request("POST", "/v2/commit", input, true, false);
  }

  private async request<T>(method: string, path: string, body: unknown, authenticated: boolean, retryable: boolean): Promise<T> {
    const attempts = retryable ? this.retryDelaysMs.length + 1 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await delay(this.retryDelaysMs[attempt - 1]);
      try {
        return await this.requestOnce(method, path, body, authenticated);
      } catch (error) {
        lastError = error;
        if (!isRetryableError(error)) throw error;
      }
    }
    throw lastError;
  }

  private async requestOnce<T>(method: string, path: string, body: unknown, authenticated: boolean): Promise<T> {
    const url = `${normalizeWorkerUrl(this.settings.workerUrl)}${path}`;
    const headers: Record<string, string> = {};
    if (authenticated) headers.authorization = `Bearer ${this.settings.syncToken}`;

    let response: RequestUrlResponse;
    try {
      response = await withTimeout(requestUrl({
        url,
        method,
        headers: {
          ...headers,
          "content-type": "application/json"
        },
        body: body == null ? undefined : JSON.stringify(body),
        throw: false
      }), this.requestTimeoutMs, `${method} ${path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Network request failed.";
      throw new VaultBridgeError("network_error", `${method} ${path} failed: ${message}`);
    }

    const text = response.text;
    const parsed = parseJson(text);
    if (response.status < 200 || response.status >= 300) {
      const requestHint = parsed.requestId ? ` [requestId ${parsed.requestId}]` : "";
      const code = parsed.error || `http_${response.status}`;
      const error = new VaultBridgeError(code, `${sanitizeError(parsed.message || `Worker returned ${response.status}`)}${requestHint}`);
      if (RETRYABLE_HTTP_STATUS.has(response.status)) markRetryable(error);
      throw error;
    }

    return parsed as T;
  }
}

function withTimeout<T>(request: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
    request.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

const RETRYABLE_MARKER = Symbol("vaultbridge-retryable");

function markRetryable(error: VaultBridgeError): void {
  (error as VaultBridgeError & { [RETRYABLE_MARKER]?: boolean })[RETRYABLE_MARKER] = true;
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof VaultBridgeError)) return false;
  if (error.code === "network_error") return true;
  return (error as VaultBridgeError & { [RETRYABLE_MARKER]?: boolean })[RETRYABLE_MARKER] === true;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
