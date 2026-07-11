import { Notice, Platform, Plugin } from "obsidian";
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
import { VaultBridgeError, VaultBridgePluginData } from "./types";
import { WorkerClient } from "./workerClient";
import { continueDesktopGitConflict, desktopGitCommitPush, DesktopGitConflictError } from "./desktopGit";

export default class VaultBridgeSyncPlugin extends Plugin {
  data: VaultBridgePluginData = createDefaultData();
  private syncing = false;
  private gitPushing = false;
  private autoGitPushTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadPluginData();

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
      id: "test-connection",
      name: "Test Worker connection",
      callback: () => {
        void this.testConnection()
          .then(() => new Notice("VaultBridge Worker connection OK."))
          .catch((error) => new Notice(formatError(error), 10000));
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
      pendingDesktopGitConflict: loaded?.pendingDesktopGitConflict || null
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

  async syncNow(): Promise<void> {
    try {
      this.requireWorkerSyncEnabled();
    } catch (error) {
      new Notice(formatError(error), 10000);
      return;
    }

    if (this.syncing) {
      new Notice("VaultBridge sync is already running.");
      return;
    }

    try {
      validateRequiredSettings(this.data.settings);
    } catch (error) {
      new Notice(formatError(error), 10000);
      return;
    }

    this.syncing = true;
    new Notice("VaultBridge sync started.");

    try {
      const engine = new SyncEngine({
        vault: this.app.vault,
        fileManager: this.app.fileManager,
        data: this.data,
        saveData: async (data) => {
          this.data = data;
          await this.savePluginData();
        },
        updateStatus: () => undefined
      });
      const result = await engine.syncNow();
      showResultNotice(result);
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
      new Notice(message, 12000);
    } finally {
      this.syncing = false;
    }
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

function formatError(error: unknown): string {
  if (error instanceof DesktopGitConflictError) return error.conflict.message;
  if (error instanceof VaultBridgeError) return `${error.message} (${error.code})`;
  if (error instanceof Error) return error.message.replace(/Bearer\s+\S+/g, "Bearer [redacted]");
  return "VaultBridge sync failed.";
}
