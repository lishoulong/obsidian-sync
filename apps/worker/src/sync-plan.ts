import type { FileMeta, Manifest, RemoteManifest } from "./types.js";
type Download = {
  path: string;
  reason: "remote_added" | "remote_modified";
  remoteBlobSha: string;
  size: number;
  sha256: string;
};
type DeleteLocal = { path: string; reason: "remote_deleted" };
type Upload = { path: string; reason: "local_added" | "local_modified" };
type DeleteRemote = { path: string; reason: "local_deleted" };
type Conflict = {
  path: string;
  reason:
    | "no_common_base"
    | "local_deleted_remote_modified"
    | "remote_deleted_local_modified"
    | "both_modified";
  remoteBlobSha?: string;
  remoteSize?: number;
};
type Unchanged = { path: string; reason?: "converged" };
export interface SyncPlan {
  download: Download[];
  deleteLocal: DeleteLocal[];
  upload: Upload[];
  deleteRemote: DeleteRemote[];
  conflict: Conflict[];
  unchanged: Unchanged[];
  counts: {
    download: number;
    deleteLocal: number;
    upload: number;
    deleteRemote: number;
    conflict: number;
    unchanged: number;
  };
}
export function compareThreeWay({
  local,
  remote,
  base,
  bootstrap,
}: {
  local: Manifest;
  remote: RemoteManifest;
  base: Manifest;
  bootstrap: boolean;
}): SyncPlan {
  const download: Download[] = [];
  const deleteLocal: DeleteLocal[] = [];
  const upload: Upload[] = [];
  const deleteRemote: DeleteRemote[] = [];
  const conflict: Conflict[] = [];
  const unchanged: Unchanged[] = [];
  const paths = new Set([
    ...Object.keys(local),
    ...Object.keys(remote),
    ...Object.keys(base),
  ]);
  for (const path of [...paths].sort()) {
    const l = local[path],
      r = remote[path],
      b = base[path];
    if (bootstrap || !b) {
      if (l && r) {
        if (sameMeta(l, r)) unchanged.push({ path });
        else
          conflict.push({
            path,
            reason: "no_common_base",
            remoteBlobSha: r.remoteBlobSha,
            remoteSize: r.size,
          });
      } else if (l) upload.push({ path, reason: "local_added" });
      else if (r)
        download.push({
          path,
          reason: "remote_added",
          remoteBlobSha: r.remoteBlobSha,
          size: r.size,
          sha256: r.sha256,
        });
      continue;
    }
    const localChanged = !sameMeta(l, b),
      remoteChanged = !sameMeta(r, b);
    if (!localChanged && !remoteChanged) unchanged.push({ path });
    else if (!localChanged && remoteChanged) {
      if (r)
        download.push({
          path,
          reason: "remote_modified",
          remoteBlobSha: r.remoteBlobSha,
          size: r.size,
          sha256: r.sha256,
        });
      else deleteLocal.push({ path, reason: "remote_deleted" });
    } else if (localChanged && !remoteChanged) {
      if (l) upload.push({ path, reason: "local_modified" });
      else deleteRemote.push({ path, reason: "local_deleted" });
    } else if (sameMeta(l, r)) unchanged.push({ path, reason: "converged" });
    else {
      const entry: Conflict = { path, reason: conflictReason(l, r) };
      if (r) {
        entry.remoteBlobSha = r.remoteBlobSha;
        entry.remoteSize = r.size;
      }
      conflict.push(entry);
    }
  }
  return {
    download,
    deleteLocal,
    upload,
    deleteRemote,
    conflict,
    unchanged,
    counts: {
      download: download.length,
      deleteLocal: deleteLocal.length,
      upload: upload.length,
      deleteRemote: deleteRemote.length,
      conflict: conflict.length,
      unchanged: unchanged.length,
    },
  };
}
function sameMeta(a: FileMeta | undefined, b: FileMeta | undefined): boolean {
  return (
    (!a && !b) || Boolean(a && b && a.size === b.size && a.sha256 === b.sha256)
  );
}
function conflictReason(
  local: FileMeta | undefined,
  remote: FileMeta | undefined,
): Conflict["reason"] {
  if (!local && remote) return "local_deleted_remote_modified";
  if (local && !remote) return "remote_deleted_local_modified";
  return "both_modified";
}
