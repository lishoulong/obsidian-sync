import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type VaultBridgeSyncPlugin from "./main";
import { listAutoMergeModels } from "./autoMerge";
import { DeviceState, VaultBridgePluginData, VaultBridgeSettings } from "./types";

const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_AUTO_MERGE_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_AUTO_MERGE_MODEL = "deepseek-v4-flash";
const CLOUDFLARE_WORKERS_URL = "https://dash.cloudflare.com/?to=/:account/workers-and-pages";
const CLOUDFLARE_WORKERS_DOCS_URL = "https://developers.cloudflare.com/workers/";
const DEEPSEEK_API_KEYS_URL = "https://platform.deepseek.com/api_keys";
const DEFAULT_AUTO_MERGE_MODELS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-chat",
  "deepseek-reasoner"
];

export const DEFAULT_EXCLUDE_PATTERNS = [
  ".git/",
  ".vaultbridge/",
  ".DS_Store",
  ".obsidian/workspace",
  ".obsidian/cache/",
  ".obsidian/plugins/vaultbridge-sync/",
  ".remote-conflict-",
  ".auto-merge-proposal-",
  ".local-before-auto-merge-"
];

export const DEFAULT_SETTINGS: VaultBridgeSettings = {
  workerUrl: "",
  syncToken: "",
  deviceId: "",
  localPrefix: "",
  remotePrefix: "vault/",
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
  autoMergeConflicts: false,
  autoMergeMode: "suggest",
  autoMergeEndpoint: DEFAULT_AUTO_MERGE_BASE_URL,
  autoMergeApiKey: "",
  autoMergeModel: DEFAULT_AUTO_MERGE_MODEL,
  autoMergeMaxFileBytes: 200 * 1024,
  autoMergeConfidenceThreshold: 0.9,
  desktopAutoGitPush: false,
  desktopAutoGitPushDelaySeconds: 60,
  desktopGitPullBeforePush: true,
  desktopGitCommitMessagePrefix: "VaultBridge desktop autosync",
  desktopWorkerSyncEnabled: false
};

export function createDefaultData(): VaultBridgePluginData {
  return {
    settings: { ...DEFAULT_SETTINGS, excludePatterns: [...DEFAULT_EXCLUDE_PATTERNS] },
    deviceState: null,
    lastResult: null,
    pendingConflicts: {},
    pendingDesktopGitConflict: null,
    hashCache: {}
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
  private autoMergeModelOptions = [...DEFAULT_AUTO_MERGE_MODELS];

  constructor(app: App, plugin: VaultBridgeSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.plugin.data.settings;
    const isDesktop = Platform.isDesktopApp;
    const workerSyncVisible = !isDesktop || settings.desktopWorkerSyncEnabled;

    containerEl.empty();
    containerEl.createEl("h2", { text: "VaultBridge Sync" });

    if (isDesktop) {
      containerEl.createEl("h3", { text: "Desktop Git" });

      new Setting(containerEl)
        .setName("Git commit and push")
        .setDesc("Commits local desktop vault changes with Git and pushes them to the configured remote.")
        .addButton((button) => button
          .setButtonText("Git push")
          .onClick(() => {
            void this.plugin.desktopGitCommitPush();
          }));

      new Setting(containerEl)
        .setName("Automatic desktop Git push")
        .setDesc("Automatically commits and pushes desktop vault changes after the vault has been idle.")
        .addToggle((toggle) => toggle
          .setValue(settings.desktopAutoGitPush)
          .onChange(async (value) => {
            settings.desktopAutoGitPush = value;
            await this.plugin.savePluginData();
            if (value) this.plugin.scheduleDesktopAutoGitPush();
          }));

      new Setting(containerEl)
        .setName("Auto Git idle delay")
        .setDesc("Seconds to wait after the last desktop vault change before auto push.")
        .addText((text) => text
          .setPlaceholder("60")
          .setValue(String(settings.desktopAutoGitPushDelaySeconds))
          .onChange(async (value) => {
            const parsed = Number(value.trim());
            if (Number.isSafeInteger(parsed) && parsed >= 5) {
              settings.desktopAutoGitPushDelaySeconds = parsed;
              await this.plugin.savePluginData();
            }
          }));

      new Setting(containerEl)
        .setName("Pull before desktop push")
        .setDesc("Runs git pull --rebase --autostash before committing local desktop changes. Conflicts stop auto push.")
        .addToggle((toggle) => toggle
          .setValue(settings.desktopGitPullBeforePush)
          .onChange(async (value) => {
            settings.desktopGitPullBeforePush = value;
            await this.plugin.savePluginData();
          }));

      new Setting(containerEl)
        .setName("Files to commit")
        .setDesc("Git pathspec for desktop commits. Leave empty for the whole vault or use vault/ when notes live under a vault folder.")
        .addText((text) => text
          .setPlaceholder("vault/")
          .setValue(settings.localPrefix)
          .onChange(async (value) => {
            settings.localPrefix = normalizeLocalPrefix(value);
            await this.plugin.savePluginData();
          }));

      new Setting(containerEl)
        .setName("Desktop commit message prefix")
        .setDesc("Prefix used for automatic and manual desktop Git commits.")
        .addText((text) => text
          .setPlaceholder("VaultBridge desktop autosync")
          .setValue(settings.desktopGitCommitMessagePrefix)
          .onChange(async (value) => {
            settings.desktopGitCommitMessagePrefix = value;
            await this.plugin.savePluginData();
          }));

      const pendingGitConflict = this.plugin.data.pendingDesktopGitConflict;
      if (pendingGitConflict?.active) {
        new Setting(containerEl)
          .setName("Desktop Git conflict")
          .setDesc(`${pendingGitConflict.message} Auto Git push is paused until this is resolved.`)
          .addButton((button) => button
            .setButtonText("Continue")
            .onClick(() => {
            void this.plugin.continueDesktopGitConflict();
            }));
      }

      new Setting(containerEl)
        .setName("Enable Worker sync on desktop")
        .setDesc("Advanced: show mobile-style Worker sync settings on desktop. Desktop normally uses local Git instead.")
        .addToggle((toggle) => toggle
          .setValue(settings.desktopWorkerSyncEnabled)
          .onChange(async (value) => {
            settings.desktopWorkerSyncEnabled = value;
            await this.plugin.savePluginData();
            this.display();
          }));
    }

    if (workerSyncVisible) {
      containerEl.createEl("h3", { text: "Worker sync" });

      new Setting(containerEl)
        .setName("Worker URL")
        .setDesc("Paste the deployed Cloudflare Worker URL for this sync service.")
        .addText((text) => text
          .setPlaceholder("https://vaultbridge.example.workers.dev")
          .setValue(settings.workerUrl)
          .onChange(async (value) => {
            settings.workerUrl = normalizeWorkerUrl(value);
            await this.plugin.savePluginData();
          }))
        .addButton((button) => button
          .setButtonText("Open Cloudflare")
          .onClick(() => {
            openExternal(CLOUDFLARE_WORKERS_URL);
          }))
        .addButton((button) => button
          .setButtonText("Docs")
          .onClick(() => {
            openExternal(CLOUDFLARE_WORKERS_DOCS_URL);
          }));

      new Setting(containerEl)
        .setName("SYNC_TOKEN")
        .setDesc(`Paste the same value configured in the Worker's SYNC_TOKEN secret. New token creates a local replacement; Cloudflare secrets cannot be read back. Current value: ${maskToken(settings.syncToken) || "not set"}`)
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setPlaceholder("Worker SYNC_TOKEN")
            .setValue(settings.syncToken)
            .onChange(async (value) => {
              settings.syncToken = value.trim();
              await this.plugin.savePluginData();
            });
        })
        .addButton((button) => button
          .setButtonText("Copy")
          .onClick(async () => {
            if (!settings.syncToken.trim()) {
              new Notice("No SYNC_TOKEN is set.");
              return;
            }
            await copyToClipboard(settings.syncToken);
            new Notice("SYNC_TOKEN copied.");
          }))
        .addButton((button) => button
          .setButtonText("New token")
          .onClick(async () => {
            settings.syncToken = generateSecretToken();
            await copyToClipboard(settings.syncToken);
            await this.plugin.savePluginData();
            new Notice("New local SYNC_TOKEN generated and copied. Replace the Cloudflare Worker secret with this exact value.");
            this.display();
          }))
        .addButton((button) => button
          .setButtonText("Open Cloudflare")
          .onClick(() => {
            openExternal(CLOUDFLARE_WORKERS_URL);
          }));

      new Setting(containerEl)
        .setName("Repository notes folder")
        .setDesc("Folder in the GitHub repository that contains notes. Keep vault/ unless you changed the Worker repository layout.")
        .addText((text) => text
          .setPlaceholder("vault/")
          .setValue(settings.remotePrefix)
          .onChange(async (value) => {
            settings.remotePrefix = normalizeRemotePrefix(value);
            await this.plugin.savePluginData();
          }));

      if (!isDesktop) {
        new Setting(containerEl)
          .setName("Local notes folder")
          .setDesc("Folder inside this Obsidian vault that contains notes. Leave empty when the whole vault should sync.")
          .addText((text) => text
            .setPlaceholder("vault/")
            .setValue(settings.localPrefix)
            .onChange(async (value) => {
              settings.localPrefix = normalizeLocalPrefix(value);
              await this.plugin.savePluginData();
            }));
      }

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

      containerEl.createEl("h3", { text: "Auto Merge Conflict" });

      new Setting(containerEl)
        .setName("Auto Merge Conflict")
        .setDesc("Advanced: uses a configured model service to generate a semantic merge for Worker conflicts. File contents are sent to that service.")
        .addToggle((toggle) => toggle
          .setValue(settings.autoMergeConflicts)
          .onChange(async (value) => {
            settings.autoMergeConflicts = value;
            await this.plugin.savePluginData();
            this.display();
          }));

      if (settings.autoMergeConflicts) {
        new Setting(containerEl)
          .setName("Merge mode")
          .setDesc("Suggest only creates a proposal file. Apply locally writes high-confidence merges to the original file and continues sync.")
          .addDropdown((dropdown) => dropdown
            .addOption("suggest", "Suggest only")
            .addOption("apply", "Apply locally")
            .setValue(settings.autoMergeMode)
            .onChange(async (value) => {
              settings.autoMergeMode = value === "apply" ? "apply" : "suggest";
              await this.plugin.savePluginData();
            }));

        new Setting(containerEl)
          .setName("DeepSeek API key")
          .setDesc(`Stored in plugin data. Current value: ${maskToken(settings.autoMergeApiKey) || "not set"}`)
          .addText((text) => {
            text.inputEl.type = "password";
            text
              .setPlaceholder("API key")
              .setValue(settings.autoMergeApiKey)
              .onChange(async (value) => {
              settings.autoMergeApiKey = value.trim();
              await this.plugin.savePluginData();
            });
          })
          .addButton((button) => button
            .setButtonText("Get API key")
            .onClick(() => {
              openExternal(DEEPSEEK_API_KEYS_URL);
            }));

        new Setting(containerEl)
          .setName("Model")
          .setDesc("Choose a DeepSeek model. Refresh uses your API key to list available models.")
          .addDropdown((dropdown) => {
            for (const model of modelOptions(settings.autoMergeModel, this.autoMergeModelOptions)) {
              dropdown.addOption(model, model);
            }
            dropdown
              .setValue(settings.autoMergeModel)
              .onChange(async (value) => {
                settings.autoMergeModel = value || DEFAULT_AUTO_MERGE_MODEL;
                await this.plugin.savePluginData();
              });
          })
          .addButton((button) => button
            .setButtonText("Refresh")
            .onClick(async () => {
              try {
                const models = await listAutoMergeModels(settings);
                this.autoMergeModelOptions = models.length > 0 ? models : [...DEFAULT_AUTO_MERGE_MODELS];
                if (!this.autoMergeModelOptions.includes(settings.autoMergeModel)) {
                  settings.autoMergeModel = this.autoMergeModelOptions.includes(DEFAULT_AUTO_MERGE_MODEL)
                    ? DEFAULT_AUTO_MERGE_MODEL
                    : this.autoMergeModelOptions[0];
                }
                await this.plugin.savePluginData();
                new Notice(`Loaded ${this.autoMergeModelOptions.length} model(s).`);
                this.display();
              } catch (error) {
                new Notice(error instanceof Error ? error.message : "Unable to load models.");
              }
            }));

        new Setting(containerEl)
          .setName("Test merge")
          .setDesc("Runs a sample LLM merge without syncing or changing vault files. The merged result is copied to clipboard.")
          .addButton((button) => button
            .setButtonText("Test merge")
            .onClick(() => {
              void this.plugin.runAutoMergeTest();
            }));
      }

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
            this.plugin.data.pendingConflicts = {};
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
          if (diagnostics.phase) lines.push(`phase: ${diagnostics.phase}`);
          if (typeof diagnostics.localFiles === "number") lines.push(`scan: local ${diagnostics.localFiles}, skipped ${diagnostics.skippedFiles || 0}`);
          if (diagnostics.pullCounts) lines.push(`pull plan: down ${diagnostics.pullCounts.download}, deleteLocal ${diagnostics.pullCounts.deleteLocal}, up ${diagnostics.pullCounts.upload}, deleteRemote ${diagnostics.pullCounts.deleteRemote}, conflicts ${diagnostics.pullCounts.conflict}`);
          if (diagnostics.pushCounts) lines.push(`push plan: down ${diagnostics.pushCounts.download}, deleteLocal ${diagnostics.pushCounts.deleteLocal}, up ${diagnostics.pushCounts.upload}, deleteRemote ${diagnostics.pushCounts.deleteRemote}, conflicts ${diagnostics.pushCounts.conflict}`);
          if (diagnostics.requestIds?.length) lines.push(`requestIds: ${diagnostics.requestIds.join(", ")}`);
          addPathPreview(lines, "download", diagnostics.downloadPaths);
          addPathPreview(lines, "deleteLocal", diagnostics.deleteLocalPaths);
          addPathPreview(lines, "upload", diagnostics.uploadPaths);
          addPathPreview(lines, "deleteRemote", diagnostics.deleteRemotePaths);
          addPathPreview(lines, "conflict", diagnostics.conflictPaths);
          addPathPreview(lines, "autoMerge", diagnostics.autoMergePaths);
          if (diagnostics.autoMergeWarnings?.length) {
            lines.push("autoMergeWarnings:");
            for (const warning of diagnostics.autoMergeWarnings) lines.push(`- ${warning}`);
          }
        }
        containerEl.createEl("h3", { text: "Last sync diagnostics" });
        containerEl.createEl("pre", {
          cls: "vaultbridge-sync-diagnostics",
          text: lines.join("\n")
        });
      }
    }
  }
}

function addPathPreview(lines: string[], label: string, paths: string[] | undefined): void {
  if (!paths || paths.length === 0) return;
  lines.push(`${label}:`);
  for (const path of paths) lines.push(`- ${path}`);
}

function modelOptions(current: string, models: string[]): string[] {
  return [...new Set([current || DEFAULT_AUTO_MERGE_MODEL, ...models, ...DEFAULT_AUTO_MERGE_MODELS])]
    .filter((model) => model.trim().length > 0);
}

function generateSecretToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function copyToClipboard(value: string): Promise<void> {
  await navigator.clipboard?.writeText(value);
}

function openExternal(url: string): void {
  window.open(url, "_blank", "noopener");
}
