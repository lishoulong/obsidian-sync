export interface Env {
  SYNC_TOKEN?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;
  GITHUB_BRANCH?: string;
  MAX_FILE_BYTES?: string | number;
}

export interface RequestContext {
  id: string;
  method: string;
  path: string;
}
export interface RepositoryConfig {
  owner: string;
  repo: string;
  branch: string;
}
export interface FileMeta {
  size: number;
  sha256: string;
}
export interface RemoteFileMeta extends FileMeta {
  remoteBlobSha: string;
}
export type Manifest = Record<string, FileMeta>;
export type RemoteManifest = Record<string, RemoteFileMeta>;
export interface SessionPayload {
  v: 2;
  deviceId: string;
  repository: string;
  branch: string;
  baseCommitSha: string | null;
  remoteCommitSha: string;
  exp: number;
}
export interface GitRef {
  object: { sha: string };
}
export interface GitCommit {
  sha?: string;
  tree: { sha: string };
}
export interface GitBlob {
  sha: string;
  encoding?: string;
  content?: string;
}
export interface GitRepository {
  full_name?: string;
  private?: boolean;
  default_branch?: string;
}
export interface GitTreeItem {
  path: string;
  type: string;
  sha: string;
  size?: number;
}
export interface GitTree {
  sha?: string;
  truncated?: boolean;
  tree?: GitTreeItem[];
}
export type GitTreeMutation = {
  path: string;
  mode: "100644";
  type: "blob";
  sha: string | null;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function field(value: unknown, name: string): unknown {
  return isRecord(value) ? value[name] : undefined;
}
