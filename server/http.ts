import { HttpError } from "./errors";

import type { ServerRuntime } from "./types";

export const getCookie = (req: Request, name: string) => {
  const cookies = req.headers.get("cookie") || "";
  for (const part of cookies.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      return value.join("=");
    }
  }
  return "";
};

export const getRequestOrigin = (runtime: ServerRuntime, req: Request) => {
  const requestUrl = new URL(req.url);
  if (!runtime.config.trustProxy) {
    return requestUrl.origin;
  }

  const forwardedProto = req.headers
    .get("x-forwarded-proto")
    ?.split(",", 1)[0]
    ?.trim()
    .toLowerCase();
  const forwardedHost =
    req.headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim() ||
    req.headers.get("host")?.trim();
  if (!forwardedProto || !forwardedHost) {
    return requestUrl.origin;
  }

  try {
    return new URL(`${forwardedProto}://${forwardedHost}`).origin;
  } catch {
    return requestUrl.origin;
  }
};

export const isAllowedOrigin = (runtime: ServerRuntime, req: Request) => {
  const origin = req.headers.get("origin");
  if (!origin) {
    return true;
  }

  // Browsers include Origin on same-origin JSON POST/PATCH/PUT requests too.
  // Treat the request URL's origin as same-origin, then require an explicit
  // allow-list entry for cross-origin credentialed requests.
  return (
    origin === getRequestOrigin(runtime, req) ||
    runtime.config.corsOrigins.has(origin)
  );
};

const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "style-src 'self'",
  // Mermaid and CodeMirror generate runtime styles. Scope the compatibility
  // allowance to CSS only; script-src remains nonce/source controlled.
  "style-src-elem 'self' 'unsafe-inline'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob: https: wss:",
  "worker-src 'self' blob:",
  "frame-src 'self' https: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
  "form-action 'self'",
].join("; ");

export const securityHeaders = (runtime: ServerRuntime, req: Request) => {
  const headers = new Headers({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=()",
    "Content-Security-Policy": CSP_DIRECTIVES,
  });
  if (isSecureRequest(runtime, req)) {
    headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
  const origin = req.headers.get("origin");
  if (origin && runtime.config.corsOrigins.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Expose-Headers", "X-File-Created-At");
    headers.set("Vary", "Origin");
  }
  return headers;
};

export const response = (
  runtime: ServerRuntime,
  req: Request,
  body: BodyInit | null,
  init: ResponseInit = {},
) => {
  const headers = securityHeaders(runtime, req);
  const initHeaders = new Headers(init.headers);
  const setCookies = (
    initHeaders as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie?.();
  if (setCookies?.length) {
    initHeaders.delete("set-cookie");
    for (const cookie of setCookies) {
      headers.append("Set-Cookie", cookie);
    }
  }
  initHeaders.forEach((value, key) => headers.set(key, value));
  return new Response(body, { ...init, headers });
};

export const jsonResponse = (
  runtime: ServerRuntime,
  req: Request,
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
) =>
  response(runtime, req, JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });

export const errorResponse = (
  runtime: ServerRuntime,
  req: Request,
  error: unknown,
) => {
  const normalized =
    error instanceof HttpError
      ? error
      : new HttpError(500, "INTERNAL_ERROR", "服务器内部错误");
  if (!(error instanceof HttpError)) {
    console.error("[API] request failed", error);
  }
  return jsonResponse(
    runtime,
    req,
    { error: normalized.message, code: normalized.code },
    normalized.status,
  );
};

export const isSecureRequest = (runtime: ServerRuntime, req: Request) => {
  if (new URL(req.url).protocol === "https:") {
    return true;
  }
  if (!runtime.config.trustProxy) {
    return false;
  }
  return (
    req.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim() === "https"
  );
};

export const readBody = async (req: Request, maxBytes: number) => {
  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new HttpError(413, "BODY_TOO_LARGE", "请求内容超过大小限制");
  }

  if (!req.body) {
    return new Uint8Array();
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "BODY_TOO_LARGE", "请求内容超过大小限制");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

export const readJson = async (req: Request, maxBytes: number) => {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "请求必须使用 JSON 格式",
    );
  }
  const body = await readBody(req, maxBytes);
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "无效的请求格式");
  }
};
