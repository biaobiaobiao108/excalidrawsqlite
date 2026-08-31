import type { ServerConfig } from "./types";

export const DEFAULT_PORT = 8080;
export const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_SCENE_BODY_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_FILES_BODY_BYTES = 32 * 1024 * 1024;
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTH_COOKIE_PRODUCTION = "__Host-excalidraw_session";
export const AUTH_COOKIE_DEVELOPMENT = "excalidraw_session";
export const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const SCENE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const MIME_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
export const MAX_SCENE_NAME_LENGTH = 120;
export const MAX_FOLDER_NAME_LENGTH = 80;
export const MAX_TAGS = 12;
export const MAX_TAG_LENGTH = 32;
export const MAX_AUTH_PASSWORD_LENGTH = 256;
export const MAX_BATCH_FILES = 64;
export const AUTH_ATTEMPTS_PER_WINDOW = 5;
export const AUTH_RATE_WINDOW_MS = 15 * 60 * 1000;
export const WRITE_REQUESTS_PER_WINDOW = 120;
export const WRITE_RATE_WINDOW_MS = 60 * 1000;
export const ORPHAN_FILE_GRACE_MS = 24 * 60 * 60 * 1000;
export const STALE_FILE_ARTIFACT_MS = 60 * 60 * 1000;
export const SCHEMA_VERSION = 3;

const parseBooleanEnv = (value: string | undefined) =>
  value?.toLowerCase() === "true";

const parsePositiveIntegerEnv = (
  value: string | undefined,
  fallback: number,
) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const splitOrigins = (value: string | undefined) =>
  new Set(
    (value || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

export const createServerConfig = (
  env: Record<string, string | undefined> = process.env,
): ServerConfig => {
  const nodeEnv = env.NODE_ENV || "development";
  const authPassword = env.AUTH_PASSWORD || "";
  const allowAnonymous = parseBooleanEnv(env.ALLOW_ANONYMOUS);

  if (nodeEnv === "production" && !authPassword && !allowAnonymous) {
    throw new Error(
      "AUTH_PASSWORD must be configured in production, or explicitly set ALLOW_ANONYMOUS=true",
    );
  }

  return {
    authPassword,
    allowAnonymous,
    nodeEnv,
    trustProxy: parseBooleanEnv(env.TRUST_PROXY),
    corsOrigins: splitOrigins(env.CORS_ORIGIN),
    maxFileBytes: parsePositiveIntegerEnv(
      env.MAX_FILE_BYTES,
      DEFAULT_MAX_FILE_BYTES,
    ),
    maxSceneBodyBytes: parsePositiveIntegerEnv(
      env.MAX_SCENE_BODY_BYTES,
      DEFAULT_MAX_SCENE_BODY_BYTES,
    ),
    maxFilesBodyBytes: parsePositiveIntegerEnv(
      env.MAX_FILES_BODY_BYTES,
      DEFAULT_MAX_FILES_BODY_BYTES,
    ),
    sessionTtlMs: parsePositiveIntegerEnv(
      env.AUTH_SESSION_TTL_MS,
      DEFAULT_SESSION_TTL_MS,
    ),
  };
};
