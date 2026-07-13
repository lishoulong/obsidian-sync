import type { RequestContext } from "./types.js";
export function createRequestContext(request: Request): RequestContext {
  const url = new URL(request.url);
  return {
    id: crypto.randomUUID(),
    method: request.method,
    path: url.pathname,
  };
}
export function log(
  ctx: RequestContext,
  event: string,
  data: Record<string, unknown> = {},
): void {
  console.log(
    JSON.stringify({
      service: "vaultbridge",
      event,
      requestId: ctx.id,
      method: ctx.method,
      path: ctx.path,
      ...data,
    }),
  );
}
export function previewPaths<T extends { path?: string }>(
  entries: T[],
): string[] {
  return entries
    .slice(0, 8)
    .map((entry) => entry.path)
    .filter((path): path is string => Boolean(path));
}
