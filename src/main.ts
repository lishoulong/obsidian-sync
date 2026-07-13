import { Notice, Platform, Plugin } from "obsidian";
import {
  requestAutoMerge,
  validateAutoMergeSettings
} from "./autoMerge";
import {
  createDefaultData,
  createInitialDeviceId,
  DEFAULT_AUTO_MERGE_BASE_URL,
  DEFAULT_AUTO_MERGE_MODEL,
  DEFAULT_SETTINGS,
  makeDeviceState,
  normalizeRemotePrefix,
  normalizeWorkerUrl,
  VaultBridgeSettingTab,
  validateRequiredSettings
} from "./settings";
import { SyncEngine, showResultNotice } from "./syncEngine";
import { SyncResult, VaultBridgeError, VaultBridgePluginData } from "./types";
import { WorkerClient } from "./workerClient";
import { continueDesktopGitConflict, desktopGitCommitPush, DesktopGitConflictError } from "./desktopGit";

export default class VaultBridgeSyncPlugin extends Plugin {
  data: VaultBridgePluginData = createDefaultData();
  private syncing = false;
  private gitPushing = false;
  private autoGitPushTimer: number | null = null;
  private cancelSyncRequested = false;
  private statusBarEl: HTMLElement | null = null;
  private workerAutoSyncTimer: number | null = null;
  private lastWorkerSyncAttemptAt = 0;
  private lastAutoConflictSignature = "";
  private lastAutoErrorMessage = "";

  async onload(): Promise<void> {
    await this.loadPluginData();

    if (Platform.isDesktopApp) {
      this.statusBarEl = this.addStatusBarItem();
      this.updateStatusBarIdle();
    }

    if (Platform.isDesktopApp) {
      this.addRibbonIcon("git-branch", "VaultBridge Git push", () => {
        void this.desktopGitCommitPush();
      });
    } else {
      this.addRibbonIcon("refresh-cw", "VaultBridge Sync", () => {
        void this.syncNow();
      });
    }

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => {
        void this.syncNow();
      }
    });

    this.addCommand({
      id: "cancel-sync",
      name: "Cancel running sync",
      callback: () => {
        if (!this.syncing) {
          new Notice("No VaultBridge sync is running.");
          return;
        }
        this.cancelSyncRequested = true;
        new Notice("VaultBridge sync will stop after the current file.");
      }
    });

    this.addCommand({
      id: "test-connection",
      name: "Test Worker connection",
      callback: () => {
        void this.testConnection()
          .then(() => new Notice("VaultBridge Worker connection OK."))
          .catch((error) => new Notice(formatError(error), 10000));
      }
    });

    this.addCommand({
      id: "test-auto-merge-conflict",
      name: "Test Auto Merge Conflict",
      callback: () => {
        void this.runAutoMergeTest();
      }
    });

    this.addCommand({
      id: "desktop-git-commit-push",
      name: "Desktop Git commit and push",
      callback: () => {
        void this.desktopGitCommitPush();
      }
    });

    this.addCommand({
      id: "desktop-git-continue-conflict",
      name: "Continue desktop Git conflict",
      callback: () => {
        void this.continueDesktopGitConflict();
      }
    });

    this.addSettingTab(new VaultBridgeSettingTab(this.app, this));
    this.registerDesktopAutoGitPushEvents();
    this.registerWorkerAutoSync();
  }

  private workerSyncAvailable(): boolean {
    return !Platform.isDesktopApp || this.data.settings.desktopWorkerSyncEnabled;
  }

  private workerAutoSyncEnabled(): boolean {
    return this.workerSyncAvailable() && this.data.settings.workerAutoSync;
  }

  private registerWorkerAutoSync(): void {
    this.app.workspace.onLayoutReady(() => {
      if (this.workerAutoSyncEnabled()) void this.autoWorkerSync();
    });

    this.registerEvent(this.app.vault.on("create", () => this.scheduleWorkerAutoSync()));
    this.registerEvent(this.app.vault.on("modify", () => this.scheduleWorkerAutoSync()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleWorkerAutoSync()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleWorkerAutoSync()));

    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState !== "visible" || !this.workerAutoSyncEnabled()) return;
      const minimumGapMs = Math.max(60, this.data.settings.workerAutoSyncDelaySeconds) * 1000;
      if (Date.now() - this.lastWorkerSyncAttemptAt < minimumGapMs) return;
      void this.autoWorkerSync();
    });

    this.registerInterval(window.setInterval(() => {
      const intervalMinutes = this.data.settings.workerAutoSyncIntervalMinutes;
      if (!this.workerAutoSyncEnabled() || intervalMinutes <= 0) return;
      if (Date.now() - this.lastWorkerSyncAttemptAt < intervalMinutes * 60 * 1000) return;
      void this.autoWorkerSync();
    }, 60 * 1000));
  }

  scheduleWorkerAutoSync(): void {
    if (!this.workerAutoSyncEnabled() || this.syncing) return;
    if (this.workerAutoSyncTimer !== null) window.clearTimeout(this.workerAutoSyncTimer);
    const delay = Math.max(10, this.data.settings.workerAutoSyncDelaySeconds) * 1000;
    this.workerAutoSyncTimer = window.setTimeout(() => {
      this.workerAutoSyncTimer = null;
      void this.autoWorkerSync();
    }, delay);
  }

  private async autoWorkerSync(): Promise<void> {
    if (!this.workerAutoSyncEnabled()) return;
    if (this.syncing) {
      this.scheduleWorkerAutoSync();
      return;
    }
    try {
      validateRequiredSettings(this.data.settings);
    } catch {
      return;
    }
    await this.syncNow({ auto: true });
  }

  async loadPluginData(): Promise<void> {
    const loaded = await this.loadData() as Partial<VaultBridgePluginData> | null;
    const settings = { ...DEFAULT_SETTINGS, ...(loaded?.settings || {}) };
    if (!settings.autoMergeEndpoint || settings.autoMergeEndpoint === "https://api.openai.com/v1/chat/completions") {
      settings.autoMergeEndpoint = DEFAULT_AUTO_MERGE_BASE_URL;
    } else {
      settings.autoMergeEndpoint = normalizeWorkerUrl(settings.autoMergeEndpoint);
    }
    if (!settings.autoMergeModel) settings.autoMergeModel = DEFAULT_AUTO_MERGE_MODEL;
    if (!settings.deviceId) settings.deviceId = createInitialDeviceId(this.app);
    if (!settings.localPrefix && normalizeRemotePrefix(settings.remotePrefix) === "vault/" && this.app.vault.getFolderByPath("vault")) {
      settings.localPrefix = "vault/";
    }
    this.data = {
      settings,
      deviceState: loaded?.deviceState || null,
      lastResult: loaded?.lastResult || null,
      pendingConflicts: loaded?.pendingConflicts || {},
      pendingDesktopGitConflict: loaded?.pendingDesktopGitConflict || null,
      hashCache: loaded?.hashCache || {}
    };
    this.data.deviceState = makeDeviceState(this.data.settings, this.data.deviceState);
  }

  async savePluginData(): Promise<void> {
    await this.saveData(this.data);
  }

  async testConnection(): Promise<void> {
    this.requireWorkerSyncEnabled();
    validateRequiredSettings(this.data.settings);
    const client = new WorkerClient(this.data.settings);
    const health = await client.health();
    if (!health.ok || health.service !== "vaultbridge" || health.protocol !== 2) {
      throw new Error("Worker is reachable but does not report VaultBridge Protocol v2.");
    }
    await client.setupCheck();
  }

  async runAutoMergeTest(): Promise<void> {
    const settings = this.data.settings;
    const warning = validateAutoMergeSettings(settings);
    if (warning) {
      new Notice(warning, 10000);
      return;
    }

    new Notice("Auto Merge test started.");

    try {
      const result = await requestAutoMerge({
        settings,
        path: "vaultbridge-auto-merge-test.md",
        localContent: [
          "# VaultBridge test",
          "",
          "- Keep the local drafting note.",
          "- Meeting time: 10:00",
          ""
        ].join("\n"),
        remoteContent: [
          "# VaultBridge test",
          "",
          "- Meeting time: 10:30",
          "- Add the remote follow-up task.",
          ""
        ].join("\n")
      });
      await navigator.clipboard?.writeText(result.mergedContent);
      new Notice(`Auto Merge test ${result.status} (${Math.round(result.confidence * 100)}%). Result copied.`, 12000);
    } catch (error) {
      new Notice(formatError(error), 12000);
    }
  }

  async syncNow(options: { auto?: boolean } = {}): Promise<void> {
    const auto = options.auto === true;
    try {
      this.requireWorkerSyncEnabled();
    } catch (error) {
      if (!auto) new Notice(formatError(error), 10000);
      return;
    }

    if (this.syncing) {
      if (!auto) new Notice("VaultBridge sync is already running.");
      return;
    }

    try {
      validateRequiredSettings(this.data.settings);
    } catch (error) {
      if (!auto) new Notice(formatError(error), 10000);
      return;
    }

    this.syncing = true;
    this.cancelSyncRequested = false;
    this.lastWorkerSyncAttemptAt = Date.now();
    const progress = auto ? null : new SyncProgressReporter(this.statusBarEl);

    try {
      const engine = new SyncEngine({
        vault: this.app.vault,
        fileManager: this.app.fileManager,
        data: this.data,
        saveData: async (data) => {
          this.data = data;
          await this.savePluginData();
        },
        updateStatus: (message) => {
          if (progress) progress.update(message);
          else this.statusBarEl?.setText(`VaultBridge: ${message}`);
        },
        isCancelled: () => this.cancelSyncRequested,
        quiet: auto
      });
      const result = await engine.syncNow();
      if (auto) this.notifyAutoResult(result);
      else showResultNotice(result);
    } catch (error) {
      const message = formatError(error);
      this.data.lastResult = {
        status: "error",
        message,
        counts: { downloaded: 0, uploaded: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, unchanged: 0 },
        conflictPaths: [],
        diagnostics: {
          localPrefix: this.data.settings.localPrefix,
          remotePrefix: this.data.settings.remotePrefix,
          baseCommitSha: this.data.deviceState?.lastSyncedCommitSha || null
        },
        completedAt: new Date().toISOString()
      };
      await this.savePluginData();
      if (!auto || message !== this.lastAutoErrorMessage) new Notice(message, 12000);
      if (auto) this.lastAutoErrorMessage = message;
    } finally {
      this.syncing = false;
      this.cancelSyncRequested = false;
      progress?.done();
      this.updateStatusBarIdle();
    }
  }

  private notifyAutoResult(result: SyncResult): void {
    if (result.status === "success") {
      this.lastAutoConflictSignature = "";
      this.lastAutoErrorMessage = "";
      const changed = result.counts.downloaded + result.counts.uploaded + result.counts.deletedLocal + result.counts.deletedRemote;
      if (changed > 0) {
        new Notice(`VaultBridge auto sync: down ${result.counts.downloaded}, up ${result.counts.uploaded}, del ${result.counts.deletedLocal + result.counts.deletedRemote}.`, 5000);
      }
      return;
    }
    if (result.status === "conflict") {
      const signature = result.conflictPaths.join("|");
      if (signature !== this.lastAutoConflictSignature) {
        this.lastAutoConflictSignature = signature;
        showResultNotice(result);
      }
      return;
    }
    if (result.message !== this.lastAutoErrorMessage) {
      this.lastAutoErrorMessage = result.message;
      showResultNotice(result);
    }
  }

  private updateStatusBarIdle(): void {
    if (!this.statusBarEl) return;
    const result = this.data.lastResult;
    if (!result) {
      this.statusBarEl.setText("VaultBridge: idle");
      return;
    }
    const time = formatClock(result.completedAt);
    const label = result.status === "success" ? `synced ${time}`
      : result.status === "conflict" ? `${result.counts.conflicts} conflict(s) ${time}`
        : `error ${time}`;
    this.statusBarEl.setText(`VaultBridge: ${label}`);
  }

  async desktopGitCommitPush(): Promise<void> {
    if (this.gitPushing) {
      new Notice("VaultBridge Git push is already running.");
      return;
    }

    this.gitPushing = true;
    new Notice("VaultBridge Git push started.");
    try {
      const result = await desktopGitCommitPush(this.app, this.data.settings);
      this.data.pendingDesktopGitConflict = null;
      await this.savePluginData();
      new Notice(result.message, result.commitSha ? 6000 : 4000);
    } catch (error) {
      if (error instanceof DesktopGitConflictError) {
        this.data.pendingDesktopGitConflict = error.conflict;
        await this.savePluginData();
      }
      new Notice(formatError(error), 12000);
    } finally {
      this.gitPushing = false;
    }
  }

  scheduleDesktopAutoGitPush(): void {
    if (!Platform.isDesktopApp || !this.data.settings.desktopAutoGitPush) return;
    if (this.data.pendingDesktopGitConflict?.active) return;
    if (this.autoGitPushTimer !== null) window.clearTimeout(this.autoGitPushTimer);
    const delay = Math.max(5, this.data.settings.desktopAutoGitPushDelaySeconds) * 1000;
    this.autoGitPushTimer = window.setTimeout(() => {
      this.autoGitPushTimer = null;
      void this.desktopAutoGitPush();
    }, delay);
  }

  private registerDesktopAutoGitPushEvents(): void {
    if (!Platform.isDesktopApp) return;
    this.registerEvent(this.app.vault.on("create", () => this.scheduleDesktopAutoGitPush()));
    this.registerEvent(this.app.vault.on("modify", () => this.scheduleDesktopAutoGitPush()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleDesktopAutoGitPush()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleDesktopAutoGitPush()));
  }

  private async desktopAutoGitPush(): Promise<void> {
    if (this.gitPushing || !this.data.settings.desktopAutoGitPush || this.data.pendingDesktopGitConflict?.active) return;
    this.gitPushing = true;
    try {
      const result = await desktopGitCommitPush(this.app, this.data.settings, true);
      this.data.pendingDesktopGitConflict = null;
      await this.savePluginData();
      if (result.commitSha) new Notice(result.message, 5000);
    } catch (error) {
      if (error instanceof DesktopGitConflictError) {
        this.data.pendingDesktopGitConflict = error.conflict;
        await this.savePluginData();
      }
      new Notice(`VaultBridge auto Git push stopped: ${formatError(error)}`, 12000);
    } finally {
      this.gitPushing = false;
    }
  }

  async continueDesktopGitConflict(): Promise<void> {
    if (this.gitPushing) {
      new Notice("VaultBridge Git push is already running.");
      return;
    }

    this.gitPushing = true;
    new Notice("VaultBridge continuing Git conflict...");
    try {
      const result = await continueDesktopGitConflict(this.app, this.data.settings);
      this.data.pendingDesktopGitConflict = null;
      await this.savePluginData();
      new Notice(result.message, 6000);
    } catch (error) {
      if (error instanceof DesktopGitConflictError) {
        this.data.pendingDesktopGitConflict = error.conflict;
        await this.savePluginData();
      }
      new Notice(formatError(error), 12000);
    } finally {
      this.gitPushing = false;
    }
  }

  private requireWorkerSyncEnabled(): void {
    if (Platform.isDesktopApp && !this.data.settings.desktopWorkerSyncEnabled) {
      throw new Error("Worker sync is hidden on desktop. Enable Worker sync on desktop in settings to use this command.");
    }
  }
}

class SyncProgressReporter {
  private notice: Notice;
  private statusBarEl: HTMLElement | null;

  constructor(statusBarEl: HTMLElement | null) {
    this.statusBarEl = statusBarEl;
    this.notice = new Notice("VaultBridge sync started.", 0);
  }

  update(message: string): void {
    this.notice.setMessage(`VaultBridge: ${message}`);
    this.statusBarEl?.setText(`VaultBridge: ${message}`);
  }

  done(): void {
    this.notice.hide();
  }
}

function formatClock(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatError(error: unknown): string {
  if (error instanceof DesktopGitConflictError) return error.conflict.message;
  if (error instanceof VaultBridgeError) return `${error.message} (${error.code})`;
  if (error instanceof Error) return error.message.replace(/Bearer\s+\S+/g, "Bearer [redacted]");
  return "VaultBridge sync failed.";
}
