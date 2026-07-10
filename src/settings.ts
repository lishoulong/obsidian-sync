import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type VaultBridgeSyncPlugin from "./main";
import { DeviceState, VaultBridgePluginData, VaultBridgeSettings } from "./types";

const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;

export const DEFAULT_EXCLUDE_PATTERNS = [
  ".git/",
  ".vaultbridge/",
  ".DS_Store",
  ".obsidian/workspace",
  ".obsidian/cache/",
  ".obsidian/plugins/vaultbridge-sync/",
  ".remote-conflict-"
];

export const DEFAULT_SETTINGS: VaultBridgeSettings = {
  workerUrl: "https://vaultbridge.open-proxy.workers.dev",
  syncToken: "",
  deviceId: "",
  localPrefix: "",
  remotePrefix: "vault/",
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  excludePatterns: DEFAULT_EXCLUDE_PATTERNS
};

export function createDefaultData(): VaultBridgePluginData {
  return {
    settings: { ...DEFAULT_SETTINGS, excludePatterns: [...DEFAULT_EXCLUDE_PATTERNS] },
    deviceState: null,
    lastResult: null
  };
}

export function createInitialDeviceId(app: App): string {
  const vaultName = app.vault.getName().normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 42);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${vaultName || "obsidian"}-${suffix}`.toLowerCase();
}

export function normalizeWorkerUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function normalizeRemotePrefix(value: string): string {
  const trimmed = value.trim().replace(/^\/+/, "").replace(/\\/g, "/").replace(/\/+$/, "");
  return trimmed ? `${trimmed}/` : "";
}

export function normalizeLocalPrefix(value: string): string {
  return normalizeRemotePrefix(value);
}

export function validateRequiredSettings(settings: VaultBridgeSettings): void {
  if (!normalizeWorkerUrl(settings.workerUrl)) throw new Error("Worker URL is required.");
  if (!settings.syncToken.trim()) throw new Error("SYNC_TOKEN is required.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(settings.deviceId.trim())) {
    throw new Error("Device ID must be 2-64 characters using letters, numbers, dot, underscore, or hyphen.");
  }
}

export function makeDeviceState(settings: VaultBridgeSettings, current: DeviceState | null): DeviceState {
  return current && current.deviceId === settings.deviceId
    ? current
    : { version: 2, deviceId: settings.deviceId, lastSyncedCommitSha: null };
}

export function maskToken(token: string): string {
  const value = token.trim();
  if (!value) return "";
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export class VaultBridgeSettingTab extends PluginSettingTab {
  plugin: VaultBridgeSyncPlugin;

  constructor(app: App, plugin: VaultBridgeSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.plugin.data.settings;

    containerEl.empty();
    containerEl.createEl("h2", { text: "VaultBridge Sync" });

    new Setting(containerEl)
      .setName("Worker URL")
      .setDesc("Cloudflare Worker base URL.")
      .addText((text) => text
        .setPlaceholder("https://vaultbridge.example.workers.dev")
        .setValue(settings.workerUrl)
        .onChange(async (value) => {
          settings.workerUrl = normalizeWorkerUrl(value);
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("SYNC_TOKEN")
      .setDesc(`Stored in plugin data. Current value: ${maskToken(settings.syncToken) || "not set"}`)
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Worker SYNC_TOKEN")
          .setValue(settings.syncToken)
          .onChange(async (value) => {
            settings.syncToken = value.trim();
            await this.plugin.savePluginData();
          });
      });

    new Setting(containerEl)
      .setName("Device ID")
      .setDesc("Stable per-device identifier used by Protocol v2.")
      .addText((text) => text
        .setPlaceholder("fred-iphone")
        .setValue(settings.deviceId)
        .onChange(async (value) => {
          settings.deviceId = value.trim();
          this.plugin.data.deviceState = makeDeviceState(settings, this.plugin.data.deviceState);
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("Maximum file size")
      .setDesc("Files larger than this byte limit stop sync before upload.")
      .addText((text) => text
        .setPlaceholder(String(DEFAULT_MAX_FILE_BYTES))
        .setValue(String(settings.maxFileBytes))
        .onChange(async (value) => {
          const parsed = Number(value.trim());
          if (Number.isSafeInteger(parsed) && parsed > 0) {
            settings.maxFileBytes = parsed;
            await this.plugin.savePluginData();
          }
        }));

    new Setting(containerEl)
      .setName("Remote path prefix")
      .setDesc("Git repository path prefix for this Obsidian vault. Use vault/ when the repo stores notes under a vault folder.")
      .addText((text) => text
        .setPlaceholder("vault/")
        .setValue(settings.remotePrefix)
        .onChange(async (value) => {
          settings.remotePrefix = normalizeRemotePrefix(value);
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("Local path prefix")
      .setDesc("Local folder inside the currently opened vault that contains notes. Use vault/ when desktop Obsidian opens the Git repository root.")
      .addText((text) => text
        .setPlaceholder("vault/")
        .setValue(settings.localPrefix)
        .onChange(async (value) => {
          settings.localPrefix = normalizeLocalPrefix(value);
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Checks Worker health, authentication, and Protocol v2 compatibility without modifying vault files.")
      .addButton((button) => button
        .setButtonText("Test")
        .onClick(async () => {
          try {
            await this.plugin.testConnection();
            new Notice("VaultBridge Worker connection OK.");
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Connection test failed.");
          }
        }));

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc("Runs the manual VaultBridge sync workflow.")
      .addButton((button) => button
        .setCta()
        .setButtonText("Sync now")
        .onClick(() => {
          void this.plugin.syncNow();
        }));

    new Setting(containerEl)
      .setName("Reset device state")
      .setDesc("Forces the next sync to bootstrap with no common base. User content is not deleted.")
      .addButton((button) => button
        .setWarning()
        .setButtonText("Reset")
        .onClick(async () => {
          this.plugin.data.deviceState = { version: 2, deviceId: settings.deviceId, lastSyncedCommitSha: null };
          await this.plugin.savePluginData();
          new Notice("VaultBridge device state reset.");
        }));

    if (this.plugin.data.deviceState?.lastSyncedCommitSha) {
      containerEl.createDiv({
        cls: "vaultbridge-sync-summary",
        text: `Last synced commit: ${this.plugin.data.deviceState.lastSyncedCommitSha.slice(0, 12)}`
      });
    }

    if (this.plugin.data.lastResult) {
      const result = this.plugin.data.lastResult;
      const diagnostics = result.diagnostics;
      const lines = [
        `status: ${result.status}`,
        `message: ${result.message}`,
        `completedAt: ${result.completedAt}`,
        `commit: ${result.commitSha || "none"}`,
        `counts: down ${result.counts.downloaded}, up ${result.counts.uploaded}, delete ${result.counts.deletedLocal + result.counts.deletedRemote}, conflicts ${result.counts.conflicts}, unchanged ${result.counts.unchanged}`
      ];
      if (diagnostics) {
        lines.push(
          `prefixes: local "${diagnostics.localPrefix || "(empty)"}", remote "${diagnostics.remotePrefix || "(empty)"}"`,
          `base: ${diagnostics.baseCommitSha ? diagnostics.baseCommitSha.slice(0, 12) : "none"}`,
          `remote: ${diagnostics.remoteCommitSha ? diagnostics.remoteCommitSha.slice(0, 12) : "unknown"}`
        );
        if (typeof diagnostics.localFiles === "number") lines.push(`scan: local ${diagnostics.localFiles}, skipped ${diagnostics.skippedFiles || 0}`);
        if (diagnostics.pullCounts) lines.push(`pull plan: down ${diagnostics.pullCounts.download}, deleteLocal ${diagnostics.pullCounts.deleteLocal}, up ${diagnostics.pullCounts.upload}, deleteRemote ${diagnostics.pullCounts.deleteRemote}, conflicts ${diagnostics.pullCounts.conflict}`);
        if (diagnostics.pushCounts) lines.push(`push plan: down ${diagnostics.pushCounts.download}, deleteLocal ${diagnostics.pushCounts.deleteLocal}, up ${diagnostics.pushCounts.upload}, deleteRemote ${diagnostics.pushCounts.deleteRemote}, conflicts ${diagnostics.pushCounts.conflict}`);
        addPathPreview(lines, "download", diagnostics.downloadPaths);
        addPathPreview(lines, "deleteLocal", diagnostics.deleteLocalPaths);
        addPathPreview(lines, "upload", diagnostics.uploadPaths);
        addPathPreview(lines, "deleteRemote", diagnostics.deleteRemotePaths);
        addPathPreview(lines, "conflict", diagnostics.conflictPaths);
      }
      containerEl.createEl("h3", { text: "Last sync diagnostics" });
      containerEl.createEl("pre", {
        cls: "vaultbridge-sync-diagnostics",
        text: lines.join("\n")
      });
    }
  }
}

function addPathPreview(lines: string[], label: string, paths: string[] | undefined): void {
  if (!paths || paths.length === 0) return;
  lines.push(`${label}:`);
  for (const path of paths) lines.push(`- ${path}`);
}
