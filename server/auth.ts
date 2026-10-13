import {
  AUTH_COOKIE_DEVELOPMENT,
  AUTH_COOKIE_PRODUCTION,
  AUTH_RATE_WINDOW_MS,
  MAX_AUTH_PASSWORD_LENGTH,
  WRITE_RATE_WINDOW_MS,
} from "./config";
import {
  hmacSha256Hex,
  randomBase64Url,
  timingSafeEqual,
} from "./crypto";
import { getCookie, isSecureRequest } from "./http";

import type { RequestAddressResolver, ServerRuntime } from "./types";

export const cleanupExpiredSessions = async (
  runtime: ServerRuntime,
  now: number,
) => {
  try {
    await runtime.db.run("DELETE FROM sessions WHERE expires_at <= ?", [now]);
  } catch (error) {
    console.info("[Sessions] cleanup failed", error);
  }
};

export const cleanupExpiredRateLimits = async (
  runtime: ServerRuntime,
  now = Date.now(),
) => {
  try {
    await runtime.db.run(
      `DELETE FROM rate_limits
       WHERE (action = 'auth' AND window_started_at <= ?)
          OR (action = 'write' AND window_started_at <= ?)`,
      [now - AUTH_RATE_WINDOW_MS, now - WRITE_RATE_WINDOW_MS],
    );
  } catch (error) {
    console.info("[Rate limits] cleanup failed", error);
  }
};

export const getClientKey = (
  runtime: ServerRuntime,
  req: Request,
  requestAddressResolver?: RequestAddressResolver,
) => {
  if (runtime.config.trustProxy) {
    const forwardedAddresses = req.headers
      .get("x-forwarded-for")
      ?.split(",")
      .map((address) => address.trim())
      .filter(Boolean);
    // Trusted proxies commonly append the address they observed. The leftmost
    // value can be supplied by the client when a proxy preserves X-Forwarded-For.
    return forwardedAddresses?.at(-1) || "unknown";
  }
  return requestAddressResolver?.(req) || runtime.clientAddress || "unknown";
};

const getSessionCookieNames = () => [
  AUTH_COOKIE_PRODUCTION,
  AUTH_COOKIE_DEVELOPMENT,
];

export const getSessionToken = (runtime: ServerRuntime, req: Request) => {
  for (const name of getSessionCookieNames()) {
    const token = getCookie(req, name);
    if (token) {
      return token;
    }
  }
  return "";
};

export const hashSessionToken = (runtime: ServerRuntime, token: string) =>
  hmacSha256Hex(runtime.config.authPassword, token);

export const issueSessionCookie = async (
  runtime: ServerRuntime,
  req: Request,
) => {
  const token = randomBase64Url(32);
  const now = Date.now();
  const expiresAt = now + runtime.config.sessionTtlMs;
  await runtime.db.run(
    "INSERT OR REPLACE INTO sessions (token, expires_at, created_at) VALUES (?, ?, ?)",
    [await hashSessionToken(runtime, token), expiresAt, now],
  );
  const secure = isSecureRequest(runtime, req);
  const name =
    runtime.config.nodeEnv === "production" && secure
      ? AUTH_COOKIE_PRODUCTION
      : AUTH_COOKIE_DEVELOPMENT;
  return `${name}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.ceil(
    runtime.config.sessionTtlMs / 1000,
  )}${secure ? "; Secure" : ""}`;
};

export const clearSessionCookies = (runtime: ServerRuntime, req: Request) => {
  const secure = isSecureRequest(runtime, req);
  const names = secure
    ? [AUTH_COOKIE_PRODUCTION, AUTH_COOKIE_DEVELOPMENT]
    : [AUTH_COOKIE_DEVELOPMENT];
  return names.map(
    (name) =>
      `${name}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${
        name === AUTH_COOKIE_PRODUCTION ? "; Secure" : ""
      }`,
  );
};

export const isAuthorized = async (runtime: ServerRuntime, req: Request) => {
  if (runtime.config.allowAnonymous || !runtime.config.authPassword) {
    return true;
  }
  const bearerToken = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (runtime.config.mcpToken && bearerToken) {
    const provided = new TextEncoder().encode(bearerToken);
    const expected = new TextEncoder().encode(runtime.config.mcpToken);
    if (timingSafeEqual(provided, expected)) return true;
  }
  const token = getSessionToken(runtime, req);
  if (!token) {
    return false;
  }
  const hashedToken = await hashSessionToken(runtime, token);
  try {
    const row = await runtime.db
      .query("SELECT expires_at FROM sessions WHERE token = ? LIMIT 1")
      .get<{ expires_at: number }>(hashedToken);
    if (!row || row.expires_at <= Date.now()) {
      if (row) {
        await runtime.db.run("DELETE FROM sessions WHERE token = ?", [hashedToken]);
      }
      return false;
    }
    return true;
  } catch (error) {
    console.info("[Sessions] query failed", error);
    return false;
  }
};

export const consumeRateLimit = async (
  runtime: ServerRuntime,
  action: "auth" | "write",
  key: string,
  limit: number,
  windowMs: number,
) => {
  const now = Date.now();
  const row = await runtime.db.query(`
    INSERT INTO rate_limits (action, key, window_started_at, count, updated_at)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(action, key) DO UPDATE SET
      window_started_at = CASE
        WHEN rate_limits.window_started_at <= ? THEN excluded.window_started_at
        ELSE rate_limits.window_started_at
      END,
      count = CASE
        WHEN rate_limits.window_started_at <= ? THEN 1
        ELSE rate_limits.count + 1
      END,
      updated_at = excluded.updated_at
    RETURNING window_started_at, count
  `).get<{ window_started_at: number; count: number }>(
    action,
    key,
    now,
    now,
    now - windowMs,
    now - windowMs,
  );
  if (!row) throw new Error("Rate limit update did not return a row");
  return {
    allowed: row.count <= limit,
    retryAfter: Math.max(
      0,
      Math.ceil((windowMs - (now - row.window_started_at)) / 1000),
    ),
  };
};

export const verifyPassword = async (input: unknown, expected: string) => {
  if (typeof input !== "string" || input.length > MAX_AUTH_PASSWORD_LENGTH) {
    return false;
  }
  const encoder = new TextEncoder();
  const inputHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(input)),
  );
  const expectedHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  );
  return timingSafeEqual(inputHash, expectedHash) && input === expected;
};
