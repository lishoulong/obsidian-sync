import { FileManifest, VaultBridgeSettings } from "./types";
import { cleanVaultPath } from "./vaultScanner";
import { normalizeRemotePrefix } from "./settings";

export function localToRemotePath(localPath: string, settings: VaultBridgeSettings): string {
  const prefix = normalizeRemotePrefix(settings.remotePrefix);
  return `${prefix}${cleanVaultPath(localPath)}`;
}

export function remoteToLocalPath(remotePath: string, settings: VaultBridgeSettings): string | null {
  const prefix = normalizeRemotePrefix(settings.remotePrefix);
  const cleanRemote = cleanVaultPath(remotePath);
  if (!prefix) return cleanRemote;
  if (!cleanRemote.startsWith(prefix)) return null;
  const local = cleanRemote.slice(prefix.length);
  return local ? cleanVaultPath(local) : null;
}

export function localManifestToRemote(manifest: FileManifest, settings: VaultBridgeSettings): FileManifest {
  const remote: FileManifest = {};
  for (const [path, meta] of Object.entries(manifest)) {
    remote[localToRemotePath(path, settings)] = meta;
  }
  return remote;
}
