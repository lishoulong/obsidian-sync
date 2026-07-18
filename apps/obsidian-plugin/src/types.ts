export interface DeviceState {
  version: 2;
  deviceId: string;
  lastSyncedCommitSha: string | null;
}

export interface VaultBridgeSettings {
  workerUrl: string;
  syncToken: string;
  workerCredentialKind: "administrator" | "device" | null;
  deviceId: string;
  localPrefix: string;
  remotePrefix: string;
  maxFileBytes: number;
  excludePatterns: string[];
  autoMergeConflicts: boolean;
  autoMergeMode: "suggest" | "apply";
  autoMergeEndpoint: string;
  autoMergeApiKey: string;
  autoMergeModel: string;
  autoMergeMaxFileBytes: number;
  autoMergeConfidenceThreshold: number;
  workerAutoSync: boolean;
  workerAutoSyncDelaySeconds: number;
  workerAutoSyncIntervalMinutes: number;
  deleteGuardThreshold: number;
  desktopAutoGitPush: boolean;
  desktopAutoGitPushDelaySeconds: number;
  desktopAutoGitPull: boolean;
  desktopAutoGitPullIntervalMinutes: number;
  desktopGitPullBeforePush: boolean;
  desktopGitCommitMessagePrefix: string;
  desktopWorkerSyncEnabled: boolean;
}

export interface WorkerHealthResponse {
  ok: boolean;
  service: string;
  protocol: number;
  version?: string;
  configured?: boolean;
  coreConfigured?: boolean;
  missingConfig?: string[];
  readiness?: {
    coreSync?: { ready: boolean; missing: string[] };
    devicePairing?: { ready: boolean; missing: string[] };
  };
  features?: {
    devicePairing?: boolean;
  };
}

export interface WorkerSetupCheckResponse {
  ok: boolean;
  repository?: {
    owner?: string;
    repo?: string;
    fullName?: string;
    private?: boolean;
    defaultBranch?: string;
    branch?: string;
    headCommitSha?: string;
  };
  limits?: {
    maxFileBytes?: number;
  };
}

export interface WorkerConnectionResult extends WorkerSetupCheckResponse {
  health: WorkerHealthResponse;
}

export interface VaultBridgePluginData {
  settings: VaultBridgeSettings;
  deviceState: DeviceState | null;
  lastResult: SyncResult | null;
  onboarding: OnboardingState;
  pendingConflicts?: Record<string, PendingConflict>;
  pendingDesktopGitConflict?: DesktopGitConflictState | null;
  hashCache?: Record<string, HashCacheEntry>;
}

export type InitialSyncMode = "remote" | "local" | "merge";

export interface InitialSyncPreview {
  mode: InitialSyncMode;
  localFiles: number;
  remoteFiles: number;
  remoteCommitSha: string;
  planDigest: string;
  counts: SyncCounts;
  createdAt: string;
}

export interface OnboardingState {
  initialSyncCompleted: boolean;
  mode: InitialSyncMode | null;
  preview: InitialSyncPreview | null;
}

export interface PairingCodeResponse {
  code: string;
  expiresAt: string;
}

export interface PairingExchangeResponse {
  token: string;
  device: {
    id: string;
    name: string;
    createdAt: string;
  };
}

export interface PairedDevice {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface DeviceListResponse {
  devices: PairedDevice[];
}

export interface HashCacheEntry {
  mtime: number;
  size: number;
  sha256: string;
}

export interface PendingConflict {
  path: string;
  localPath: string;
  remoteCommitSha: string;
  remoteBlobSha?: string;
  conflictPaths: string[];
  createdAt: string;
}

export interface DesktopGitConflictState {
  active: boolean;
  kind: "rebase" | "merge" | "cherry-pick" | "unmerged" | "unknown";
  repoRoot: string;
  paths: string[];
  message: string;
  updatedAt: string;
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
  requestId?: string;
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
  requestId?: string;
  path: string;
  commitSha: string;
  blobSha: string;
  encoding: "base64";
  content: string;
  size: number;
  sha256: string;
}

export interface BlobEntry {
  requestId?: string;
  path: string;
  sha: string;
}

export interface CommitResponse {
  ok: boolean;
  protocol: 2;
  requestId?: string;
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
  diagnostics?: SyncDiagnostics;
  completedAt: string;
}

export interface SyncDiagnostics {
  localPrefix: string;
  remotePrefix: string;
  baseCommitSha: string | null;
  remoteCommitSha?: string;
  localFiles?: number;
  skippedFiles?: number;
  pullCounts?: SyncCounts;
  pushCounts?: SyncCounts;
  downloadPaths?: string[];
  deleteLocalPaths?: string[];
  uploadPaths?: string[];
  deleteRemotePaths?: string[];
  conflictPaths?: string[];
  autoMergePaths?: string[];
  autoMergeWarnings?: string[];
  oversizedPaths?: string[];
  warnings?: string[];
  requestIds?: string[];
  phase?: string;
}

export class VaultBridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "VaultBridgeError";
    this.code = code;
  }
}
