export interface DeviceState {
  version: 2;
  deviceId: string;
  lastSyncedCommitSha: string | null;
}

export interface VaultBridgeSettings {
  workerUrl: string;
  syncToken: string;
  deviceId: string;
  remotePrefix: string;
  maxFileBytes: number;
  excludePatterns: string[];
}

export interface VaultBridgePluginData {
  settings: VaultBridgeSettings;
  deviceState: DeviceState | null;
  lastResult: SyncResult | null;
}

export interface FileMeta {
  size: number;
  sha256: string;
}

export type FileManifest = Record<string, FileMeta>;

export interface SyncPlanEntry {
  path: string;
  reason?: string;
  remoteBlobSha?: string;
  remoteSize?: number;
  size?: number;
  sha256?: string;
}

export interface SyncPlan {
  protocol: 2;
  deviceId: string;
  bootstrap: boolean;
  baseCommitSha: string | null;
  remoteCommitSha: string;
  sessionToken: string;
  sessionExpiresInSeconds: number;
  download: SyncPlanEntry[];
  deleteLocal: SyncPlanEntry[];
  upload: SyncPlanEntry[];
  deleteRemote: SyncPlanEntry[];
  conflict: SyncPlanEntry[];
  unchanged: SyncPlanEntry[];
  counts: SyncCounts;
  nextDeviceState: DeviceState | null;
}

export interface SyncCounts {
  download: number;
  deleteLocal: number;
  upload: number;
  deleteRemote: number;
  conflict: number;
  unchanged: number;
}

export interface PullFileResponse {
  path: string;
  commitSha: string;
  blobSha: string;
  encoding: "base64";
  content: string;
  size: number;
  sha256: string;
}

export interface BlobEntry {
  path: string;
  sha: string;
}

export interface CommitResponse {
  ok: boolean;
  protocol: 2;
  commitSha: string;
  treeSha: string;
  changed: number;
  deviceState: DeviceState;
}

export interface SyncResult {
  status: "success" | "conflict" | "error";
  message: string;
  counts: {
    downloaded: number;
    uploaded: number;
    deletedLocal: number;
    deletedRemote: number;
    conflicts: number;
    unchanged: number;
  };
  commitSha?: string;
  conflictPaths: string[];
  completedAt: string;
}

export class VaultBridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "VaultBridgeError";
    this.code = code;
  }
}
