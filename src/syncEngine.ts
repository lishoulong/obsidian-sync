import { FileManager, Notice, TFile, TFolder, Vault } from "obsidian";
import { base64ToArrayBuffer } from "./encoding";
import { makeDeviceState, validateRequiredSettings } from "./settings";
import { sameMeta, scanVault, readFileMeta, sha256Hex, ScanResult } from "./vaultScanner";
import { isExcluded } from "./vaultScanner";
import { localManifestToRemote, localToRemotePath, remoteToLocalPath } from "./pathMapping";
import { stateCommitSha, syncMessage, WorkerClient } from "./workerClient";
import {
  BlobEntry,
  DeviceState,
  FileMeta,
  SyncDiagnostics,
  SyncPlan,
  SyncPlanEntry,
  SyncResult,
  VaultBridgeError,
  VaultBridgePluginData
} from "./types";

export class SyncEngine {
  private vault: Vault;
  private fileManager: FileManager;
  private data: VaultBridgePluginData;
  private saveData: (data: VaultBridgePluginData) => Promise<void>;
  private updateStatus: (message: string) => void;

  constructor(input: {
    vault: Vault;
    fileManager: FileManager;
    data: VaultBridgePluginData;
    saveData: (data: VaultBridgePluginData) => Promise<void>;
    updateStatus: (message: string) => void;
  }) {
    this.vault = input.vault;
    this.fileManager = input.fileManager;
    this.data = input.data;
    this.saveData = input.saveData;
    this.updateStatus = input.updateStatus;
  }

  async syncNow(): Promise<SyncResult> {
    validateRequiredSettings(this.data.settings);
    this.data.deviceState = makeDeviceState(this.data.settings, this.data.deviceState);

    const client = new WorkerClient(this.data.settings);
    this.updateStatus("Scanning vault...");
    const initialScan = await scanVault(this.vault, this.data.settings);
    const initialRemoteManifest = localManifestToRemote(initialScan.manifest, this.data.settings);
    const deviceId = this.data.settings.deviceId;
    const baseSha = stateCommitSha(this.data.deviceState);
    const bootstrapping = baseSha === null;

    this.updateStatus("Checking remote changes...");
    const pullPlan = await client.syncCheck(deviceId, baseSha, initialRemoteManifest);
    const diagnostics = this.createDiagnostics(initialScan, baseSha, pullPlan);
    new Notice(`VaultBridge plan: down ${pullPlan.counts.download}, delete ${pullPlan.counts.deleteLocal}, up ${pullPlan.counts.upload}, conflicts ${pullPlan.counts.conflict}.`, 8000);
    if (this.looksLikePathMappingMismatch(pullPlan, initialScan)) {
      return await this.finish({
        status: "error",
        message: "Path mapping mismatch: set Local path prefix to vault/ when Obsidian opens the repository root.",
        counts: { downloaded: 0, uploaded: 0, deletedLocal: 0, deletedRemote: 0, conflicts: pullPlan.counts.conflict, unchanged: pullPlan.counts.unchanged },
        conflictPaths: [],
        diagnostics
      }, false);
    }
    let downloaded = 0;
    let deletedLocal = 0;
    let uploaded = 0;
    let deletedRemote = 0;
    let conflictCopies: string[] = [];

    if (pullPlan.conflict.length > 0) {
      conflictCopies = await this.writeConflictCopies(client, pullPlan);
      return await this.finish({
        status: "conflict",
        message: `${pullPlan.conflict.length} conflict(s) found. Review conflict copies before syncing again.`,
        counts: { downloaded, uploaded, deletedLocal, deletedRemote, conflicts: pullPlan.conflict.length, unchanged: pullPlan.unchanged.length },
        conflictPaths: conflictCopies,
        diagnostics
      }, false);
    }

    downloaded += await this.applyDownloads(client, pullPlan, initialScan.hashes, diagnostics);
    deletedLocal += await this.applyLocalDeletes(pullPlan, initialScan.hashes);

    if (bootstrapping) {
      this.data.deviceState = { version: 2, deviceId, lastSyncedCommitSha: pullPlan.remoteCommitSha };
      await this.saveData(this.data);
      return await this.finish({
        status: "success",
        message: pullPlan.upload.length > 0 || pullPlan.deleteRemote.length > 0
          ? "Bootstrap pull complete. Local-only files were not uploaded; run sync again to push local changes."
          : "Bootstrap pull complete.",
        counts: { downloaded, uploaded, deletedLocal, deletedRemote, conflicts: 0, unchanged: pullPlan.unchanged.length },
        commitSha: pullPlan.remoteCommitSha,
        conflictPaths: [],
        diagnostics
      }, true);
    }

    this.updateStatus("Re-scanning after pull...");
    const postPullScan = await scanVault(this.vault, this.data.settings);
    const postPullRemoteManifest = localManifestToRemote(postPullScan.manifest, this.data.settings);
    const pushPlan = await client.syncCheck(deviceId, baseSha, postPullRemoteManifest);
    diagnostics.pushCounts = pushPlan.counts;
    addRequestId(diagnostics, pushPlan.requestId);
    diagnostics.uploadPaths = previewPaths(pushPlan.upload);
    diagnostics.deleteRemotePaths = previewPaths(pushPlan.deleteRemote);

    if (pushPlan.conflict.length > 0) {
      conflictCopies = await this.writeConflictCopies(client, pushPlan);
      return await this.finish({
        status: "conflict",
        message: `${pushPlan.conflict.length} conflict(s) found after pull. Review conflict copies before syncing again.`,
        counts: { downloaded, uploaded, deletedLocal, deletedRemote, conflicts: pushPlan.conflict.length, unchanged: pushPlan.unchanged.length },
        conflictPaths: conflictCopies,
        diagnostics
      }, false);
    }

    if (this.hasRelevantRemoteEntries(pushPlan.download) || this.hasRelevantRemoteEntries(pushPlan.deleteLocal)) {
      throw new VaultBridgeError("plan_not_clean", "Remote changes remain after pull. Run sync again.");
    }

    if (pushPlan.upload.length === 0 && pushPlan.deleteRemote.length === 0) {
      if (pushPlan.nextDeviceState) {
        this.data.deviceState = pushPlan.nextDeviceState;
        await this.saveData(this.data);
      }
      return await this.finish({
        status: "success",
        message: "Vault is already in sync.",
        counts: { downloaded, uploaded, deletedLocal, deletedRemote, conflicts: 0, unchanged: pushPlan.unchanged.length },
        conflictPaths: [],
        diagnostics
      }, true);
    }

    this.updateStatus("Uploading local changes...");
    const blobs: BlobEntry[] = [];
    for (const entry of pushPlan.upload) {
      const remotePath = requirePath(entry);
      const path = this.remotePathOrSkip(remotePath);
      if (!path) continue;
      const file = this.vault.getFileByPath(path);
      if (!file) throw new VaultBridgeError("missing_upload_file", `${path} no longer exists for remote ${remotePath}.`);
      const bytes = await this.vault.readBinary(file);
      const blob = await client.createBlob(remotePath, bytes);
      blobs.push(blob);
      addRequestId(diagnostics, blob.requestId);
      uploaded += 1;
    }

    const deleteRemote = pushPlan.deleteRemote.map((entry) => requirePath(entry))
      .filter((remotePath) => {
        const localPath = this.remotePathOrSkip(remotePath);
        return localPath ? !(localPath in postPullScan.manifest) : false;
      });
    deletedRemote = deleteRemote.length;

    this.updateStatus("Committing remote changes...");
    const commit = await client.commit({
      deviceId,
      sessionToken: pushPlan.sessionToken,
      message: syncMessage(deviceId),
      files: postPullRemoteManifest,
      blobs,
      delete: deleteRemote
    });
    addRequestId(diagnostics, commit.requestId);
    this.data.deviceState = commit.deviceState;
    await this.saveData(this.data);

    return await this.finish({
      status: "success",
      message: `Sync complete at ${commit.commitSha.slice(0, 12)}.`,
      counts: { downloaded, uploaded, deletedLocal, deletedRemote, conflicts: 0, unchanged: pushPlan.unchanged.length },
      commitSha: commit.commitSha,
      conflictPaths: [],
      diagnostics
    }, true);
  }

  private createDiagnostics(scan: ScanResult, baseCommitSha: string | null, plan: SyncPlan): SyncDiagnostics {
    const diagnostics: SyncDiagnostics = {
      localPrefix: this.data.settings.localPrefix,
      remotePrefix: this.data.settings.remotePrefix,
      baseCommitSha,
      remoteCommitSha: plan.remoteCommitSha,
      localFiles: Object.keys(scan.manifest).length,
      skippedFiles: scan.skipped.length,
      pullCounts: plan.counts,
      downloadPaths: previewPaths(plan.download),
      deleteLocalPaths: previewPaths(plan.deleteLocal),
      uploadPaths: previewPaths(plan.upload),
      deleteRemotePaths: previewPaths(plan.deleteRemote),
      conflictPaths: previewPaths(plan.conflict)
    };
    addRequestId(diagnostics, plan.requestId);
    return diagnostics;
  }

  private looksLikePathMappingMismatch(plan: SyncPlan, scan: ScanResult): boolean {
    const localPrefix = this.data.settings.localPrefix.trim();
    const remotePrefix = this.data.settings.remotePrefix.trim();
    if (localPrefix || !remotePrefix || Object.keys(scan.manifest).length < 100) return false;
    return plan.counts.download > 100 && plan.counts.upload > 100 && plan.counts.unchanged === 0 && plan.counts.conflict === 0;
  }

  private async applyDownloads(client: WorkerClient, plan: SyncPlan, initialHashes: Map<string, FileMeta>, diagnostics: SyncDiagnostics): Promise<number> {
    let count = 0;
    for (const entry of plan.download) {
      const remotePath = requirePath(entry);
      const path = this.remotePathOrSkip(remotePath);
      if (!path) continue;
      if (isExcluded(path, this.data.settings.excludePatterns)) continue;
      const blobSha = requireBlob(entry);
      const pulled = await client.pullFile(plan.sessionToken, remotePath, blobSha);
      addRequestId(diagnostics, pulled.requestId);
      const content = base64ToArrayBuffer(pulled.content);
      const hash = await sha256Hex(content);
      if (content.byteLength !== pulled.size || hash !== pulled.sha256) {
        throw new VaultBridgeError("download_integrity", `${path} download failed integrity checks.`);
      }
      await this.assertLocalUnchanged(path, initialHashes.get(path), { size: content.byteLength, sha256: hash });
      await this.writeDownloadedFile(path, content);
      count += 1;
    }
    return count;
  }

  private async applyLocalDeletes(plan: SyncPlan, initialHashes: Map<string, FileMeta>): Promise<number> {
    let count = 0;
    for (const entry of plan.deleteLocal) {
      const path = this.remotePathOrSkip(requirePath(entry));
      if (!path) continue;
      if (isExcluded(path, this.data.settings.excludePatterns)) continue;
      await this.assertLocalUnchanged(path, initialHashes.get(path));
      const file = this.vault.getAbstractFileByPath(path);
      if (!file) continue;
      if (!(file instanceof TFile)) throw new VaultBridgeError("delete_not_file", `${path} is not a file; deletion skipped.`);
      await this.fileManager.trashFile(file);
      count += 1;
    }
    return count;
  }

  private async writeConflictCopies(client: WorkerClient, plan: SyncPlan): Promise<string[]> {
    const paths: string[] = [];
    for (const entry of plan.conflict) {
      if (!entry.remoteBlobSha) continue;
      const remotePath = requirePath(entry);
      const path = this.remotePathOrSkip(remotePath);
      if (!path) continue;
      const pulled = await client.pullFile(plan.sessionToken, remotePath, entry.remoteBlobSha);
      const content = base64ToArrayBuffer(pulled.content);
      const conflictPath = await this.nextConflictPath(path);
      await this.createNewFile(conflictPath, content);
      paths.push(conflictPath);
    }
    return paths;
  }

  private async assertLocalUnchanged(path: string, initial: FileMeta | undefined, downloaded?: FileMeta): Promise<void> {
    const current = await this.readPathMeta(path);
    if (!current) {
      if (initial) throw new VaultBridgeError("local_changed", `${path} changed during sync.`);
      return;
    }
    if (initial && !sameMeta(current, initial)) throw new VaultBridgeError("local_changed", `${path} changed during sync.`);
    if (!initial && downloaded && sameMeta(current, downloaded)) return;
    if (!initial) throw new VaultBridgeError("local_changed", `${path} appeared during sync.`);
  }

  private async writeDownloadedFile(path: string, content: ArrayBuffer): Promise<void> {
    await this.ensureParentFolders(path);
    const file = this.vault.getFileByPath(path);
    if (file) {
      try {
        await this.vault.modifyBinary(file, content);
      } catch {
        await this.writeBinaryViaAdapter(path, content);
      }
      return;
    }

    await this.writeBinaryViaAdapter(path, content);
  }

  private async createNewFile(path: string, content: ArrayBuffer): Promise<void> {
    await this.ensureParentFolders(path);
    if (await this.pathExists(path)) {
      throw new VaultBridgeError("file_exists", `${path} already exists.`);
    }

    try {
      await this.vault.adapter.writeBinary(path, content);
      await this.vault.adapter.stat(path);
    } catch (error) {
      throw wrapFileOperationError("create_file", path, error);
    }
  }

  private async writeBinaryViaAdapter(path: string, content: ArrayBuffer): Promise<void> {
    try {
      await this.vault.adapter.writeBinary(path, content);
      await this.vault.adapter.stat(path);
    } catch (error) {
      throw wrapFileOperationError("write_file", path, error);
    }
  }

  private async ensureParentFolders(path: string): Promise<void> {
    const parts = path.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (await this.folderExists(current)) continue;
      try {
        await this.vault.adapter.mkdir(current);
      } catch (error) {
        if (!(await this.folderExistsWithRetry(current))) throw wrapFileOperationError("create_folder", current, error);
      }
    }
  }

  private async folderExists(path: string): Promise<boolean> {
    const abstract = this.vault.getAbstractFileByPath(path);
    if (abstract instanceof TFolder) return true;
    if (abstract) throw new VaultBridgeError("parent_not_folder", `${path} exists but is not a folder.`);
    const stat = await this.vault.adapter.stat(path);
    if (!stat) return false;
    if (stat.type === "folder") return true;
    throw new VaultBridgeError("parent_not_folder", `${path} exists but is not a folder.`);
  }

  private async folderExistsWithRetry(path: string): Promise<boolean> {
    for (const delay of [0, 50, 150, 300]) {
      if (delay > 0) await sleep(delay);
      if (await this.folderExists(path)) return true;
    }
    return false;
  }

  private async pathExists(path: string): Promise<boolean> {
    if (this.vault.getAbstractFileByPath(path)) return true;
    return (await this.vault.adapter.stat(path)) !== null;
  }

  private async readPathMeta(path: string): Promise<FileMeta | null> {
    const file = this.vault.getFileByPath(path);
    if (file) return await readFileMeta(this.vault, file);

    const stat = await this.vault.adapter.stat(path);
    if (!stat) return null;
    if (stat.type !== "file") throw new VaultBridgeError("path_not_file", `${path} exists but is not a file.`);

    const bytes = await this.vault.adapter.readBinary(path);
    return { size: bytes.byteLength, sha256: await sha256Hex(bytes) };
  }

  private async nextConflictPath(path: string): Promise<string> {
    const timestamp = formatTimestamp(new Date());
    const slash = path.lastIndexOf("/");
    const folder = slash >= 0 ? path.slice(0, slash + 1) : "";
    const filename = slash >= 0 ? path.slice(slash + 1) : path;
    const dot = filename.lastIndexOf(".");
    const base = dot > 0 ? filename.slice(0, dot) : filename;
    const extension = dot > 0 ? filename.slice(dot) : "";

    for (let index = 0; index < 1000; index++) {
      const suffix = index === 0 ? "" : `-${index}`;
      const candidate = `${folder}${base}.remote-conflict-${timestamp}${suffix}${extension}`;
      if (!(await this.pathExists(candidate))) return candidate;
    }
    throw new VaultBridgeError("conflict_name_collision", `Unable to create a conflict filename for ${path}.`);
  }

  private remotePathOrSkip(remotePath: string): string | null {
    return remoteToLocalPath(remotePath, this.data.settings);
  }

  private hasRelevantRemoteEntries(entries: SyncPlanEntry[]): boolean {
    return entries.some((entry) => this.remotePathOrSkip(entry.path) !== null);
  }

  private async finish(result: Omit<SyncResult, "completedAt">, persist: boolean): Promise<SyncResult> {
    const full = { ...result, completedAt: new Date().toISOString() };
    this.data.lastResult = full;
    if (persist) {
      await this.saveData(this.data);
    } else {
      await this.saveData(this.data);
    }
    return full;
  }
}

function requirePath(entry: SyncPlanEntry): string {
  if (!entry.path) throw new VaultBridgeError("invalid_plan", "Worker plan entry is missing a path.");
  return entry.path;
}

function requireBlob(entry: SyncPlanEntry): string {
  if (!entry.remoteBlobSha) throw new VaultBridgeError("invalid_plan", `${entry.path} is missing a remote blob SHA.`);
  return entry.remoteBlobSha;
}

function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function previewPaths(entries: SyncPlanEntry[]): string[] {
  return entries.slice(0, 8).map((entry) => entry.path).filter(Boolean);
}

function addRequestId(diagnostics: SyncDiagnostics, requestId: string | undefined): void {
  if (!requestId) return;
  diagnostics.requestIds = diagnostics.requestIds || [];
  if (!diagnostics.requestIds.includes(requestId)) diagnostics.requestIds.push(requestId);
}

function wrapFileOperationError(operation: string, path: string, error: unknown): VaultBridgeError {
  const message = error instanceof Error ? error.message : String(error);
  return new VaultBridgeError(operation, `${operation} failed for ${path}: ${message}`);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function showResultNotice(result: SyncResult): void {
  const parts = [
    `down ${result.counts.downloaded}`,
    `up ${result.counts.uploaded}`,
    `del ${result.counts.deletedLocal + result.counts.deletedRemote}`,
    `conflicts ${result.counts.conflicts}`
  ];
  const conflictHint = result.conflictPaths.length > 0
    ? ` Copies: ${result.conflictPaths.slice(0, 3).join(", ")}${result.conflictPaths.length > 3 ? ", ..." : ""}`
    : "";
  new Notice(`${result.message} (${parts.join(", ")})${conflictHint}`, result.status === "success" ? 6000 : 12000);
}
