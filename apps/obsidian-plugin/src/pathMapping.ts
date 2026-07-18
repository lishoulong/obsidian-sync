import { FileManifest, SyncPlan, SyncPlanEntry, VaultBridgeSettings } from "./types";
import { cleanVaultPath } from "./vaultScanner";
import { normalizeLocalPrefix, normalizeRemotePrefix } from "./settings";

export function localToRemotePath(localPath: string, settings: VaultBridgeSettings): string {
  const remotePrefix = normalizeRemotePrefix(settings.remotePrefix);
  const localPrefix = normalizeLocalPrefix(settings.localPrefix);
  const cleanLocal = cleanVaultPath(localPath);
  const contentPath = stripPrefix(cleanLocal, localPrefix);
  return `${remotePrefix}${contentPath}`;
}

export function remoteToLocalPath(remotePath: string, settings: VaultBridgeSettings): string | null {
  const remotePrefix = normalizeRemotePrefix(settings.remotePrefix);
  const localPrefix = normalizeLocalPrefix(settings.localPrefix);
  const cleanRemote = cleanVaultPath(remotePath);
  if (remotePrefix && !cleanRemote.startsWith(remotePrefix)) return null;
  const contentPath = remotePrefix ? cleanRemote.slice(remotePrefix.length) : cleanRemote;
  return contentPath ? cleanVaultPath(`${localPrefix}${contentPath}`) : null;
}

export function localManifestToRemote(manifest: FileManifest, settings: VaultBridgeSettings): FileManifest {
  const remote: FileManifest = {};
  for (const [path, meta] of Object.entries(manifest)) {
    remote[localToRemotePath(path, settings)] = meta;
  }
  return remote;
}

/** Keep repository files outside the configured notes folder out of every
 * client decision, count, and commit patch. The Worker owns the repository-wide
 * manifest, while each plugin instance owns only its configured path mapping. */
export function scopeSyncPlan(plan: SyncPlan, settings: VaultBridgeSettings): SyncPlan {
  const relevant = (entries: SyncPlanEntry[]) => entries.filter((entry) =>
    remoteToLocalPath(entry.path, settings) !== null
  );
  const download = relevant(plan.download);
  const deleteLocal = relevant(plan.deleteLocal);
  const upload = relevant(plan.upload);
  const deleteRemote = relevant(plan.deleteRemote);
  const conflict = relevant(plan.conflict);
  const unchanged = relevant(plan.unchanged);
  return {
    ...plan,
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
      unchanged: unchanged.length
    }
  };
}

export function isWithinLocalPrefix(localPath: string, settings: VaultBridgeSettings): boolean {
  const localPrefix = normalizeLocalPrefix(settings.localPrefix);
  if (!localPrefix) return true;
  return cleanVaultPath(localPath).startsWith(localPrefix);
}

function stripPrefix(path: string, prefix: string): string {
  if (!prefix) return path;
  if (!path.startsWith(prefix)) throw new Error(`${path} is outside local prefix ${prefix}`);
  const stripped = path.slice(prefix.length);
  if (!stripped) throw new Error(`${path} points at the local prefix root`);
  return cleanVaultPath(stripped);
}
