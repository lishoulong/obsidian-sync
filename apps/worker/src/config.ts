import { httpError } from "./http.js";
import type { Env, RepositoryConfig } from "./types.js";
export function owner(env: Env): string {
  return repositoryConfig(env).owner;
}
export function repo(env: Env): string {
  return repositoryConfig(env).repo;
}
export function branch(env: Env): string {
  return repositoryConfig(env).branch;
}
export function repositoryConfig(env: Env): RepositoryConfig {
  const combined = String(env.GITHUB_REPOSITORY || "").trim();
  const [combinedOwner, combinedRepo, extra] = combined
    ? combined.split("/")
    : [];
  if (extra)
    throw httpError(
      500,
      "invalid_config",
      "GITHUB_REPOSITORY must use owner/repo format",
    );
  const owner = String(env.GITHUB_OWNER || combinedOwner || "").trim();
  const repo = String(env.GITHUB_REPO || combinedRepo || "").trim();
  const branch = String(env.GITHUB_BRANCH || "main").trim();
  validateGitHubName(owner, "GITHUB_OWNER");
  validateGitHubName(repo, "GITHUB_REPO");
  validateBranchName(branch);
  return { owner, repo, branch };
}
export function getConfigStatus(env: Env): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!env.SYNC_TOKEN) missing.push("SYNC_TOKEN");
  if (!env.GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
  try {
    repositoryConfig(env);
  } catch (error: unknown) {
    if (!env.GITHUB_REPOSITORY && !env.GITHUB_OWNER)
      missing.push("GITHUB_OWNER or GITHUB_REPOSITORY");
    if (!env.GITHUB_REPOSITORY && !env.GITHUB_REPO)
      missing.push("GITHUB_REPO or GITHUB_REPOSITORY");
    if (!missing.length)
      missing.push(
        error instanceof Error
          ? error.message
          : "invalid repository configuration",
      );
  }
  return { ok: missing.length === 0, missing };
}
function validateGitHubName(value: string, name: string): void {
  if (!value) throw httpError(500, "missing_config", `${name} is required`);
  if (!/^[A-Za-z0-9_.-]+$/.test(value))
    throw httpError(
      500,
      "invalid_config",
      `${name} contains invalid characters`,
    );
}
function validateBranchName(value: string): void {
  if (!value)
    throw httpError(500, "missing_config", "GITHUB_BRANCH is required");
  if (
    value.includes("..") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\")
  )
    throw httpError(500, "invalid_config", "GITHUB_BRANCH is invalid");
}
export function maxFileBytes(env: Env): number {
  const max = Number(env.MAX_FILE_BYTES || 20 * 1024 * 1024);
  if (!Number.isSafeInteger(max) || max <= 0)
    throw httpError(
      500,
      "invalid_config",
      "MAX_FILE_BYTES must be a positive integer",
    );
  return max;
}
export function required(value: string | undefined, name: string): string {
  if (!value) throw httpError(500, "missing_config", `${name} is required`);
  return value;
}
