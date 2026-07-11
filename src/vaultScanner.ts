import { normalizePath, TFile, Vault } from "obsidian";
import { FileManifest, FileMeta, VaultBridgeError, VaultBridgeSettings } from "./types";
import { normalizeLocalPrefix } from "./settings";

export interface ScanResult {
  manifest: FileManifest;
  files: Map<string, TFile>;
  hashes: Map<string, FileMeta>;
  skipped: string[];
}

function isWithinLocalPrefix(localPath: string, settings: VaultBridgeSettings): boolean {
  const localPrefix = normalizeLocalPrefix(settings.localPrefix);
  if (!localPrefix) return true;
  return cleanVaultPath(localPath).startsWith(localPrefix);
}

export async function scanVault(vault: Vault, settings: VaultBridgeSettings): Promise<ScanResult> {
  const manifest: FileManifest = {};
  const files = new Map<string, TFile>();
  const hashes = new Map<string, FileMeta>();
  const skipped: string[] = [];

  for (const file of vault.getFiles()) {
    const path = cleanVaultPath(file.path);
    if (!isWithinLocalPrefix(path, settings)) {
      skipped.push(path);
      continue;
    }
    if (isExcluded(path, settings.excludePatterns)) {
      skipped.push(path);
      continue;
    }
    if (file.stat.size > settings.maxFileBytes) {
      throw new VaultBridgeError("file_too_large", `${path} exceeds the configured maximum file size.`);
    }

    const bytes = await vault.readBinary(file);
    const meta = { size: bytes.byteLength, sha256: await sha256Hex(bytes) };
    manifest[path] = meta;
    files.set(path, file);
    hashes.set(path, meta);
  }

  return { manifest, files, hashes, skipped };
}

export function cleanVaultPath(input: string): string {
  const path = normalizePath(input.normalize("NFC").replace(/^\/+/, "").replace(/\\/g, "/"));
  if (!path || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new VaultBridgeError("invalid_path", `Invalid vault path: ${input}`);
  }
  return path;
}

export function isExcluded(path: string, patterns: string[]): boolean {
  if (path.startsWith(".git/") || path.startsWith(".vaultbridge/")) return true;
  if (path === ".DS_Store" || path.endsWith("/.DS_Store")) return true;
  if (path.includes(".remote-conflict-")) return true;
  if (path.includes(".auto-merge-proposal-")) return true;
  if (path.includes(".local-before-auto-merge-")) return true;

  return patterns.some((pattern) => {
    const value = pattern.trim();
    if (!value) return false;
    if (value.endsWith("/")) return path.startsWith(value);
    return path === value || path.startsWith(value);
  });
}

export async function readFileMeta(vault: Vault, file: TFile): Promise<FileMeta> {
  const bytes = await vault.readBinary(file);
  return { size: bytes.byteLength, sha256: await sha256Hex(bytes) };
}

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function sameMeta(left: FileMeta | undefined, right: FileMeta | undefined): boolean {
  if (!left || !right) return false;
  return left.size === right.size && left.sha256 === right.sha256;
}
