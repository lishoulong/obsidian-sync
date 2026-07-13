import { API_VERSION } from "./constants.js";
import { repositoryConfig } from "./config.js";
import { httpError, safeJson } from "./http.js";
import { field } from "./types.js";
import type { Env } from "./types.js";
export interface GitHubOptions {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
}
export async function gh<T>(
  env: Env,
  path: string,
  options: GitHubOptions = {},
): Promise<T> {
  if (!env.GITHUB_TOKEN)
    throw httpError(500, "missing_config", "GITHUB_TOKEN is not configured");
  const config = repositoryConfig(env);
  const init: RequestInit = {
    method: options.method || "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "VaultBridge-Worker",
      "Content-Type": "application/json",
    },
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await fetch(
    `https://api.github.com/repos/${config.owner}/${config.repo}${path}`,
    init,
  );
  const text = await response.text();
  const data: unknown = text ? safeJson(text) : {};
  if (!response.ok) {
    const message = field(data, "message");
    const error = httpError(
      response.status,
      "github_error",
      typeof message === "string"
        ? message
        : `GitHub returned ${response.status}`,
    );
    error.details = data;
    throw error;
  }
  return data as T;
}
