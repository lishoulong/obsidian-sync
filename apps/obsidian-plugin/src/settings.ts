import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type VaultBridgeSyncPlugin from "./main";
import { listAutoMergeModels } from "./autoMerge";
import { DeviceState, InitialSyncPreview, PairedDevice, VaultBridgePluginData, VaultBridgeSettings } from "./types";

const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_AUTO_MERGE_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_AUTO_MERGE_MODEL = "deepseek-v4-flash";
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
  workerCredentialKind: null,
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
  workerAutoSync: true,
  workerAutoSyncDelaySeconds: 30,
  workerAutoSyncIntervalMinutes: 30,
  deleteGuardThreshold: 20,
  desktopAutoGitPush: false,
  desktopAutoGitPushDelaySeconds: 60,
  desktopAutoGitPull: true,
  desktopAutoGitPullIntervalMinutes: 10,
  desktopGitPullBeforePush: true,
  desktopGitCommitMessagePrefix: "VaultBridge desktop autosync",
  desktopWorkerSyncEnabled: false
};

export function createDefaultData(): VaultBridgePluginData {
  return {
    settings: { ...DEFAULT_SETTINGS, excludePatterns: [...DEFAULT_EXCLUDE_PATTERNS] },
    deviceState: null,
    lastResult: null,
    onboarding: {
      initialSyncCompleted: false,
      mode: null,
      preview: null
    },
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

export function validateWorkerEndpoint(value: string): string {
  const normalized = normalizeWorkerUrl(value);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("Worker URL is invalid.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("Worker URL must use HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Worker URL must contain only the Worker origin.");
  }
  return url.origin;
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
  validateWorkerEndpoint(settings.workerUrl);
  if (!settings.syncToken.trim()) throw new Error("Worker access token is required.");
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
  private pairedDevices: PairedDevice[] | null = null;
  private deviceListError = "";

  constructor(app: App, plugin: VaultBridgeSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.plugin.data.settings;
    const isDesktop = Platform.isDesktopApp;
    const workerSyncVisible = true;
    const workerSyncOperationsVisible = !isDesktop || settings.desktopWorkerSyncEnabled;

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
        .setName("Automatic desktop Git pull")
        .setDesc("Pulls remote changes when Obsidian starts, when the window regains focus, and on the interval below. Uses git pull --rebase --autostash.")
        .addToggle((toggle) => toggle
          .setValue(settings.desktopAutoGitPull)
          .onChange(async (value) => {
            settings.desktopAutoGitPull = value;
            await this.plugin.savePluginData();
          }));

      new Setting(containerEl)
        .setName("Auto Git pull interval")
        .setDesc("Minutes between periodic Git pulls. 0 disables the timer; startup and focus pulls still apply.")
        .addText((text) => text
          .setPlaceholder("10")
          .setValue(String(settings.desktopAutoGitPullIntervalMinutes))
          .onChange(async (value) => {
            const parsed = Number(value.trim());
            if (Number.isSafeInteger(parsed) && parsed >= 0) {
              settings.desktopAutoGitPullIntervalMinutes = parsed;
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
        const conflictSetting = new Setting(containerEl)
          .setName("Desktop Git conflict")
          .setDesc(`${pendingGitConflict.message} Auto Git push is paused until this is resolved.`)
          .addButton((button) => button
            .setButtonText("Continue")
            .onClick(() => {
            void this.plugin.continueDesktopGitConflict();
            }));
        if (settings.autoMergeConflicts && pendingGitConflict.paths.length > 0) {
          conflictSetting.addButton((button) => button
            .setButtonText("Auto merge")
            .onClick(() => {
              void this.plugin.autoMergeDesktopGitConflictNow();
            }));
        }
      }

      new Setting(containerEl)
        .setName("Enable Worker sync on desktop")
        .setDesc("Advanced: allow this desktop device to run Worker sync and first migration. Desktop normally uses local Git; connection and mobile-device management stay available.")
        .addToggle((toggle) => toggle
          .setValue(settings.desktopWorkerSyncEnabled)
          .onChange(async (value) => {
            settings.desktopWorkerSyncEnabled = value;
            await this.plugin.savePluginData();
            this.display();
          }));

      if (!settings.desktopWorkerSyncEnabled) {
        new Setting(containerEl)
          .setName("Desktop uses local Git")
          .setDesc("Worker connection testing and mobile pairing remain available below. To migrate or sync this desktop through the Worker, explicitly enable Worker sync above; the reviewed first-sync controls will then appear.");
      }
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
          }));

      new Setting(containerEl)
        .setName("Worker access token")
        .setDesc("The first managing device uses the administrator SYNC_TOKEN. Devices connected by QR code receive their own revocable device token automatically.")
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setPlaceholder("Administrator or device token")
            .setValue(settings.syncToken)
            .onChange(async (value) => {
              settings.syncToken = value.trim();
              settings.workerCredentialKind = settings.syncToken ? "administrator" : null;
              await this.plugin.savePluginData();
            });
        });

      if (workerSyncOperationsVisible && !this.plugin.data.onboarding.initialSyncCompleted) {
        containerEl.createEl("h3", { text: "First sync" });

        new Setting(containerEl)
          .setName("Where are the source notes?")
          .setDesc("Choose a direction, preview it, then explicitly start the first sync. Automatic sync stays off until it succeeds.")
          .addDropdown((dropdown) => dropdown
            .addOption("", "Choose a setup mode")
            .addOption("remote", "GitHub is the source")
            .addOption("local", "This device is the source")
            .addOption("merge", "Safely merge both sides")
            .setValue(this.plugin.data.onboarding.mode || "")
            .onChange(async (value) => {
              this.plugin.data.onboarding.mode = value === "remote" || value === "local" || value === "merge"
                ? value
                : null;
              this.plugin.data.onboarding.preview = null;
              await this.plugin.savePluginData();
              this.display();
            }));

        const firstSyncSetting = new Setting(containerEl)
          .setName("First sync plan")
          .setDesc(firstSyncPreviewDescription(this.plugin.data.onboarding.preview))
          .addButton((button) => button
            .setButtonText("Preview")
            .onClick(async () => {
              const mode = this.plugin.data.onboarding.mode;
              if (!mode) {
                new Notice("Choose a first sync mode.");
                return;
              }
              try {
                const preview = await this.plugin.previewFirstSync(mode);
                new Notice(`Plan ready: down ${preview.counts.download}, up ${preview.counts.upload}, conflicts ${preview.counts.conflict}.`, 8000);
                this.display();
              } catch (error) {
                new Notice(error instanceof Error ? error.message : "Unable to preview first sync.", 12000);
              }
            }));
        if (this.plugin.data.onboarding.preview) {
          firstSyncSetting.addButton((button) => button
            .setCta()
            .setButtonText("Start first sync")
            .onClick(async () => {
              try {
                await this.plugin.runFirstSync();
                this.display();
              } catch (error) {
                new Notice(error instanceof Error ? error.message : "Unable to start first sync.", 12000);
                this.display();
              }
            }));
        }
      }

      if (isDesktop && settings.workerCredentialKind !== "device") {
        containerEl.createEl("h3", { text: "Add a mobile device" });

        new Setting(containerEl)
          .setName("One-time pairing")
          .setDesc("Requires the administrator SYNC_TOKEN. Creates a five-minute code; the Worker secret is never placed in the link.")
          .addButton((button) => button
            .setButtonText("Create pairing")
            .onClick(async () => {
              try {
                await this.plugin.createMobilePairing();
                this.display();
              } catch (error) {
                new Notice(error instanceof Error ? error.message : "Unable to create pairing.", 12000);
              }
            }));

        if (this.plugin.latestPairing) {
          const pairing = this.plugin.latestPairing;
          new Setting(containerEl)
            .setName(`Pairing code: ${pairing.code}`)
            .setDesc(`Expires ${new Date(pairing.expiresAt).toLocaleString()}`)
            .addButton((button) => button
              .setCta()
              .setButtonText("Copy pairing link")
              .onClick(async () => {
                await navigator.clipboard.writeText(pairing.link);
                new Notice("VaultBridge pairing link copied.");
              }));
          containerEl.createEl("code", { text: pairing.link });
          const qrImage = containerEl.createEl("img", {
            attr: {
              src: pairing.qrDataUrl,
              alt: "VaultBridge mobile pairing QR code"
            }
          });
          qrImage.style.display = "block";
          qrImage.style.width = "min(320px, 100%)";
          qrImage.style.margin = "12px auto";
        }
      }

      containerEl.createEl("h3", { text: "Device access" });
      if (settings.workerCredentialKind === "device") {
        new Setting(containerEl)
          .setName("Disconnect this device")
          .setDesc("Revokes this device token and removes the saved Worker connection. Local notes remain on this device.")
          .addButton((button) => button
            .setWarning()
            .setButtonText("Disconnect")
            .onClick(async () => {
              try {
                if (await this.plugin.disconnectCurrentDevice()) this.display();
              } catch (error) {
                new Notice(error instanceof Error ? error.message : "Unable to disconnect this device.", 12000);
              }
            }));
      } else {
        new Setting(containerEl)
          .setName("Paired devices")
          .setDesc(this.deviceListError || "Administrator access token required. Review paired devices and revoke a lost or replaced device.")
          .addButton((button) => button
            .setButtonText(this.pairedDevices === null ? "Load devices" : "Refresh")
            .onClick(async () => {
              try {
                this.deviceListError = "";
                this.pairedDevices = await this.plugin.listPairedDevices();
              } catch (error) {
                this.deviceListError = error instanceof Error ? error.message : "Unable to load paired devices.";
              }
              this.display();
            }));
      }

      for (const device of settings.workerCredentialKind === "device" ? [] : (this.pairedDevices || [])) {
        const isCurrent = device.id === settings.deviceId;
        const status = device.revokedAt
          ? `Revoked ${formatDeviceTime(device.revokedAt)}`
          : isCurrent
            ? "Current device"
            : `Last used ${device.lastUsedAt ? formatDeviceTime(device.lastUsedAt) : "never"}`;
        const deviceSetting = new Setting(containerEl)
          .setName(device.name)
          .setDesc(`${status} · Added ${formatDeviceTime(device.createdAt)}`);
        if (!device.revokedAt && !isCurrent) {
          deviceSetting.addButton((button) => button
            .setWarning()
            .setButtonText("Revoke")
            .onClick(async () => {
              try {
                if (await this.plugin.revokePairedDevice(device)) {
                  this.pairedDevices = await this.plugin.listPairedDevices();
                }
              } catch (error) {
                new Notice(error instanceof Error ? error.message : "Unable to revoke device.", 12000);
              }
              this.display();
            }));
        }
      }

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
        .setName("Automatic sync")
        .setDesc(isDesktop && !settings.desktopWorkerSyncEnabled
          ? "Disabled because this desktop uses local Git. Enable Worker sync on desktop above to use Worker automatic sync."
          : this.plugin.data.onboarding.initialSyncCompleted
          ? "Syncs automatically when the app opens, returns to the foreground, after edits, and on a timer."
          : "Unavailable until the reviewed first sync succeeds.")
        .addToggle((toggle) => toggle
          .setValue(this.plugin.data.onboarding.initialSyncCompleted && settings.workerAutoSync)
          .setDisabled(!workerSyncOperationsVisible)
          .onChange(async (value) => {
            if (!this.plugin.data.onboarding.initialSyncCompleted) {
              settings.workerAutoSync = false;
              new Notice("Complete the reviewed first sync before enabling automatic sync.");
              this.display();
              return;
            }
            settings.workerAutoSync = value;
            await this.plugin.savePluginData();
            if (value) this.plugin.scheduleWorkerAutoSync();
          }));

      new Setting(containerEl)
        .setName("Auto sync idle delay")
        .setDesc("Seconds to wait after the last vault change before auto sync. Minimum 10.")
        .addText((text) => text
          .setPlaceholder("30")
          .setValue(String(settings.workerAutoSyncDelaySeconds))
          .onChange(async (value) => {
            const parsed = Number(value.trim());
            if (Number.isSafeInteger(parsed) && parsed >= 10) {
              settings.workerAutoSyncDelaySeconds = parsed;
              await this.plugin.savePluginData();
            }
          }));

      new Setting(containerEl)
        .setName("Auto sync interval")
        .setDesc("Minutes between periodic background syncs. 0 disables the timer; other auto sync triggers still apply.")
        .addText((text) => text
          .setPlaceholder("30")
          .setValue(String(settings.workerAutoSyncIntervalMinutes))
          .onChange(async (value) => {
            const parsed = Number(value.trim());
            if (Number.isSafeInteger(parsed) && parsed >= 0) {
              settings.workerAutoSyncIntervalMinutes = parsed;
              await this.plugin.savePluginData();
            }
          }));

      new Setting(containerEl)
        .setName("Delete guard threshold")
        .setDesc("Stops sync when more than this many files would be deleted locally or remotely. Approve with the command palette when intended. 0 disables the guard.")
        .addText((text) => text
          .setPlaceholder("20")
          .setValue(String(settings.deleteGuardThreshold))
          .onChange(async (value) => {
            const parsed = Number(value.trim());
            if (Number.isSafeInteger(parsed) && parsed >= 0) {
              settings.deleteGuardThreshold = parsed;
              await this.plugin.savePluginData();
            }
          }));

      new Setting(containerEl)
        .setName("Test connection")
        .setDesc("Checks Worker health, authentication, repository, branch, file-size limit, Protocol v2, and D1 pairing readiness without modifying vault files.")
        .addButton((button) => button
            .setButtonText("Test")
            .onClick(async () => {
              try {
                const setup = await this.plugin.testConnection();
                const repository = setup.repository?.fullName || "unknown repository";
                const branch = setup.repository?.branch || "unknown branch";
                const maxFileBytes = setup.limits?.maxFileBytes;
                const limit = typeof maxFileBytes === "number" ? `, max file ${formatBytes(maxFileBytes)}` : "";
                const pairing = setup.health.features?.devicePairing ? "pairing ready" : "pairing unavailable (D1 DB missing)";
                new Notice(`VaultBridge connection OK: ${repository} (${branch}${limit}); ${pairing}.`, 10000);
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

      const pendingConflictCount = Object.keys(this.plugin.data.pendingConflicts || {}).length;
      if (pendingConflictCount > 0) {
        new Setting(containerEl)
          .setName("Pending conflicts")
          .setDesc(`${pendingConflictCount} conflict(s) are waiting for review.`)
          .addButton((button) => button
            .setButtonText("View")
            .onClick(() => {
              this.plugin.showPendingConflicts();
            }));
      }

      new Setting(containerEl)
        .setName("Sync now")
        .setDesc(workerSyncOperationsVisible
          ? "Runs the manual VaultBridge sync workflow."
          : "Disabled because this desktop uses local Git. Enable Worker sync on desktop to run it here.")
        .addButton((button) => button
          .setCta()
          .setDisabled(!workerSyncOperationsVisible)
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
          addPathPreview(lines, "oversized", diagnostics.oversizedPaths);
          if (diagnostics.warnings?.length) {
            lines.push("warnings:");
            for (const warning of diagnostics.warnings) lines.push(`- ${warning}`);
          }
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

function formatDeviceTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024) * 10) / 10} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024 * 10) / 10} KiB`;
  return `${bytes} B`;
}

function addPathPreview(lines: string[], label: string, paths: string[] | undefined): void {
  if (!paths || paths.length === 0) return;
  lines.push(`${label}:`);
  for (const path of paths) lines.push(`- ${path}`);
}

function firstSyncPreviewDescription(preview: InitialSyncPreview | null): string {
  if (!preview) return "No plan yet. Preview performs a read-only scan of this vault and the remote repository.";
  return [
    `Local ${preview.localFiles}, remote ${preview.remoteFiles}.`,
    `Download ${preview.counts.download}, upload ${preview.counts.upload},`,
    `delete local ${preview.counts.deleteLocal}, delete remote ${preview.counts.deleteRemote},`,
    `conflicts ${preview.counts.conflict}, unchanged ${preview.counts.unchanged}.`
  ].join(" ");
}

function modelOptions(current: string, models: string[]): string[] {
  return [...new Set([current || DEFAULT_AUTO_MERGE_MODEL, ...models, ...DEFAULT_AUTO_MERGE_MODELS])]
    .filter((model) => model.trim().length > 0);
}

function openExternal(url: string): void {
  window.open(url, "_blank", "noopener");
}
