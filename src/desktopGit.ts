import { App, Platform } from "obsidian";
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

function getFs(): { existsSync: (path: string) => boolean } {
  const nodeRequire = Function("return require")() as (name: string) => { existsSync: (path: string) => boolean };
  return nodeRequire("fs");
}
