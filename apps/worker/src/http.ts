export class HttpError extends Error {
  details?: unknown;
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}
export async function readJson(
  request: Request,
  maxBytes?: number,
): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (
    maxBytes !== undefined &&
    Number.isFinite(declaredLength) &&
    declaredLength > maxBytes
  )
    throw httpError(
      413,
      "payload_too_large",
      `request body must not exceed ${maxBytes} bytes`,
    );
  try {
    const body = await request.arrayBuffer();
    if (maxBytes !== undefined && body.byteLength > maxBytes)
      throw httpError(
        413,
        "payload_too_large",
        `request body must not exceed ${maxBytes} bytes`,
      );
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch (error: unknown) {
    if (error instanceof HttpError) throw error;
    throw httpError(400, "invalid_json", "request body must be JSON");
  }
}
export function httpError(
  status: number,
  code: string,
  message: string,
): HttpError {
  return new HttpError(status, code, message);
}
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
export function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
