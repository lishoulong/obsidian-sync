import { App, Platform } from "obsidian";
import { normalizeLocalPrefix } from "./settings";
import { VaultBridgeSettings } from "./types";

interface ExecResult {
  stdout: string;
  stderr: string;
}

interface ExecFile {
  (file: string, args: string[], options: { cwd: string }, callback: (error: Error | null, stdout: string, stderr: string) => void): void;
}

export interface DesktopGitResult {
  commitSha: string | null;
  message: string;
}

export async function desktopGitCommitPush(app: App, settings: VaultBridgeSettings): Promise<DesktopGitResult> {
  if (!Platform.isDesktopApp) {
    throw new Error("Desktop Git push is only available in the Obsidian desktop app.");
  }

  const vaultPath = getVaultBasePath(app);
  const repoRoot = (await git(["rev-parse", "--show-toplevel"], vaultPath)).stdout.trim();
  const pathspec = normalizeLocalPrefix(settings.localPrefix) || ".";

  await git(["add", "-A", "--", pathspec], repoRoot);
  const staged = (await git(["status", "--porcelain"], repoRoot)).stdout.trim();
  if (!staged) return { commitSha: null, message: "No Git changes to push." };

  const message = `VaultBridge desktop sync ${new Date().toISOString()}`;
  await git(["commit", "-m", message], repoRoot);
  await git(["push"], repoRoot);
  const commitSha = (await git(["rev-parse", "HEAD"], repoRoot)).stdout.trim();
  return { commitSha, message: `Git push complete at ${commitSha.slice(0, 12)}.` };
}

function getVaultBasePath(app: App): string {
  const adapter = app.vault.adapter as { getBasePath?: () => string };
  const basePath = adapter.getBasePath?.();
  if (!basePath) throw new Error("Unable to resolve desktop vault path.");
  return basePath;
}

async function git(args: string[], cwd: string): Promise<ExecResult> {
  const execFile = getExecFile();
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
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
