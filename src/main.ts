import { Notice, Plugin } from "obsidian";
import { createDefaultData, createInitialDeviceId, DEFAULT_SETTINGS, makeDeviceState, normalizeRemotePrefix, VaultBridgeSettingTab, validateRequiredSettings } from "./settings";
import { SyncEngine, showResultNotice } from "./syncEngine";
import { VaultBridgeError, VaultBridgePluginData } from "./types";
import { WorkerClient } from "./workerClient";

export default class VaultBridgeSyncPlugin extends Plugin {
  data: VaultBridgePluginData = createDefaultData();
  private syncing = false;

  async onload(): Promise<void> {
    await this.loadPluginData();

    this.addRibbonIcon("refresh-cw", "VaultBridge Sync", () => {
      void this.syncNow();
    });

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

    this.addSettingTab(new VaultBridgeSettingTab(this.app, this));
  }

  async loadPluginData(): Promise<void> {
    const loaded = await this.loadData() as Partial<VaultBridgePluginData> | null;
    const settings = { ...DEFAULT_SETTINGS, ...(loaded?.settings || {}) };
    if (!settings.deviceId) settings.deviceId = createInitialDeviceId(this.app);
    if (!settings.localPrefix && normalizeRemotePrefix(settings.remotePrefix) === "vault/" && this.app.vault.getFolderByPath("vault")) {
      settings.localPrefix = "vault/";
    }
    this.data = {
      settings,
      deviceState: loaded?.deviceState || null,
      lastResult: loaded?.lastResult || null
    };
    this.data.deviceState = makeDeviceState(this.data.settings, this.data.deviceState);
  }

  async savePluginData(): Promise<void> {
    await this.saveData(this.data);
  }

  async testConnection(): Promise<void> {
    validateRequiredSettings(this.data.settings);
    const client = new WorkerClient(this.data.settings);
    const health = await client.health();
    if (!health.ok || health.service !== "vaultbridge" || health.protocol !== 2) {
      throw new Error("Worker is reachable but does not report VaultBridge Protocol v2.");
    }
    await client.syncCheck(this.data.settings.deviceId, null, {});
  }

  async syncNow(): Promise<void> {
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
}

function formatError(error: unknown): string {
  if (error instanceof VaultBridgeError) return `${error.message} (${error.code})`;
  if (error instanceof Error) return error.message.replace(/Bearer\s+\S+/g, "Bearer [redacted]");
  return "VaultBridge sync failed.";
}
