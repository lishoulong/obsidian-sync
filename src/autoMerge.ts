import { VaultBridgeError, VaultBridgeSettings } from "./types";

export type AutoMergeStatus = "merged" | "needs_review" | "unsafe" | "unsupported";

export interface AutoMergeModelResult {
  status: AutoMergeStatus;
  confidence: number;
  mergedContent: string;
  summary: string;
  warnings: string[];
  requiresReview: boolean;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface ModelsResponse {
  data?: Array<{
    id?: string;
  }>;
}

const SUPPORTED_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const REQUEST_TIMEOUT_MS = 120000;
const MAX_AUTO_MERGE_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [0, 1000];

export function canAutoMergePath(path: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extensionOf(path).toLowerCase());
}

export function validateAutoMergeSettings(settings: VaultBridgeSettings): string | null {
  if (!settings.autoMergeEndpoint.trim()) return "Auto Merge base URL is not configured.";
  if (!settings.autoMergeApiKey.trim()) return "Auto Merge API key is not configured.";
  if (!settings.autoMergeModel.trim()) return "Auto Merge model is not configured.";
  return null;
}

export async function listAutoMergeModels(settings: VaultBridgeSettings): Promise<string[]> {
  if (!settings.autoMergeEndpoint.trim()) throw new VaultBridgeError("auto_merge_config", "Auto Merge base URL is not configured.");
  if (!settings.autoMergeApiKey.trim()) throw new VaultBridgeError("auto_merge_config", "Auto Merge API key is not configured.");

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(modelsUrl(settings.autoMergeEndpoint), {
      method: "GET",
      headers: {
        authorization: `Bearer ${settings.autoMergeApiKey.trim()}`
      },
      signal: controller.signal
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Network request failed.";
    throw new VaultBridgeError("auto_merge_network", `Model list request failed: ${message}`);
  } finally {
    window.clearTimeout(timeout);
  }

  const text = await response.text();
  if (response.status < 200 || response.status >= 300) {
    throw new VaultBridgeError("auto_merge_http", `Model list request failed with ${response.status}: ${sanitizeError(text)}`);
  }

  const parsed = parseJson(text) as ModelsResponse;
  const models = (parsed.data || [])
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  return [...new Set(models)].sort();
}

export async function requestAutoMerge(input: {
  settings: VaultBridgeSettings;
  path: string;
  localContent: string;
  remoteContent: string;
}): Promise<AutoMergeModelResult> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_AUTO_MERGE_ATTEMPTS; attempt += 1) {
    try {
      return await requestAutoMergeOnce(input);
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_AUTO_MERGE_ATTEMPTS || !isRetryableAutoMergeError(error)) {
        throw withAttemptContext(error, attempt);
      }
      await sleep(RETRY_DELAYS_MS[attempt - 1] || 0);
    }
  }

  throw withAttemptContext(lastError, MAX_AUTO_MERGE_ATTEMPTS);
}

async function requestAutoMergeOnce(input: {
  settings: VaultBridgeSettings;
  path: string;
  localContent: string;
  remoteContent: string;
}): Promise<AutoMergeModelResult> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(chatCompletionsUrl(input.settings.autoMergeEndpoint), {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.settings.autoMergeApiKey.trim()}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: input.settings.autoMergeModel.trim(),
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You are VaultBridge Auto Merge Conflict, a careful semantic merge engine for personal notes.",
              "Return only valid JSON.",
              "Never invent facts, tasks, links, dates, or note content.",
              "Preserve all non-conflicting information from both versions.",
              "The mergedContent must be a clean final file, ready to save, with no Git conflict markers and no inline conflict comments.",
              "Do not output <<<<<<<, =======, >>>>>>>, <!-- CONFLICT -->, or duplicated alternatives solely to avoid deciding.",
              "When versions disagree, choose the most plausible merged value from context; if there is no better basis, prefer the remote version and mention the decision in summary or warnings.",
              "If a decision is uncertain, still return a clean mergedContent, set requiresReview true, and explain the uncertainty in warnings.",
              "Preserve Markdown structure, YAML frontmatter, code fences, links, tags, and list formatting whenever possible."
            ].join(" ")
          },
          {
            role: "user",
            content: JSON.stringify({
              instruction: "Merge the local and remote versions of this file. Return JSON with status, confidence, mergedContent, summary, warnings, and requiresReview.",
              schema: {
                status: "merged | needs_review | unsafe | unsupported",
                confidence: "number from 0 to 1",
                mergedContent: "string containing the full clean merged file content with no unresolved conflict markers",
                summary: "short human-readable summary",
                warnings: "array of strings",
                requiresReview: "boolean"
              },
              path: input.path,
              localContent: input.localContent,
              remoteContent: input.remoteContent
            })
          }
        ]
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new VaultBridgeError("auto_merge_timeout", `Auto Merge request timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)} seconds.`);
    }
    const message = error instanceof Error ? error.message : "Network request failed.";
    throw new VaultBridgeError("auto_merge_network", `Auto Merge request failed: ${message}`);
  } finally {
    window.clearTimeout(timeout);
  }

  const text = await response.text();
  if (response.status < 200 || response.status >= 300) {
    const code = isRetryableHttpStatus(response.status) ? "auto_merge_retryable_http" : "auto_merge_http";
    throw new VaultBridgeError(code, `Auto Merge request failed with ${response.status}: ${sanitizeError(text)}`);
  }

  const parsed = parseJson(text) as ChatCompletionResponse;
  const content = parsed.choices?.[0]?.message?.content;
  if (!content) throw new VaultBridgeError("auto_merge_response", "Auto Merge response did not include message content.");

  return normalizeModelResult(parseJson(content));
}

function isRetryableAutoMergeError(error: unknown): boolean {
  if (!(error instanceof VaultBridgeError)) return false;
  return error.code === "auto_merge_timeout"
    || error.code === "auto_merge_network"
    || error.code === "auto_merge_retryable_http";
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isAbortError(error: unknown): boolean {
  return typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError";
}

function withAttemptContext(error: unknown, attempts: number): unknown {
  if (attempts <= 1) return error;
  if (error instanceof VaultBridgeError) {
    return new VaultBridgeError(error.code, `${error.message} after ${attempts} attempts.`);
  }
  if (error instanceof Error) return new Error(`${error.message} after ${attempts} attempts.`);
  return error;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export function normalizeModelResult(value: unknown): AutoMergeModelResult {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const status = normalizeStatus(input.status);
  const confidence = normalizeConfidence(input.confidence);
  const mergedContent = typeof input.mergedContent === "string" ? input.mergedContent : "";
  const summary = typeof input.summary === "string" ? input.summary : "";
  const warnings = Array.isArray(input.warnings)
    ? input.warnings.filter((item): item is string => typeof item === "string")
    : [];
  const requiresReview = typeof input.requiresReview === "boolean"
    ? input.requiresReview
    : status !== "merged" || confidence < 0.9;

  if (!mergedContent.trim() && status !== "unsupported") {
    throw new VaultBridgeError("auto_merge_response", "Auto Merge response did not include merged content.");
  }
  if (hasUnresolvedConflictMarkers(mergedContent)) {
    throw new VaultBridgeError("auto_merge_response", "Auto Merge response still contained unresolved conflict markers.");
  }

  return { status, confidence, mergedContent, summary, warnings, requiresReview };
}

export function canApplyAutoMergeResult(
  result: AutoMergeModelResult,
  localContent: string,
  remoteContent: string,
  confidenceThreshold: number
): boolean {
  if (result.status !== "merged" || result.requiresReview) return false;
  if (result.confidence < confidenceThreshold) return false;
  const merged = result.mergedContent.trim();
  if (!merged) return false;
  const largerInputLength = Math.max(localContent.trim().length, remoteContent.trim().length);
  if (largerInputLength > 200 && merged.length < largerInputLength * 0.35) return false;
  if (merged.includes("```json") || merged.includes("\"mergedContent\"")) return false;
  if (hasUnresolvedConflictMarkers(merged)) return false;
  return true;
}

export function hasUnresolvedConflictMarkers(content: string): boolean {
  return /(^|\n)(<<<<<<<|=======|>>>>>>>)(?=\s|$)/.test(content)
    || /<!--\s*CONFLICT\b/i.test(content)
    || /\bCONFLICT:\s*(local|remote|ours|theirs)\b/i.test(content);
}

function normalizeStatus(value: unknown): AutoMergeStatus {
  if (value === "merged" || value === "needs_review" || value === "unsafe" || value === "unsupported") return value;
  return "needs_review";
}

function normalizeConfidence(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(1, parsed));
}

function extensionOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const filename = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot) : "";
}

function chatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (normalized.endsWith("/chat/completions")) return normalized;
  return `${normalized}/chat/completions`;
}

function modelsUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (normalized.endsWith("/chat/completions")) return `${normalized.slice(0, -"/chat/completions".length)}/models`;
  return `${normalized}/models`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new VaultBridgeError("auto_merge_response", "Auto Merge response was not valid JSON.");
  }
}

function sanitizeError(message: string): string {
  return message.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/g, "Bearer [redacted]");
}
