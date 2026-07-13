import { FileManifest, VaultBridgeSettings } from "./types";
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
