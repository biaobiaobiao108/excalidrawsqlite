import {
  AUTH_COOKIE_DEVELOPMENT,
  AUTH_COOKIE_PRODUCTION,
  AUTH_RATE_WINDOW_MS,
  MAX_RATE_LIMIT_KEYS,
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

export const cleanupExpiredSessions = (runtime: ServerRuntime, now: number) => {
  for (const [token, expiresAt] of runtime.sessions) {
    if (expiresAt <= now) {
      runtime.sessions.delete(token);
    }
  }
  try {
    runtime.db.run("DELETE FROM sessions WHERE expires_at <= ?", [now]);
  } catch (error) {
    console.error("[Sessions] cleanup failed", error);
  }
};

export const cleanupExpiredRateLimits = (
  runtime: ServerRuntime,
  now = Date.now(),
) => {
  for (const [key, record] of runtime.authAttempts) {
    if (now - record.startedAt >= AUTH_RATE_WINDOW_MS) {
      runtime.authAttempts.delete(key);
    }
  }
  for (const [key, record] of runtime.writeAttempts) {
    if (now - record.startedAt >= WRITE_RATE_WINDOW_MS) {
      runtime.writeAttempts.delete(key);
    }
  }
};

export const getClientKey = (
  runtime: ServerRuntime,
  req: Request,
  requestAddressResolver?: RequestAddressResolver,
) => {
  if (runtime.config.trustProxy) {
    return (
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"
    );
  }
  return requestAddressResolver?.(req) || "unknown";
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

export const issueSessionCookie = (runtime: ServerRuntime, req: Request) => {
  const token = randomBase64Url(32);
  const expiresAt = Date.now() + runtime.config.sessionTtlMs;
  runtime.sessions.set(token, expiresAt);
  try {
    runtime.db.run(
      "INSERT OR REPLACE INTO sessions (token, expires_at, created_at) VALUES (?, ?, ?)",
      [hashSessionToken(runtime, token), expiresAt, Date.now()],
    );
  } catch (error) {
    console.error("[Sessions] failed to persist session", error);
  }
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

export const isAuthorized = (runtime: ServerRuntime, req: Request) => {
  if (runtime.config.allowAnonymous || !runtime.config.authPassword) {
    return true;
  }
  const token = getSessionToken(runtime, req);
  if (!token) {
    return false;
  }
  let expiresAt = runtime.sessions.get(token);
  if (expiresAt === undefined) {
    try {
      const row = runtime.db
        .query(
          "SELECT expires_at FROM sessions WHERE token = ? LIMIT 1",
        )
        .get(hashSessionToken(runtime, token)) as {
        expires_at: number;
      } | null;
      if (row) {
        expiresAt = row.expires_at;
        runtime.sessions.set(token, expiresAt);
      }
    } catch (error) {
      console.error("[Sessions] query failed", error);
    }
  }
  if (!expiresAt || expiresAt <= Date.now()) {
    runtime.sessions.delete(token);
    try {
      runtime.db.run("DELETE FROM sessions WHERE token = ?", [
        hashSessionToken(runtime, token),
      ]);
    } catch {
      // ignore
    }
    return false;
  }
  return true;
};

export const consumeRateLimit = (
  bucket: Map<string, { startedAt: number; count: number }>,
  key: string,
  limit: number,
  windowMs: number,
) => {
  const now = Date.now();
  const current = bucket.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    if (!current && bucket.size >= MAX_RATE_LIMIT_KEYS) {
      let oldestKey: string | undefined;
      let oldestStartedAt = Number.POSITIVE_INFINITY;
      for (const [candidateKey, record] of bucket) {
        if (record.startedAt < oldestStartedAt) {
          oldestKey = candidateKey;
          oldestStartedAt = record.startedAt;
        }
      }
      if (oldestKey !== undefined) {
        bucket.delete(oldestKey);
      }
    }
    bucket.set(key, { startedAt: now, count: 1 });
    return { allowed: true, retryAfter: 0 };
  }
  current.count += 1;
  return {
    allowed: current.count <= limit,
    retryAfter: Math.ceil((windowMs - (now - current.startedAt)) / 1000),
  };
};

export const verifyPassword = (input: unknown, expected: string) => {
  if (typeof input !== "string" || input.length > MAX_AUTH_PASSWORD_LENGTH) {
    return false;
  }
  const inputBuffer = new TextEncoder().encode(input);
  const expectedBuffer = new TextEncoder().encode(expected);
  return (
    inputBuffer.length === expectedBuffer.length &&
    timingSafeEqual(inputBuffer, expectedBuffer)
  );
};
