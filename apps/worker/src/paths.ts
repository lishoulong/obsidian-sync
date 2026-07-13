import { INTERNAL_PREFIX, MANIFEST_PATH } from "./constants.js";
import { httpError } from "./http.js";

export function ensureUserPath(path: string): void {
  if (path === MANIFEST_PATH || path.startsWith(INTERNAL_PREFIX))
    throw httpError(400, "reserved_path", `${INTERNAL_PREFIX} is reserved`);
}
export function cleanPath(input: unknown): string {
  if (typeof input !== "string")
    throw httpError(400, "invalid_path", "path must be a string");
  const path = input.normalize("NFC").replace(/^\/+/, "").replace(/\\/g, "/");
  if (
    !path ||
    path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw httpError(400, "invalid_path", input);
  if (path.startsWith(".git/"))
    throw httpError(400, "invalid_path", ".git is not allowed");
  return path;
}

export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
