import { App, Platform } from "obsidian";
import { canApplyAutoMergeResult, canAutoMergePath, requestAutoMerge, validateAutoMergeSettings } from "./autoMerge";
import { normalizeLocalPrefix } from "./settings";
import { DesktopGitConflictState, VaultBridgeSettings } from "./types";

interface ExecResult {
  stdout: string;
  stderr: string;
}

interface ExecFile {
  (file: string, args: string[], options: { cwd: string; env?: Record<string, string | undefined> }, callback: (error: Error | null, stdout: string, stderr: string) => void): void;
}

export interface DesktopGitResult {
  commitSha: string | null;
  message: string;
}

export class DesktopGitConflictError extends Error {
  readonly conflict: DesktopGitConflictState;

  constructor(conflict: DesktopGitConflictState) {
    super(conflict.message);
    this.name = "DesktopGitConflictError";
    this.conflict = conflict;
  }
}

export async function desktopGitCommitPush(app: App, settings: VaultBridgeSettings, automatic = false): Promise<DesktopGitResult> {
  if (!Platform.isDesktopApp) {
    throw new Error("Desktop Git push is only available in the Obsidian desktop app.");
  }

  const vaultPath = getVaultBasePath(app);
  const repoRoot = (await git(["rev-parse", "--show-toplevel"], vaultPath)).stdout.trim();
  const pathspec = normalizeLocalPrefix(settings.localPrefix) || ".";
  await assertNoGitConflict(repoRoot);

  if (settings.desktopGitPullBeforePush) {
    try {
      await git(["pull", "--rebase", "--autostash"], repoRoot);
    } catch (error) {
      const conflict = await inspectGitConflict(repoRoot);
      if (conflict.active) throw new DesktopGitConflictError(conflict);
      throw error;
    }
  }

  await git(["add", "-A", "--", pathspec], repoRoot);
  const staged = (await git(["status", "--porcelain"], repoRoot)).stdout.trim();
  if (!staged) return { commitSha: null, message: "No Git changes to push." };

  const prefix = settings.desktopGitCommitMessagePrefix.trim() || "VaultBridge desktop autosync";
  const message = `${prefix} ${new Date().toISOString()}`;
  await git(["commit", "-m", message], repoRoot);
  await git(["push"], repoRoot);
  const commitSha = (await git(["rev-parse", "HEAD"], repoRoot)).stdout.trim();
  return { commitSha, message: `${automatic ? "Auto Git push" : "Git push"} complete at ${commitSha.slice(0, 12)}.` };
}

export interface DesktopGitPullResult {
  pulled: boolean;
  commitSha: string | null;
  message: string;
}

export async function desktopGitPull(app: App): Promise<DesktopGitPullResult> {
  if (!Platform.isDesktopApp) {
    throw new Error("Desktop Git pull is only available in the Obsidian desktop app.");
  }

  const vaultPath = getVaultBasePath(app);
  const repoRoot = (await git(["rev-parse", "--show-toplevel"], vaultPath)).stdout.trim();
  await assertNoGitConflict(repoRoot);

  const before = (await git(["rev-parse", "HEAD"], repoRoot)).stdout.trim();
  try {
    await git(["pull", "--rebase", "--autostash"], repoRoot);
  } catch (error) {
    const conflict = await inspectGitConflict(repoRoot);
    if (conflict.active) throw new DesktopGitConflictError(conflict);
    throw error;
  }
  const after = (await git(["rev-parse", "HEAD"], repoRoot)).stdout.trim();
  const pulled = before !== after;
  return {
    pulled,
    commitSha: after,
    message: pulled ? `Git pull complete at ${after.slice(0, 12)}.` : "Git already up to date."
  };
}

export async function continueDesktopGitConflict(app: App, settings: VaultBridgeSettings): Promise<DesktopGitResult> {
  if (!Platform.isDesktopApp) {
    throw new Error("Desktop Git conflict continuation is only available in the Obsidian desktop app.");
  }

  const vaultPath = getVaultBasePath(app);
  const repoRoot = (await git(["rev-parse", "--show-toplevel"], vaultPath)).stdout.trim();
  const conflict = await inspectGitConflict(repoRoot);
  if (!conflict.active) {
    await git(["push"], repoRoot);
    const commitSha = (await git(["rev-parse", "HEAD"], repoRoot)).stdout.trim();
    return { commitSha, message: `Git push complete at ${commitSha.slice(0, 12)}.` };
  }
  if (conflict.paths.length > 0) throw new DesktopGitConflictError(conflict);

  if (conflict.kind === "rebase") {
    await git(["rebase", "--continue"], repoRoot);
  } else if (conflict.kind === "merge") {
    await git(["commit", "--no-edit"], repoRoot);
  } else if (conflict.kind === "cherry-pick") {
    await git(["cherry-pick", "--continue"], repoRoot);
  } else {
    throw new DesktopGitConflictError(conflict);
  }

  const nextConflict = await inspectGitConflict(repoRoot);
  if (nextConflict.active) throw new DesktopGitConflictError(nextConflict);

  await git(["add", "-A", "--", normalizeLocalPrefix(settings.localPrefix) || "."], repoRoot);
  await git(["push"], repoRoot);
  const commitSha = (await git(["rev-parse", "HEAD"], repoRoot)).stdout.trim();
  return { commitSha, message: `Git conflict resolved and pushed at ${commitSha.slice(0, 12)}.` };
}

export interface DesktopGitAutoMergeOutcome {
  merged: string[];
  skipped: Array<{ path: string; reason: string }>;
  pushed: DesktopGitResult | null;
}

export async function autoMergeDesktopGitConflict(app: App, settings: VaultBridgeSettings): Promise<DesktopGitAutoMergeOutcome> {
  if (!Platform.isDesktopApp) {
    throw new Error("Desktop Git auto merge is only available in the Obsidian desktop app.");
  }
  const settingsWarning = validateAutoMergeSettings(settings);
  if (settingsWarning) throw new Error(settingsWarning);

  const vaultPath = getVaultBasePath(app);
  const repoRoot = (await git(["rev-parse", "--show-toplevel"], vaultPath)).stdout.trim();
  const conflict = await inspectGitConflict(repoRoot);
  if (!conflict.active) throw new Error("No desktop Git conflict is active.");

  const merged: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  for (const path of conflict.paths) {
    if (!canAutoMergePath(path)) {
      skipped.push({ path, reason: "unsupported file type for Auto Merge" });
      continue;
    }

    let ours: string;
    let theirs: string;
    try {
      ours = (await git(["show", `:2:${path}`], repoRoot)).stdout;
      theirs = (await git(["show", `:3:${path}`], repoRoot)).stdout;
    } catch {
      skipped.push({ path, reason: "one side of the conflict is missing (add/delete conflict)" });
      continue;
    }

    if (byteLength(ours) > settings.autoMergeMaxFileBytes || byteLength(theirs) > settings.autoMergeMaxFileBytes) {
      skipped.push({ path, reason: "exceeds the Auto Merge size limit" });
      continue;
    }

    try {
      const result = await requestAutoMerge({ settings, path, localContent: ours, remoteContent: theirs });
      if (!canApplyAutoMergeResult(result, ours, theirs, settings.autoMergeConfidenceThreshold)) {
        skipped.push({ path, reason: `model result not applied (${result.status}, ${Math.round(result.confidence * 100)}% confidence)` });
        continue;
      }
      writeRepoFile(repoRoot, path, result.mergedContent);
      await git(["add", "--", path], repoRoot);
      merged.push(path);
    } catch (error) {
      skipped.push({ path, reason: error instanceof Error ? error.message : "Auto Merge request failed." });
    }
  }

  let pushed: DesktopGitResult | null = null;
  if (skipped.length === 0 && merged.length > 0) {
    pushed = await continueDesktopGitConflict(app, settings);
  }

  return { merged, skipped, pushed };
}

export async function inspectDesktopGitConflict(app: App): Promise<DesktopGitConflictState> {
  if (!Platform.isDesktopApp) {
    throw new Error("Desktop Git conflict inspection is only available in the Obsidian desktop app.");
  }
  const vaultPath = getVaultBasePath(app);
  const repoRoot = (await git(["rev-parse", "--show-toplevel"], vaultPath)).stdout.trim();
  return await inspectGitConflict(repoRoot);
}

function getVaultBasePath(app: App): string {
  const adapter = app.vault.adapter as { getBasePath?: () => string };
  const basePath = adapter.getBasePath?.();
  if (!basePath) throw new Error("Unable to resolve desktop vault path.");
  return basePath;
}

async function assertNoGitConflict(repoRoot: string): Promise<void> {
  const conflict = await inspectGitConflict(repoRoot);
  if (conflict.active) throw new DesktopGitConflictError(conflict);
}

async function inspectGitConflict(repoRoot: string): Promise<DesktopGitConflictState> {
  const status = (await git(["status", "--porcelain"], repoRoot)).stdout;
  const paths = parseUnmergedPaths(status);
  const kind = await detectGitConflictKind(repoRoot, paths.length > 0);
  const active = kind !== null;
  const resolvedButPending = active && paths.length === 0;
  const message = active
    ? resolvedButPending
      ? "Desktop Git conflict resolution is staged; continue Git rebase/merge, then push."
      : `Desktop Git conflict found. Resolve these files, then run Continue Git conflict: ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ", ..." : ""}`
    : "No desktop Git conflict is active.";

  return {
    active,
    kind: kind || "unknown",
    repoRoot,
    paths,
    message,
    updatedAt: new Date().toISOString()
  };
}

async function detectGitConflictKind(repoRoot: string, hasUnmergedPaths: boolean): Promise<DesktopGitConflictState["kind"] | null> {
  if (await gitPathExists(repoRoot, "rebase-merge")) return "rebase";
  if (await gitPathExists(repoRoot, "rebase-apply")) return "rebase";
  if (await gitPathExists(repoRoot, "MERGE_HEAD")) return "merge";
  if (await gitPathExists(repoRoot, "CHERRY_PICK_HEAD")) return "cherry-pick";
  return hasUnmergedPaths ? "unmerged" : null;
}

async function gitPathExists(repoRoot: string, path: string): Promise<boolean> {
  const gitPath = (await git(["rev-parse", "--git-path", path], repoRoot)).stdout.trim();
  const fs = getFs();
  return fs.existsSync(gitPath);
}

function parseUnmergedPaths(status: string): string[] {
  const paths: string[] = [];
  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    if (!["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(code)) continue;
    paths.push(line.slice(3).trim());
  }
  return paths;
}

async function git(args: string[], cwd: string): Promise<ExecResult> {
  const execFile = getExecFile();
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env: { ...process.env, GIT_EDITOR: "true" } }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).trim()));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function getExecFile(): ExecFile {
  const nodeRequire = Function("return require")() as (name: string) => { execFile: ExecFile };
  return nodeRequire("child_process").execFile;
}

function getFs(): { existsSync: (path: string) => boolean; writeFileSync: (path: string, content: string) => void } {
  const nodeRequire = Function("return require")() as (name: string) => { existsSync: (path: string) => boolean; writeFileSync: (path: string, content: string) => void };
  return nodeRequire("fs");
}

function writeRepoFile(repoRoot: string, relativePath: string, content: string): void {
  getFs().writeFileSync(`${repoRoot}/${relativePath}`, content);
}

function byteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}
