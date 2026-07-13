import { FileManager, Notice, TFile, TFolder, Vault } from "obsidian";
import { base64ToArrayBuffer } from "./encoding";
import { makeDeviceState, validateRequiredSettings } from "./settings";
import { sameMeta, scanVault, readFileMeta, sha256Hex, ScanResult } from "./vaultScanner";
import { isExcluded } from "./vaultScanner";
import { localManifestToRemote, remoteToLocalPath } from "./pathMapping";
import { stateCommitSha, syncMessage, WorkerClient } from "./workerClient";
import { canAutoMergePath, hasUnresolvedConflictMarkers, requestAutoMerge, validateAutoMergeSettings } from "./autoMerge";
import {
  BlobEntry,
  DeviceState,
  FileManifest,
  FileMeta,
  PendingConflict,
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
  private oversized = new Set<string>();

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
    const initialScan = await this.scanVaultCached();
    const initialRemoteManifest = localManifestToRemote(initialScan.manifest, this.data.settings);
    const deviceId = this.data.settings.deviceId;
    const baseSha = stateCommitSha(this.data.deviceState);
    this.data.pendingConflicts = this.data.pendingConflicts || {};

    this.updateStatus("Checking remote changes...");
    const pullPlan = await client.syncCheck(deviceId, baseSha, initialRemoteManifest);
    const diagnostics = this.createDiagnostics(initialScan, baseSha, pullPlan);
    new Notice(`VaultBridge plan: down ${pullPlan.counts.download}, delete ${pullPlan.counts.deleteLocal}, up ${pullPlan.counts.upload}, conflicts ${pullPlan.counts.conflict}.`, 8000);
    if (initialScan.oversized.length > 0) {
      new Notice(`VaultBridge skipped ${initialScan.oversized.length} file(s) larger than the sync size limit.`, 8000);
    }
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
    let autoMergePaths: string[] = [];

    try {
    let pullConflictState = await this.splitResolvedConflicts(pullPlan);
    if (pullConflictState.unresolved.length > 0) {
      diagnostics.phase = "auto_merge_pull";
      const autoMergeState = await this.tryAutoMergeConflicts(client, pullPlan, pullConflictState.unresolved, initialScan.hashes, diagnostics);
      autoMergePaths = autoMergePaths.concat(autoMergeState.paths);
      pullConflictState = {
        resolved: pullConflictState.resolved.concat(autoMergeState.resolved),
        unresolved: autoMergeState.unresolved
      };
    }
    if (pullConflictState.unresolved.length > 0) {
      diagnostics.phase = "conflict_pull";
      conflictCopies = await this.writeConflictCopies(client, pullPlan, pullConflictState.unresolved);
      return await this.finish({
        status: "conflict",
        message: `${pullConflictState.unresolved.length} conflict(s) found. Review conflict copies before syncing again.`,
        counts: { downloaded, uploaded, deletedLocal, deletedRemote, conflicts: pullConflictState.unresolved.length, unchanged: pullPlan.unchanged.length },
        conflictPaths: conflictCopies.concat(autoMergePaths),
        diagnostics
      }, false);
    }
    const resolvedConflicts = [...pullConflictState.resolved];

    diagnostics.phase = "download";
    downloaded += await this.applyDownloads(client, pullPlan, initialScan.hashes, diagnostics);
    diagnostics.phase = "delete_local";
    deletedLocal += await this.applyLocalDeletes(pullPlan, initialScan.hashes);

    diagnostics.phase = "post_pull_scan";
    this.updateStatus("Re-scanning after pull...");
    let postPullScan = await this.scanVaultCached();
    let postPullRemoteManifest = localManifestToRemote(postPullScan.manifest, this.data.settings);
    diagnostics.phase = "push_plan";
    let pushPlanBaseSha = resolvedConflicts.length > 0 ? pullPlan.remoteCommitSha : (baseSha || pullPlan.remoteCommitSha);
    let pushPlan = await client.syncCheck(deviceId, pushPlanBaseSha, postPullRemoteManifest);
    diagnostics.pushCounts = pushPlan.counts;
    addRequestId(diagnostics, pushPlan.requestId);
    diagnostics.uploadPaths = previewPaths(pushPlan.upload);
    diagnostics.deleteRemotePaths = previewPaths(pushPlan.deleteRemote);

    if (pushPlan.conflict.length > 0) {
      let pushConflictState = await this.splitResolvedConflicts(pushPlan);
      if (pushConflictState.unresolved.length > 0) {
        diagnostics.phase = "auto_merge_push";
        const autoMergeState = await this.tryAutoMergeConflicts(client, pushPlan, pushConflictState.unresolved, postPullScan.hashes, diagnostics);
        autoMergePaths = autoMergePaths.concat(autoMergeState.paths);
        pushConflictState = {
          resolved: pushConflictState.resolved.concat(autoMergeState.resolved),
          unresolved: autoMergeState.unresolved
        };
        if (autoMergeState.applied > 0) {
          diagnostics.phase = "post_auto_merge_scan";
          postPullScan = await this.scanVaultCached();
          postPullRemoteManifest = localManifestToRemote(postPullScan.manifest, this.data.settings);
        }
      }
      resolvedConflicts.push(...pushConflictState.resolved);
      if (pushConflictState.unresolved.length === 0 && pushConflictState.resolved.length > 0) {
        diagnostics.phase = "push_plan_after_resolved_conflicts";
        pushPlanBaseSha = pushPlan.remoteCommitSha;
        pushPlan = await client.syncCheck(deviceId, pushPlanBaseSha, postPullRemoteManifest);
        diagnostics.pushCounts = pushPlan.counts;
        addRequestId(diagnostics, pushPlan.requestId);
        diagnostics.uploadPaths = previewPaths(pushPlan.upload);
        diagnostics.deleteRemotePaths = previewPaths(pushPlan.deleteRemote);
      }
    }

    if (pushPlan.conflict.length > 0) {
      let pushConflictState = await this.splitResolvedConflicts(pushPlan);
      if (pushConflictState.unresolved.length > 0) {
        diagnostics.phase = "auto_merge_push_retry";
        const autoMergeState = await this.tryAutoMergeConflicts(client, pushPlan, pushConflictState.unresolved, postPullScan.hashes, diagnostics);
        autoMergePaths = autoMergePaths.concat(autoMergeState.paths);
        pushConflictState = {
          resolved: pushConflictState.resolved.concat(autoMergeState.resolved),
          unresolved: autoMergeState.unresolved
        };
        if (autoMergeState.applied > 0) {
          diagnostics.phase = "post_auto_merge_retry_scan";
          postPullScan = await this.scanVaultCached();
          postPullRemoteManifest = localManifestToRemote(postPullScan.manifest, this.data.settings);
        }
      }
      if (pushConflictState.unresolved.length === 0 && pushConflictState.resolved.length > 0) {
        diagnostics.phase = "push_plan_after_retry_resolved_conflicts";
        pushPlanBaseSha = pushPlan.remoteCommitSha;
        pushPlan = await client.syncCheck(deviceId, pushPlanBaseSha, postPullRemoteManifest);
        diagnostics.pushCounts = pushPlan.counts;
        addRequestId(diagnostics, pushPlan.requestId);
        diagnostics.uploadPaths = previewPaths(pushPlan.upload);
        diagnostics.deleteRemotePaths = previewPaths(pushPlan.deleteRemote);
      }
    }

    if (pushPlan.conflict.length > 0) {
      const pushConflictState = await this.splitResolvedConflicts(pushPlan);
      if (pushConflictState.unresolved.length === 0 && pushConflictState.resolved.length > 0) {
        diagnostics.phase = "plan_not_clean";
        throw new VaultBridgeError("plan_not_clean", "Resolved conflicts still appear after re-planning. Run sync again.");
      }
      diagnostics.phase = "conflict_after_pull";
      conflictCopies = await this.writeConflictCopies(client, pushPlan, pushConflictState.unresolved);
      return await this.finish({
        status: "conflict",
        message: `${pushConflictState.unresolved.length} conflict(s) found after pull. Review conflict copies before syncing again.`,
        counts: { downloaded, uploaded, deletedLocal, deletedRemote, conflicts: pushConflictState.unresolved.length, unchanged: pushPlan.unchanged.length },
        conflictPaths: conflictCopies.concat(autoMergePaths),
        diagnostics
      }, false);
    }

    if (this.hasRelevantRemoteEntries(pushPlan.download) || this.hasRelevantRemoteEntries(pushPlan.deleteLocal)) {
      diagnostics.phase = "plan_not_clean";
      throw new VaultBridgeError("plan_not_clean", "Remote changes remain after pull. Run sync again.");
    }

    if (pushPlan.upload.length === 0 && pushPlan.deleteRemote.length === 0) {
      diagnostics.phase = "already_in_sync";
      if (pushPlan.nextDeviceState) {
        this.data.deviceState = pushPlan.nextDeviceState;
      }
      this.clearPendingConflicts();
      await this.saveData(this.data);
      return await this.finish({
        status: "success",
        message: "Vault is already in sync.",
        counts: { downloaded, uploaded, deletedLocal, deletedRemote, conflicts: 0, unchanged: pushPlan.unchanged.length },
        conflictPaths: [],
        diagnostics
      }, true);
    }

    diagnostics.phase = "upload_blobs";
    this.updateStatus("Uploading local changes...");
    const blobs: BlobEntry[] = [];
    const upsert: FileManifest = {};
    for (const entry of pushPlan.upload) {
      const remotePath = requirePath(entry);
      const path = this.remotePathOrSkip(remotePath);
      if (!path) continue;
      const file = postPullScan.files.get(path) || this.vault.getFileByPath(path);
      if (!file) throw new VaultBridgeError("missing_upload_file", `${path} no longer exists for remote ${remotePath}.`);
      const bytes = await this.vault.readBinary(file);
      const blob = await client.createBlob(remotePath, bytes);
      blobs.push(blob);
      upsert[remotePath] = postPullRemoteManifest[remotePath];
      addRequestId(diagnostics, blob.requestId);
      uploaded += 1;
    }

    diagnostics.phase = "prepare_commit";
    const deleteRemote = pushPlan.deleteRemote.map((entry) => requirePath(entry))
      .filter((remotePath) => {
        const localPath = this.remotePathOrSkip(remotePath);
        if (!localPath || this.oversized.has(localPath)) return false;
        return !(localPath in postPullScan.manifest);
      });
    deletedRemote = deleteRemote.length;

    diagnostics.phase = "commit";
    this.updateStatus("Committing remote changes...");
    const commit = await client.commit({
      deviceId,
      sessionToken: pushPlan.sessionToken,
      message: syncMessage(deviceId),
      patch: {
        upload: upsert,
        delete: deleteRemote
      },
      blobs,
    });
    addRequestId(diagnostics, commit.requestId);
    diagnostics.phase = "complete";
    this.data.deviceState = commit.deviceState;
    this.clearPendingConflicts();
    await this.saveData(this.data);

    return await this.finish({
      status: "success",
      message: `Sync complete at ${commit.commitSha.slice(0, 12)}.`,
      counts: { downloaded, uploaded, deletedLocal, deletedRemote, conflicts: 0, unchanged: pushPlan.unchanged.length },
      commitSha: commit.commitSha,
      conflictPaths: [],
      diagnostics
    }, true);
    } catch (error) {
      return await this.finish({
        status: "error",
        message: formatSyncError(error),
        counts: { downloaded, uploaded, deletedLocal, deletedRemote, conflicts: 0, unchanged: pullPlan.unchanged.length },
        conflictPaths: conflictCopies.concat(autoMergePaths),
        diagnostics
      }, false);
    }
  }

  private async scanVaultCached(): Promise<ScanResult> {
    const scan = await scanVault(this.vault, this.data.settings, this.data.hashCache);
    this.data.hashCache = scan.hashCache;
    this.oversized = new Set(scan.oversized);
    return scan;
  }

  private createDiagnostics(scan: ScanResult, baseCommitSha: string | null, plan: SyncPlan): SyncDiagnostics {
    const diagnostics: SyncDiagnostics = {
      localPrefix: this.data.settings.localPrefix,
      remotePrefix: this.data.settings.remotePrefix,
      baseCommitSha,
      remoteCommitSha: plan.remoteCommitSha,
      localFiles: Object.keys(scan.manifest).length,
      skippedFiles: scan.skipped.length,
      oversizedPaths: scan.oversized.slice(0, 8),
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
      if (this.oversized.has(path)) {
        addWarning(diagnostics, `${path}: skipped download; the local file exceeds the maximum sync size.`);
        continue;
      }
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
      if (this.oversized.has(path)) continue;
      await this.assertLocalUnchanged(path, initialHashes.get(path));
      const file = this.vault.getAbstractFileByPath(path);
      if (!file) continue;
      if (!(file instanceof TFile)) throw new VaultBridgeError("delete_not_file", `${path} is not a file; deletion skipped.`);
      await this.fileManager.trashFile(file);
      count += 1;
    }
    return count;
  }

  private async writeConflictCopies(client: WorkerClient, plan: SyncPlan, conflicts: SyncPlanEntry[] = plan.conflict): Promise<string[]> {
    const paths: string[] = [];
    this.data.pendingConflicts = this.data.pendingConflicts || {};
    for (const entry of conflicts) {
      if (!entry.remoteBlobSha) continue;
      const remotePath = requirePath(entry);
      const path = this.remotePathOrSkip(remotePath);
      if (!path) continue;
      const existing = this.data.pendingConflicts[remotePath];
      if (existing && this.samePendingConflict(existing, plan, entry)) {
        const existingPaths = await this.existingConflictPaths(existing);
        if (existingPaths.length > 0) {
          paths.push(...existingPaths);
          continue;
        }
      }
      const discoveredPaths = this.findConflictCopiesForPath(path);
      if (discoveredPaths.length > 0) {
        this.data.pendingConflicts[remotePath] = {
          path: remotePath,
          localPath: path,
          remoteCommitSha: plan.remoteCommitSha,
          remoteBlobSha: entry.remoteBlobSha,
          conflictPaths: discoveredPaths,
          createdAt: new Date().toISOString()
        };
        paths.push(...discoveredPaths);
        continue;
      }
      const pulled = await client.pullFile(plan.sessionToken, remotePath, entry.remoteBlobSha);
      const content = base64ToArrayBuffer(pulled.content);
      const conflictPath = await this.nextConflictPath(path);
      await this.createNewFile(conflictPath, content);
      this.data.pendingConflicts[remotePath] = {
        path: remotePath,
        localPath: path,
        remoteCommitSha: plan.remoteCommitSha,
        remoteBlobSha: entry.remoteBlobSha,
        conflictPaths: [conflictPath],
        createdAt: new Date().toISOString()
      };
      paths.push(conflictPath);
    }
    return paths;
  }

  private async tryAutoMergeConflicts(
    client: WorkerClient,
    plan: SyncPlan,
    conflicts: SyncPlanEntry[],
    initialHashes: Map<string, FileMeta>,
    diagnostics: SyncDiagnostics
  ): Promise<{ resolved: SyncPlanEntry[]; unresolved: SyncPlanEntry[]; paths: string[]; applied: number }> {
    const resolved: SyncPlanEntry[] = [];
    const unresolved: SyncPlanEntry[] = [];
    const paths: string[] = [];
    let applied = 0;
    this.data.pendingConflicts = this.data.pendingConflicts || {};

    if (!this.data.settings.autoMergeConflicts) {
      return { resolved, unresolved: conflicts, paths, applied };
    }

    const settingsWarning = validateAutoMergeSettings(this.data.settings);
    if (settingsWarning) {
      addAutoMergeWarning(diagnostics, settingsWarning);
      return { resolved, unresolved: conflicts, paths, applied };
    }

    for (const entry of conflicts) {
      const remotePath = requirePath(entry);
      const path = this.remotePathOrSkip(remotePath);
      if (!path) {
        unresolved.push(entry);
        continue;
      }
      if (!entry.remoteBlobSha) {
        addAutoMergeWarning(diagnostics, `${path}: remote blob is unavailable; skipped Auto Merge.`);
        unresolved.push(entry);
        continue;
      }
      if (!canAutoMergePath(path)) {
        addAutoMergeWarning(diagnostics, `${path}: unsupported file type for Auto Merge.`);
        unresolved.push(entry);
        continue;
      }

      const existingProposalPaths = this.findAutoMergeProposalsForPath(path);
      if (existingProposalPaths.length > 0 && this.data.settings.autoMergeMode === "suggest") {
        paths.push(...existingProposalPaths);
        for (const proposalPath of existingProposalPaths) addAutoMergePath(diagnostics, proposalPath);
        unresolved.push(entry);
        continue;
      }

      const localFile = this.vault.getFileByPath(path);
      const initial = initialHashes.get(path);
      if (!localFile || !initial) {
        addAutoMergeWarning(diagnostics, `${path}: local file is unavailable; skipped Auto Merge.`);
        unresolved.push(entry);
        continue;
      }
      if (initial.size > this.data.settings.autoMergeMaxFileBytes) {
        addAutoMergeWarning(diagnostics, `${path}: local file exceeds Auto Merge size limit.`);
        unresolved.push(entry);
        continue;
      }

      try {
        const localBytes = await this.vault.readBinary(localFile);
        const localContent = decodeUtf8(localBytes, path);
        const pulled = await client.pullFile(plan.sessionToken, remotePath, entry.remoteBlobSha);
        addRequestId(diagnostics, pulled.requestId);
        const remoteBytes = base64ToArrayBuffer(pulled.content);
        const remoteHash = await sha256Hex(remoteBytes);
        if (remoteBytes.byteLength !== pulled.size || remoteHash !== pulled.sha256) {
          throw new VaultBridgeError("download_integrity", `${path} remote conflict download failed integrity checks.`);
        }
        if (remoteBytes.byteLength > this.data.settings.autoMergeMaxFileBytes) {
          addAutoMergeWarning(diagnostics, `${path}: remote file exceeds Auto Merge size limit.`);
          unresolved.push(entry);
          continue;
        }
        const remoteContent = decodeUtf8(remoteBytes, path);
        const result = await requestAutoMerge({
          settings: this.data.settings,
          path,
          localContent,
          remoteContent
        });

        const canApply = this.data.settings.autoMergeMode === "apply"
          && this.canApplyAutoMergeResult(result, localContent, remoteContent);
        if (canApply) {
          await this.assertLocalUnchanged(path, initial);
          const backupPath = await this.nextAutoMergeArtifactPath(path, "local-before-auto-merge");
          await this.createNewFile(backupPath, localBytes);
          await this.writeDownloadedFile(path, encodeUtf8(result.mergedContent));
          this.data.pendingConflicts[remotePath] = {
            path: remotePath,
            localPath: path,
            remoteCommitSha: plan.remoteCommitSha,
            remoteBlobSha: entry.remoteBlobSha,
            conflictPaths: [],
            createdAt: new Date().toISOString()
          };
          paths.push(backupPath);
          addAutoMergePath(diagnostics, backupPath);
          addAutoMergeWarning(diagnostics, `${path}: Auto Merge applied (${formatConfidence(result.confidence)}). ${result.summary || "No summary returned."}`);
          resolved.push(entry);
          applied += 1;
          continue;
        }

        const proposalPath = await this.nextAutoMergeArtifactPath(path, "auto-merge-proposal");
        await this.createNewFile(proposalPath, encodeUtf8(formatAutoMergeProposal(path, result)));
        paths.push(proposalPath);
        addAutoMergePath(diagnostics, proposalPath);
        addAutoMergeWarning(diagnostics, `${path}: Auto Merge proposal created (${result.status}, ${formatConfidence(result.confidence)}). ${result.summary || "No summary returned."}`);
        unresolved.push(entry);
      } catch (error) {
        addAutoMergeWarning(diagnostics, `${path}: ${formatSyncError(error)}`);
        unresolved.push(entry);
      }
    }

    return { resolved, unresolved, paths, applied };
  }

  private async splitResolvedConflicts(plan: SyncPlan): Promise<{ resolved: SyncPlanEntry[]; unresolved: SyncPlanEntry[] }> {
    const resolved: SyncPlanEntry[] = [];
    const unresolved: SyncPlanEntry[] = [];
    const pending = this.data.pendingConflicts || {};

    for (const entry of plan.conflict) {
      const remotePath = requirePath(entry);
      const current = pending[remotePath];
      if (!current || !this.samePendingConflict(current, plan, entry)) {
        unresolved.push(entry);
        continue;
      }

      const existingPaths = await this.existingConflictPaths(current);
      if (existingPaths.length > 0) {
        unresolved.push(entry);
        continue;
      }

      resolved.push(entry);
    }

    return { resolved, unresolved };
  }

  private samePendingConflict(pending: PendingConflict, plan: SyncPlan, entry: SyncPlanEntry): boolean {
    return pending.remoteCommitSha === plan.remoteCommitSha
      && pending.remoteBlobSha === entry.remoteBlobSha;
  }

  private async existingConflictPaths(pending: PendingConflict): Promise<string[]> {
    const existing: string[] = [];
    for (const path of pending.conflictPaths) {
      if (await this.pathExists(path)) existing.push(path);
    }
    return existing;
  }

  private findConflictCopiesForPath(path: string): string[] {
    return this.findSiblingArtifactsForPath(path, "remote-conflict");
  }

  private findAutoMergeProposalsForPath(path: string): string[] {
    return this.findSiblingArtifactsForPath(path, "auto-merge-proposal");
  }

  private findSiblingArtifactsForPath(path: string, label: string): string[] {
    const slash = path.lastIndexOf("/");
    const folder = slash >= 0 ? path.slice(0, slash + 1) : "";
    const filename = slash >= 0 ? path.slice(slash + 1) : path;
    const dot = filename.lastIndexOf(".");
    const base = dot > 0 ? filename.slice(0, dot) : filename;
    const extension = dot > 0 ? filename.slice(dot) : "";
    const prefix = `${folder}${base}.${label}-`;

    return this.vault.getFiles()
      .map((file) => file.path)
      .filter((candidate) => candidate.startsWith(prefix) && candidate.endsWith(extension));
  }

  private canApplyAutoMergeResult(result: { status: string; confidence: number; mergedContent: string; requiresReview: boolean }, localContent: string, remoteContent: string): boolean {
    if (result.status !== "merged" || result.requiresReview) return false;
    if (result.confidence < this.data.settings.autoMergeConfidenceThreshold) return false;
    const merged = result.mergedContent.trim();
    if (!merged) return false;
    const largerInputLength = Math.max(localContent.trim().length, remoteContent.trim().length);
    if (largerInputLength > 200 && merged.length < largerInputLength * 0.35) return false;
    if (merged.includes("```json") || merged.includes("\"mergedContent\"")) return false;
    if (hasUnresolvedConflictMarkers(merged)) return false;
    return true;
  }

  private clearPendingConflicts(): void {
    this.data.pendingConflicts = {};
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
    return await this.nextAutoMergeArtifactPath(path, "remote-conflict");
  }

  private async nextAutoMergeArtifactPath(path: string, label: string): Promise<string> {
    const timestamp = formatTimestamp(new Date());
    const slash = path.lastIndexOf("/");
    const folder = slash >= 0 ? path.slice(0, slash + 1) : "";
    const filename = slash >= 0 ? path.slice(slash + 1) : path;
    const dot = filename.lastIndexOf(".");
    const base = dot > 0 ? filename.slice(0, dot) : filename;
    const extension = dot > 0 ? filename.slice(dot) : "";

    for (let index = 0; index < 1000; index++) {
      const suffix = index === 0 ? "" : `-${index}`;
      const candidate = `${folder}${base}.${label}-${timestamp}${suffix}${extension}`;
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

function addAutoMergePath(diagnostics: SyncDiagnostics, path: string): void {
  diagnostics.autoMergePaths = diagnostics.autoMergePaths || [];
  if (!diagnostics.autoMergePaths.includes(path)) diagnostics.autoMergePaths.push(path);
}

function addAutoMergeWarning(diagnostics: SyncDiagnostics, warning: string): void {
  diagnostics.autoMergeWarnings = diagnostics.autoMergeWarnings || [];
  diagnostics.autoMergeWarnings.push(warning);
}

function addWarning(diagnostics: SyncDiagnostics, warning: string): void {
  diagnostics.warnings = diagnostics.warnings || [];
  if (!diagnostics.warnings.includes(warning)) diagnostics.warnings.push(warning);
}

function decodeUtf8(content: ArrayBuffer, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new VaultBridgeError("auto_merge_encoding", `${path} is not valid UTF-8 text.`);
  }
}

function encodeUtf8(content: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(content);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function formatAutoMergeProposal(path: string, result: {
  status: string;
  confidence: number;
  mergedContent: string;
  summary: string;
  warnings: string[];
  requiresReview: boolean;
}): string {
  const warnings = result.warnings.length > 0 ? result.warnings.join("; ") : "none";
  return [
    "<!-- VaultBridge Auto Merge Proposal",
    `Path: ${path}`,
    `Status: ${result.status}`,
    `Confidence: ${formatConfidence(result.confidence)}`,
    `Requires review: ${result.requiresReview ? "yes" : "no"}`,
    `Summary: ${result.summary || "none"}`,
    `Warnings: ${warnings}`,
    "-->",
    "",
    result.mergedContent
  ].join("\n");
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}% confidence`;
}

function wrapFileOperationError(operation: string, path: string, error: unknown): VaultBridgeError {
  const message = error instanceof Error ? error.message : String(error);
  return new VaultBridgeError(operation, `${operation} failed for ${path}: ${message}`);
}

function formatSyncError(error: unknown): string {
  if (error instanceof VaultBridgeError) return `${error.message} (${error.code})`;
  if (error instanceof Error) return error.message.replace(/Bearer\s+\S+/g, "Bearer [redacted]");
  return "VaultBridge sync failed.";
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
