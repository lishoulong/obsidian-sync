import type { Vault } from "obsidian";
import { localManifestToRemote, scopeSyncPlan } from "./pathMapping";
import { makeDeviceState, validateWorkerEndpoint } from "./settings";
import type {
  InitialSyncMode,
  InitialSyncPreview,
  SyncPlanEntry,
  VaultBridgePluginData,
  WorkerSetupCheckResponse
} from "./types";
import { scanVault } from "./vaultScanner";
import { WorkerClient } from "./workerClient";

export async function previewInitialSync(
  vault: Vault,
  data: VaultBridgePluginData,
  mode: InitialSyncMode
): Promise<InitialSyncPreview> {
  const scan = await scanVault(vault, data.settings, data.hashCache);
  data.hashCache = scan.hashCache;
  data.deviceState = makeDeviceState(data.settings, data.deviceState);
  const manifest = localManifestToRemote(scan.manifest, data.settings);
  const plan = scopeSyncPlan(
    await new WorkerClient(data.settings).syncCheck(data.settings.deviceId, null, manifest),
    data.settings
  );
  const preview: InitialSyncPreview = {
    mode,
    localFiles: Object.keys(manifest).length,
    remoteFiles: countRemoteFiles(plan.download, plan.conflict, plan.unchanged),
    remoteCommitSha: plan.remoteCommitSha,
    planDigest: await initialSyncPlanDigest(mode, manifest, plan),
    counts: { ...plan.counts },
    createdAt: new Date().toISOString()
  };
  assertInitialSyncDirection(preview);
  return preview;
}

async function initialSyncPlanDigest(
  mode: InitialSyncMode,
  manifest: Record<string, { size: number; sha256: string }>,
  plan: {
    remoteCommitSha: string;
    download: SyncPlanEntry[];
    deleteLocal: SyncPlanEntry[];
    upload: SyncPlanEntry[];
    deleteRemote: SyncPlanEntry[];
    conflict: SyncPlanEntry[];
    unchanged: SyncPlanEntry[];
  }
): Promise<string> {
  const local = Object.entries(manifest)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, meta]) => [path, meta.size, meta.sha256]);
  const entries = (values: SyncPlanEntry[]) => values
    .map((entry) => [
      entry.path,
      entry.reason || "",
      entry.remoteBlobSha || "",
      entry.remoteSize ?? null,
      entry.size ?? null,
      entry.sha256 || ""
    ])
    .sort(([left], [right]) => String(left).localeCompare(String(right)));
  const serialized = JSON.stringify({
    mode,
    remoteCommitSha: plan.remoteCommitSha,
    local,
    download: entries(plan.download),
    deleteLocal: entries(plan.deleteLocal),
    upload: entries(plan.upload),
    deleteRemote: entries(plan.deleteRemote),
    conflict: entries(plan.conflict),
    unchanged: entries(plan.unchanged)
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function assertInitialSyncDirection(preview: InitialSyncPreview): void {
  if (preview.mode === "remote" && preview.localFiles > 0) {
    throw new Error(
      `GitHub-first setup requires an empty local notes folder, but ${preview.localFiles} local file(s) were found.`
    );
  }
  if (preview.mode === "local" && preview.remoteFiles > 0) {
    throw new Error(
      `Local-first setup requires an empty remote notes folder, but ${preview.remoteFiles} remote file(s) were found.`
    );
  }
}

export function assertPrivateRepository(setup: WorkerSetupCheckResponse): void {
  if (setup.repository?.private !== true) {
    throw new Error(
      "VaultBridge requires a private GitHub repository. Make the configured repository private before syncing notes."
    );
  }
}

export function makePairingDeepLink(workerUrl: string, code: string): string {
  const endpoint = workerUrl.trim().replace(/\/+$/, "");
  return `obsidian://vaultbridge-connect?endpoint=${encodeURIComponent(endpoint)}&code=${encodeURIComponent(code.trim())}`;
}

export function validatePairingEndpoint(value: string): string {
  try {
    return validateWorkerEndpoint(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Worker URL is invalid.";
    throw new Error(`Pairing link contains an invalid Worker URL: ${message}`);
  }
}

function countRemoteFiles(...groups: SyncPlanEntry[][]): number {
  return new Set(groups.flat().map((entry) => entry.path)).size;
}
