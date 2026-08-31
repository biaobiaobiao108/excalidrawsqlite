import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  AUTH_COOKIE_DEVELOPMENT,
  AUTH_COOKIE_PRODUCTION,
  AUTH_RATE_WINDOW_MS,
  MAX_AUTH_PASSWORD_LENGTH,
} from "./config";
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
  createHmac("sha256", runtime.config.authPassword).update(token).digest("hex");

export const issueSessionCookie = (runtime: ServerRuntime, req: Request) => {
  const token = randomBytes(32).toString("base64url");
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
          "SELECT token, expires_at FROM sessions WHERE token = ? OR token = ? LIMIT 1",
        )
        .get(hashSessionToken(runtime, token), token) as {
        token: string;
        expires_at: number;
      } | null;
      if (row) {
        expiresAt = row.expires_at;
        runtime.sessions.set(token, expiresAt);
        // Upgrade legacy plaintext rows when they are next used. This keeps
        // existing cookies valid while preventing new bearer tokens from
        // being exposed in SQLite backups.
        if (row.token === token) {
          runtime.db.run("UPDATE sessions SET token = ? WHERE token = ?", [
            hashSessionToken(runtime, token),
            token,
          ]);
        }
      }
    } catch (error) {
      console.error("[Sessions] query failed", error);
    }
  }
  if (!expiresAt || expiresAt <= Date.now()) {
    runtime.sessions.delete(token);
    try {
      runtime.db.run("DELETE FROM sessions WHERE token = ? OR token = ?", [
        hashSessionToken(runtime, token),
        token,
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
  const inputBuffer = Buffer.from(input);
  const expectedBuffer = Buffer.from(expected);
  return (
    inputBuffer.length === expectedBuffer.length &&
    timingSafeEqual(inputBuffer, expectedBuffer)
  );
};
