import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Database } from "bun:sqlite";

const DEFAULT_PORT = 8080;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_SCENE_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_FILES_BODY_BYTES = 32 * 1024 * 1024;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AUTH_COOKIE_PRODUCTION = "__Host-excalidraw_session";
const AUTH_COOKIE_DEVELOPMENT = "excalidraw_session";
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SCENE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MIME_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const MAX_SCENE_NAME_LENGTH = 120;
const MAX_FOLDER_NAME_LENGTH = 80;
const MAX_TAGS = 12;
const MAX_TAG_LENGTH = 32;
const MAX_AUTH_PASSWORD_LENGTH = 256;
const MAX_BATCH_FILES = 64;
const AUTH_ATTEMPTS_PER_WINDOW = 5;
const AUTH_RATE_WINDOW_MS = 15 * 60 * 1000;
const WRITE_REQUESTS_PER_WINDOW = 120;
const WRITE_RATE_WINDOW_MS = 60 * 1000;
const ORPHAN_FILE_GRACE_MS = 24 * 60 * 60 * 1000;
const STALE_FILE_ARTIFACT_MS = 60 * 60 * 1000;
const SCHEMA_VERSION = 3;
const thumbnailWriteLocks = new Map<string, Promise<void>>();

export type ServerConfig = {
  authPassword: string;
  allowAnonymous: boolean;
  nodeEnv: string;
  trustProxy: boolean;
  corsOrigins: Set<string>;
  maxFileBytes: number;
  maxSceneBodyBytes: number;
  maxFilesBodyBytes: number;
  sessionTtlMs: number;
};

export type ServerRuntime = {
  db: Database;
  dbPath: string;
  filesDir: string;
  staticDir?: string;
  config: ServerConfig;
  sessions: Map<string, number>;
  authAttempts: Map<string, { startedAt: number; count: number }>;
  writeAttempts: Map<string, { startedAt: number; count: number }>;
};

type RequestAddressResolver = (req: Request) => string | undefined;

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const hasOwn = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

const withThumbnailWriteLock = async <T>(
  thumbnailId: string,
  task: () => Promise<T>,
): Promise<T> => {
  const previous = thumbnailWriteLocks.get(thumbnailId) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  thumbnailWriteLocks.set(thumbnailId, current);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (thumbnailWriteLocks.get(thumbnailId) === current) {
      thumbnailWriteLocks.delete(thumbnailId);
    }
  }
};

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

const ensureColumn = (
  db: Database,
  table: string,
  column: string,
  definition: string,
) => {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (columns.length && !columns.some((item) => item.name === column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
};

export const initializeDatabase = (db: Database) => {
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");
  db.run("PRAGMA busy_timeout = 10000;");
  db.run("PRAGMA synchronous = FULL;");
  db.run("PRAGMA wal_autocheckpoint = 1000;");

  db.run(`
    CREATE TABLE IF NOT EXISTS scenes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      elements TEXT NOT NULL,
      app_state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      tags_json TEXT NOT NULL DEFAULT '[]',
      is_favorite INTEGER NOT NULL DEFAULT 0,
      folder_id TEXT,
      last_opened_at INTEGER,
      thumbnail_file_id TEXT
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      storage_path TEXT,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS scene_files (
      scene_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      PRIMARY KEY (scene_id, file_id),
      FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
    );
  `);

  // Keep scene records usable if a database created by an earlier build is reused.
  ensureColumn(db, "scenes", "revision", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "scenes", "tags_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "scenes", "is_favorite", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "scenes", "folder_id", "TEXT");
  ensureColumn(db, "scenes", "last_opened_at", "INTEGER");
  ensureColumn(db, "scenes", "thumbnail_file_id", "TEXT");
  ensureColumn(db, "scenes", "deleted_at", "INTEGER");
  ensureColumn(db, "files", "storage_path", "TEXT");
  ensureColumn(db, "files", "byte_size", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "files", "sha256", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "files", "updated_at", "INTEGER NOT NULL DEFAULT 0");

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  db.run(
    "CREATE INDEX IF NOT EXISTS idx_scenes_updated_at ON scenes(updated_at DESC)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_scenes_last_opened_at ON scenes(last_opened_at DESC)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_scenes_deleted_at ON scenes(deleted_at)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_scenes_folder_id ON scenes(folder_id)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_scene_files_file_id ON scene_files(file_id)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)",
  );
};

export const createRuntime = (options: {
  dbPath: string;
  filesDir: string;
  staticDir?: string;
  config?: ServerConfig;
}): ServerRuntime => {
  const dbPath = path.resolve(options.dbPath);
  const filesDir = path.resolve(options.filesDir);
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(filesDir, { recursive: true });
    fs.accessSync(path.dirname(dbPath), fs.constants.W_OK);
    fs.accessSync(filesDir, fs.constants.W_OK);
    const db = new Database(dbPath, { create: true });
    initializeDatabase(db);
    migrateLegacyDatabase(db, filesDir);

    return {
      db,
      dbPath,
      filesDir,
      staticDir: options.staticDir
        ? path.resolve(options.staticDir)
        : undefined,
      config: options.config || createServerConfig(),
      sessions: new Map(),
      authAttempts: new Map(),
      writeAttempts: new Map(),
    };
  } catch (error) {
    throw new Error(
      `无法初始化持久化存储（数据库：${dbPath}，文件目录：${filesDir}）`,
      { cause: error },
    );
  }
};

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

export const performDatabaseMaintenance = (runtime: ServerRuntime) => {
  try {
    runtime.db.run("PRAGMA wal_checkpoint(PASSIVE);");
  } catch (error) {
    console.error("[Database] WAL checkpoint failed", error);
  }
};

const getCookie = (req: Request, name: string) => {
  const cookies = req.headers.get("cookie") || "";
  for (const part of cookies.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      return value.join("=");
    }
  }
  return "";
};

const getClientKey = (
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

const getRequestOrigin = (runtime: ServerRuntime, req: Request) => {
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

const isAllowedOrigin = (runtime: ServerRuntime, req: Request) => {
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
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' data: blob: https: wss:",
  "worker-src 'self' blob:",
  "frame-src 'self' https: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = (runtime: ServerRuntime, req: Request) => {
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

const response = (
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

const jsonResponse = (
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

const errorResponse = (
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

const readBody = async (req: Request, maxBytes: number) => {
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

const readJson = async (req: Request, maxBytes: number) => {
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

const validateId = (value: unknown, kind: "file" | "scene") => {
  const pattern = kind === "file" ? FILE_ID_PATTERN : SCENE_ID_PATTERN;
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new HttpError(400, "INVALID_ID", "无效的资源 ID");
  }
  return value;
};

const validateName = (value: unknown) => {
  if (typeof value !== "string") {
    throw new HttpError(400, "INVALID_NAME", "画板名称必须是字符串");
  }
  const name = value.trim();
  if (!name || name.length > MAX_SCENE_NAME_LENGTH) {
    throw new HttpError(
      400,
      "INVALID_NAME",
      "画板名称不能为空且不能超过 120 个字符",
    );
  }
  return name;
};

const validateFolderName = (value: unknown) => {
  if (typeof value !== "string") {
    throw new HttpError(400, "INVALID_FOLDER_NAME", "文件夹名称必须是字符串");
  }
  const name = value.trim();
  if (!name || name.length > MAX_FOLDER_NAME_LENGTH) {
    throw new HttpError(
      400,
      "INVALID_FOLDER_NAME",
      `文件夹名称不能为空且不能超过 ${MAX_FOLDER_NAME_LENGTH} 个字符`,
    );
  }
  return name;
};

const validateTags = (value: unknown) => {
  if (!Array.isArray(value) || value.length > MAX_TAGS) {
    throw new HttpError(
      400,
      "INVALID_TAGS",
      `标签必须是数组且不能超过 ${MAX_TAGS} 个`,
    );
  }
  const tags = [
    ...new Set(
      value.map((tag) => {
        if (typeof tag !== "string") {
          throw new HttpError(400, "INVALID_TAGS", "标签必须是字符串");
        }
        const normalized = tag.trim();
        if (!normalized || normalized.length > MAX_TAG_LENGTH) {
          throw new HttpError(
            400,
            "INVALID_TAGS",
            `标签不能为空且不能超过 ${MAX_TAG_LENGTH} 个字符`,
          );
        }
        return normalized;
      }),
    ),
  ];
  return tags;
};

const validateFavorite = (value: unknown) => {
  if (typeof value !== "boolean") {
    throw new HttpError(400, "INVALID_FAVORITE", "收藏状态必须是布尔值");
  }
  return value;
};

const validateFolderId = (value: unknown) => {
  if (value === null || value === "") {
    return null;
  }
  return validateId(value, "scene");
};

const parseStoredTags = (value: unknown) => {
  try {
    return validateTags(JSON.parse(String(value || "[]")));
  } catch {
    return [];
  }
};

const validateElements = (value: unknown) => {
  if (!Array.isArray(value)) {
    throw new HttpError(400, "INVALID_ELEMENTS", "图元数据必须是数组");
  }
  return value;
};

const validateAppState = (value: unknown) => {
  if (!isRecord(value)) {
    throw new HttpError(400, "INVALID_APP_STATE", "应用状态必须是对象");
  }
  return value;
};

const getPathId = (
  pathname: string,
  prefix: string,
  kind: "file" | "scene",
) => {
  const rawId = pathname.slice(prefix.length);
  if (!rawId || rawId.includes("/")) {
    throw new HttpError(400, "INVALID_ID", "无效的资源 ID");
  }
  let id = "";
  try {
    id = decodeURIComponent(rawId);
  } catch {
    throw new HttpError(400, "INVALID_ID", "无效的资源 ID");
  }
  return validateId(id, kind);
};

const isSecureRequest = (runtime: ServerRuntime, req: Request) => {
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

const getSessionCookieNames = () => [
  AUTH_COOKIE_PRODUCTION,
  AUTH_COOKIE_DEVELOPMENT,
];

const getSessionToken = (runtime: ServerRuntime, req: Request) => {
  for (const name of getSessionCookieNames()) {
    const token = getCookie(req, name);
    if (token) {
      return token;
    }
  }
  return "";
};

const hashSessionToken = (runtime: ServerRuntime, token: string) =>
  createHmac("sha256", runtime.config.authPassword).update(token).digest("hex");

const issueSessionCookie = (runtime: ServerRuntime, req: Request) => {
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

const clearSessionCookies = (runtime: ServerRuntime, req: Request) => {
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

const isAuthorized = (runtime: ServerRuntime, req: Request) => {
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

const consumeRateLimit = (
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

const verifyPassword = (input: unknown, expected: string) => {
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

const isSafeMimeType = (value: unknown) =>
  typeof value === "string" &&
  MIME_TYPE_PATTERN.test(value) &&
  (value.toLowerCase().startsWith("image/") ||
    value.toLowerCase() === "application/octet-stream");

const validateMimeType = (value: unknown) => {
  if (!isSafeMimeType(value)) {
    throw new HttpError(415, "INVALID_MIME_TYPE", "仅支持图片或二进制附件");
  }
  return value as string;
};

const getFilePath = (runtime: ServerRuntime, id: string) => {
  const base = path.resolve(runtime.filesDir);
  const filePath = path.resolve(base, id);
  if (filePath !== base && !filePath.startsWith(`${base}${path.sep}`)) {
    throw new HttpError(400, "INVALID_ID", "无效的文件路径");
  }
  return filePath;
};

const fileExists = (filePath: string) => Bun.file(filePath).exists();

type AtomicFileWrite = {
  restore: () => Promise<void>;
  cleanup: () => Promise<void>;
};

const writeFileAtomically = async (
  filePath: string,
  data: Uint8Array,
): Promise<AtomicFileWrite> => {
  const tempPath = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  const backupPath = `${filePath}.${randomBytes(8).toString("hex")}.bak`;
  const hadExistingFile = await fileExists(filePath);

  try {
    if (hadExistingFile) {
      await fs.promises.copyFile(filePath, backupPath);
    }
    await Bun.write(tempPath, data);

    try {
      await fs.promises.rename(tempPath, filePath);
    } catch (error: any) {
      // Windows does not replace an existing file with rename(). Keep the
      // atomic path on POSIX and use a safe replacement fallback on Windows.
      if (error?.code !== "EEXIST" && error?.code !== "EPERM") {
        throw error;
      }
      await fs.promises.rm(filePath, { force: true });
      try {
        await fs.promises.rename(tempPath, filePath);
      } catch (replacementError) {
        if (hadExistingFile) {
          await fs.promises.copyFile(backupPath, filePath);
        }
        throw replacementError;
      }
    }
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true });
    await fs.promises.rm(backupPath, { force: true });
    throw error;
  }

  return {
    restore: async () => {
      if (hadExistingFile) {
        await fs.promises.copyFile(backupPath, filePath);
      } else {
        await fs.promises.rm(filePath, { force: true });
      }
      await fs.promises.rm(backupPath, { force: true });
    },
    cleanup: () => fs.promises.rm(backupPath, { force: true }),
  };
};

const upsertFile = async (
  runtime: ServerRuntime,
  id: string,
  mimeType: string,
  data: Uint8Array,
  createdAt?: number,
  updatedAt?: number,
) => {
  if (data.byteLength > runtime.config.maxFileBytes) {
    const limit = runtime.config.maxFileBytes / (1024 * 1024);
    const formattedLimit = Number.isInteger(limit)
      ? `${limit} MiB`
      : `${runtime.config.maxFileBytes} 字节`;
    throw new HttpError(
      413,
      "FILE_TOO_LARGE",
      `单个文件不能超过 ${formattedLimit}`,
    );
  }
  const filePath = getFilePath(runtime, id);
  const hash = createHash("sha256").update(data).digest("hex");
  const now = Number.isFinite(updatedAt) ? Number(updatedAt) : Date.now();
  const previous = runtime.db
    .query("SELECT created_at FROM files WHERE id = ?")
    .get(id) as { created_at: number } | null;

  const atomicWrite = await writeFileAtomically(filePath, data);
  try {
    const hasLegacyDataUrl = (
      runtime.db.query("PRAGMA table_info(files)").all() as Array<{
        name: string;
      }>
    ).some((column) => column.name === "data_url");
    const columns = hasLegacyDataUrl
      ? "id, storage_path, data_url, mime_type, byte_size, sha256, created_at, updated_at"
      : "id, storage_path, mime_type, byte_size, sha256, created_at, updated_at";
    const values = hasLegacyDataUrl
      ? "?, ?, '', ?, ?, ?, ?, ?"
      : "?, ?, ?, ?, ?, ?, ?";
    runtime.db.run(
      `INSERT INTO files (${columns})
       VALUES (${values})
       ON CONFLICT(id) DO UPDATE SET
         storage_path = excluded.storage_path,
         mime_type = excluded.mime_type,
         byte_size = excluded.byte_size,
         sha256 = excluded.sha256,
         updated_at = excluded.updated_at`,
      [
        id,
        id,
        mimeType,
        data.byteLength,
        hash,
        previous?.created_at || createdAt || now,
        now,
      ],
    );
  } catch (error) {
    try {
      await atomicWrite.restore();
    } catch (restoreError) {
      console.error("[Files] Failed to roll back file after database error", {
        filePath,
        error: restoreError,
      });
      throw new Error("文件写入回滚失败", { cause: restoreError });
    }
    throw error;
  }

  await atomicWrite.cleanup().catch((error) => {
    console.error("[Files] Failed to remove temporary backup", {
      filePath,
      error,
    });
  });

  return {
    id,
    mimeType,
    byteSize: data.byteLength,
    createdAt: previous?.created_at || createdAt || now,
    updatedAt: now,
  };
};

const decodeDataUrl = (value: unknown, expectedMimeType: string) => {
  if (typeof value !== "string") {
    throw new HttpError(400, "INVALID_FILE_DATA", "文件数据格式无效");
  }
  const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=_-]+)$/);
  if (!match || match[1].toLowerCase() !== expectedMimeType.toLowerCase()) {
    throw new HttpError(
      400,
      "INVALID_FILE_DATA",
      "文件必须是有效的 Base64 data URL",
    );
  }
  const data = Buffer.from(match[2], "base64");
  if (!data.byteLength) {
    throw new HttpError(400, "INVALID_FILE_DATA", "文件内容不能为空");
  }
  return new Uint8Array(data);
};

const migrateLegacyDatabase = (db: Database, filesDir: string) => {
  const versionRow = db.query("PRAGMA user_version").get() as {
    user_version?: number;
  } | null;
  const version = Number(versionRow?.user_version) || 0;
  const fileColumns = db.query("PRAGMA table_info(files)").all() as Array<{
    name: string;
  }>;
  const hasLegacyDataUrl = fileColumns.some(
    (column) => column.name === "data_url",
  );

  if (version >= SCHEMA_VERSION && !hasLegacyDataUrl) {
    return;
  }
  if (!hasLegacyDataUrl && version === 0) {
    db.run(
      "UPDATE scenes SET last_opened_at = COALESCE(last_opened_at, updated_at)",
    );
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return;
  }

  let migratedFiles = 0;
  let invalidFiles = 0;
  if (hasLegacyDataUrl) {
    const legacyRows = db
      .query(
        `SELECT id, data_url, mime_type, created_at, storage_path
         FROM files
         WHERE data_url IS NOT NULL AND data_url <> ''`,
      )
      .all() as Array<{
      id: string;
      data_url: string;
      mime_type: string;
      created_at: number;
      storage_path: string | null;
    }>;

    for (const row of legacyRows) {
      try {
        const id = validateId(row.id, "file");
        const bytes = decodeDataUrl(row.data_url, row.mime_type);
        const filePath = path.resolve(filesDir, id);
        const tempPath = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
        try {
          fs.writeFileSync(tempPath, bytes);
          try {
            fs.renameSync(tempPath, filePath);
          } catch (error: any) {
            if (error?.code !== "EEXIST" && error?.code !== "EPERM") {
              throw error;
            }
            fs.rmSync(filePath, { force: true });
            fs.renameSync(tempPath, filePath);
          }
        } finally {
          fs.rmSync(tempPath, { force: true });
        }
        const hash = createHash("sha256").update(bytes).digest("hex");
        const now = Date.now();
        db.run(
          `UPDATE files
           SET storage_path = ?, byte_size = ?, sha256 = ?, updated_at = ?
           WHERE id = ?`,
          [id, bytes.byteLength, hash, now, id],
        );
        db.run("UPDATE files SET data_url = '' WHERE id = ?", [id]);
        migratedFiles += 1;
      } catch (error) {
        invalidFiles += 1;
        console.warn("[Migration] 无法迁移旧图片附件", {
          id: row.id,
          error: error instanceof Error ? error.message : error,
        });
      }
    }
  }

  db.run("DELETE FROM scene_files");
  const scenes = db.query("SELECT id, elements FROM scenes").all() as Array<{
    id: string;
    elements: string;
  }>;
  let references = 0;
  for (const scene of scenes) {
    try {
      const elements = JSON.parse(scene.elements || "[]");
      for (const fileId of extractFileIds(elements)) {
        const exists = db.query("SELECT 1 FROM files WHERE id = ?").get(fileId);
        if (!exists) {
          console.warn("[Migration] 场景引用的图片记录不存在", {
            sceneId: scene.id,
            fileId,
          });
          continue;
        }
        db.run(
          "INSERT OR IGNORE INTO scene_files (scene_id, file_id) VALUES (?, ?)",
          [scene.id, fileId],
        );
        references += 1;
      }
    } catch (error) {
      console.warn("[Migration] 无法重建场景图片引用", {
        sceneId: scene.id,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  db.run(
    "UPDATE scenes SET last_opened_at = COALESCE(last_opened_at, updated_at)",
  );
  db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  console.info("[Migration] 数据库迁移完成", {
    fromVersion: version,
    toVersion: SCHEMA_VERSION,
    migratedFiles,
    invalidFiles,
    scenes: scenes.length,
    references,
    filesDir,
  });
};

const extractFileIds = (elements: unknown[]) => {
  const ids = new Set<string>();
  for (const element of elements) {
    if (
      isRecord(element) &&
      element.type === "image" &&
      element.isDeleted !== true &&
      typeof element.fileId === "string"
    ) {
      ids.add(validateId(element.fileId, "file"));
    }
  }
  return [...ids];
};

const assertReferencedFilesExist = async (
  runtime: ServerRuntime,
  fileIds: string[],
) => {
  for (const fileId of fileIds) {
    const row = runtime.db
      .query("SELECT storage_path FROM files WHERE id = ?")
      .get(fileId) as { storage_path: string | null } | null;
    if (
      !row?.storage_path ||
      !(await fileExists(getFilePath(runtime, fileId)))
    ) {
      throw new HttpError(422, "MISSING_FILE", "画板引用的图片尚未上传完成");
    }
  }
};

const syncSceneFileReferences = (
  runtime: ServerRuntime,
  sceneId: string,
  fileIds: string[],
) => {
  runtime.db.run("DELETE FROM scene_files WHERE scene_id = ?", [sceneId]);
  for (const fileId of fileIds) {
    runtime.db.run(
      "INSERT INTO scene_files (scene_id, file_id) VALUES (?, ?)",
      [sceneId, fileId],
    );
  }
};

const parseStoredScene = (row: any) => {
  try {
    return {
      id: row.id,
      name: row.name,
      elements: JSON.parse(row.elements || "[]"),
      appState: JSON.parse(row.app_state || "{}"),
      created_at: row.created_at,
      updated_at: row.updated_at,
      tags: parseStoredTags(row.tags_json),
      favorite: Boolean(row.is_favorite),
      folder_id: row.folder_id || null,
      last_opened_at: row.last_opened_at || null,
      thumbnail_file_id: row.thumbnail_file_id || null,
      deleted_at: row.deleted_at || null,
      revision: Number(row.revision) || 1,
    };
  } catch {
    throw new HttpError(500, "CORRUPT_SCENE", "画板数据损坏");
  }
};

const getSceneSummary = (row: any) => ({
  id: row.id,
  name: row.name,
  created_at: row.created_at,
  updated_at: row.updated_at,
  revision: Number(row.revision) || 1,
  size: row.size === undefined ? undefined : Number(row.size),
  tags: parseStoredTags(row.tags_json),
  favorite: Boolean(row.is_favorite),
  folder_id: row.folder_id || null,
  folder_name: row.folder_name || null,
  last_opened_at: row.last_opened_at || null,
  thumbnail_file_id: row.thumbnail_file_id || null,
  deleted_at: row.deleted_at || null,
});

const assertFolderExists = (
  runtime: ServerRuntime,
  folderId: string | null,
) => {
  if (
    folderId &&
    !runtime.db.query("SELECT id FROM folders WHERE id = ?").get(folderId)
  ) {
    throw new HttpError(400, "FOLDER_NOT_FOUND", "文件夹不存在");
  }
};

const parseSceneMetadata = (
  runtime: ServerRuntime,
  body: Record<string, unknown>,
  existing?: any,
) => {
  const name = hasOwn(body, "name")
    ? validateName(body.name)
    : existing?.name || "未命名白板";
  const tags = hasOwn(body, "tags")
    ? validateTags(body.tags)
    : parseStoredTags(existing?.tags_json);
  const favorite = hasOwn(body, "favorite")
    ? validateFavorite(body.favorite)
    : Boolean(existing?.is_favorite);
  const folderId = hasOwn(body, "folder_id")
    ? validateFolderId(body.folder_id)
    : existing?.folder_id || null;
  assertFolderExists(runtime, folderId);
  return { name, tags, favorite, folderId };
};

const buildStaticPath = (staticDir: string, pathname: string) => {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const normalized = decoded === "/" ? "/index.html" : decoded;
  const base = path.resolve(staticDir);
  const candidate = path.resolve(base, `.${normalized}`);
  if (candidate !== base && !candidate.startsWith(`${base}${path.sep}`)) {
    return null;
  }
  return candidate;
};

const getStaticDir = (runtime: ServerRuntime) => {
  if (runtime.staticDir) {
    return path.resolve(runtime.staticDir);
  }
  const candidates = [
    path.resolve("./excalidraw-app/build"),
    path.resolve("./excalidraw-app/dist"),
    path.resolve("./dist"),
    path.resolve("./build"),
  ];
  return (
    candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0]
  );
};

const getStaticCacheControl = (pathname: string) => {
  if (
    pathname === "/" ||
    pathname.endsWith("/index.html") ||
    pathname === "/sw.js" ||
    pathname === "/service-worker.js" ||
    pathname === "/manifest.webmanifest"
  ) {
    return "no-cache";
  }
  if (pathname.startsWith("/assets/") || pathname.startsWith("/fonts/")) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
};

const cleanupOrphanedFiles = async (runtime: ServerRuntime) => {
  const cutoff = Date.now() - ORPHAN_FILE_GRACE_MS;
  const rows = runtime.db
    .query(
      `SELECT id, storage_path FROM files
       WHERE updated_at < ?
         AND NOT EXISTS (SELECT 1 FROM scene_files WHERE scene_files.file_id = files.id)
         AND NOT EXISTS (SELECT 1 FROM scenes WHERE scenes.thumbnail_file_id = files.id)`,
    )
    .all(cutoff) as Array<{ id: string; storage_path: string | null }>;

  for (const row of rows) {
    if (row.storage_path) {
      await fs.promises.rm(getFilePath(runtime, row.id), { force: true });
    }
    runtime.db.run(
      `DELETE FROM files
       WHERE id = ?
         AND NOT EXISTS (SELECT 1 FROM scene_files WHERE scene_files.file_id = files.id)
         AND NOT EXISTS (SELECT 1 FROM scenes WHERE scenes.thumbnail_file_id = files.id)`,
      [row.id],
    );
  }
};

export const cleanupStaleFileArtifacts = async (runtime: ServerRuntime) => {
  const cutoff = Date.now() - STALE_FILE_ARTIFACT_MS;
  const entries = await fs.promises.readdir(runtime.filesDir, {
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(?:tmp|bak)$/.test(entry.name)) {
      continue;
    }
    const filePath = path.join(runtime.filesDir, entry.name);
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) {
      await fs.promises.rm(filePath, { force: true });
      console.info("[Files] 清理过期临时附件", { filePath });
    }
  }
};

export const inspectStorageConsistency = async (runtime: ServerRuntime) => {
  const rows = runtime.db
    .query("SELECT id, storage_path FROM files")
    .all() as Array<{ id: string; storage_path: string | null }>;
  const missingFiles: string[] = [];
  const knownFileIds = new Set<string>();
  for (const row of rows) {
    knownFileIds.add(row.id);
    if (
      row.storage_path &&
      !(await fileExists(getFilePath(runtime, row.id)))
    ) {
      missingFiles.push(row.id);
    }
  }
  const untrackedFiles: string[] = [];
  for (const entry of await fs.promises.readdir(runtime.filesDir, {
    withFileTypes: true,
  })) {
    if (
      entry.isFile() &&
      FILE_ID_PATTERN.test(entry.name) &&
      !knownFileIds.has(entry.name)
    ) {
      untrackedFiles.push(entry.name);
    }
  }
  const orphanedReferences = (
    runtime.db
      .query(
        `SELECT COUNT(*) AS count FROM scene_files
         LEFT JOIN files ON files.id = scene_files.file_id
         WHERE files.id IS NULL`,
      )
      .get() as { count: number }
  ).count;
  return { missingFiles, untrackedFiles, orphanedReferences };
};

const createDatabaseSnapshot = async (
  runtime: ServerRuntime,
  timestamp: string,
) => {
  const tempBackupFile = path.join(
    path.dirname(runtime.dbPath),
    `excalidraw-backup-${timestamp}-${randomBytes(4).toString("hex")}.db`,
  );
  const escapedPath = tempBackupFile.replace(/'/g, "''");
  runtime.db.run(`VACUUM INTO '${escapedPath}'`);
  return {
    tempBackupFile,
    cleanup: () => fs.promises.rm(tempBackupFile, { force: true }),
  };
};

const createFullBackup = async (runtime: ServerRuntime, timestamp: string) => {
  const snapshot = await createDatabaseSnapshot(runtime, timestamp);
  try {
    const fileRows = runtime.db
      .query(
        `SELECT id, storage_path, mime_type, byte_size, sha256, created_at, updated_at
         FROM files ORDER BY id`,
      )
      .all() as Array<{
      id: string;
      storage_path: string | null;
      mime_type: string;
      byte_size: number;
      sha256: string;
      created_at: number;
      updated_at: number;
    }>;
    const entries: Record<string, string | Blob> = {
      // Bun.Archive does not eagerly consume Bun.file() in all Bun versions.
      // Materialize the snapshot so the archive cannot contain zero-byte entries.
      "excalidraw.db": new Blob([
        await Bun.file(snapshot.tempBackupFile).arrayBuffer(),
      ]),
      "manifest.json": JSON.stringify(
        {
          format: "excalidraw-full-backup",
          version: 1,
          createdAt: new Date().toISOString(),
          database: "excalidraw.db",
          filesDirectory: "files",
          files: fileRows.map(({ id, storage_path, ...metadata }) => ({
            id,
            path: storage_path ? `files/${id}` : null,
            ...metadata,
          })),
        },
        null,
        2,
      ),
    };

    for (const row of fileRows) {
      if (!row.storage_path) {
        continue;
      }
      const filePath = getFilePath(runtime, row.id);
      if (!(await fileExists(filePath))) {
        throw new Error(`附件文件缺失：${row.id}`);
      }
      entries[`files/${row.id}`] = new Blob([
        await Bun.file(filePath).arrayBuffer(),
      ]);
    }

    const archive = new Bun.Archive(entries);
    return await archive.blob();
  } finally {
    await snapshot.cleanup().catch(() => {});
  }
};

const requireJsonObject = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new HttpError(400, "INVALID_BODY", "请求体必须是对象");
  }
  return value;
};

const requireRevision = (value: unknown) => {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new HttpError(400, "INVALID_REVISION", "revision 必须是正整数");
  }
  return value as number;
};

const parseFileUploadEntries = (body: Record<string, unknown>) => {
  if (hasOwn(body, "id") || hasOwn(body, "dataURL")) {
    if (typeof body.id !== "string") {
      throw new HttpError(400, "INVALID_ID", "无效的文件 ID");
    }
    return [[body.id, body]] as Array<[string, unknown]>;
  }
  const entries = Object.entries(body);
  if (entries.length > MAX_BATCH_FILES) {
    throw new HttpError(413, "TOO_MANY_FILES", "单次上传的文件数量过多");
  }
  return entries;
};

export const createRequestHandler = (
  runtime: ServerRuntime,
  requestAddressResolver?: RequestAddressResolver,
) => {
  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const corsAllowed = isAllowedOrigin(runtime, req);

    if (req.method === "OPTIONS") {
      if (!corsAllowed) {
        return errorResponse(
          runtime,
          req,
          new HttpError(403, "CORS_FORBIDDEN", "不允许的跨域来源"),
        );
      }
      const headers = new Headers({
        "Access-Control-Allow-Methods":
          "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept",
        "Access-Control-Max-Age": "600",
      });
      const origin = req.headers.get("origin");
      if (origin && runtime.config.corsOrigins.has(origin)) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Access-Control-Allow-Credentials", "true");
        headers.set("Vary", "Origin");
      }
      return response(runtime, req, null, { status: 204, headers });
    }

    if (!corsAllowed) {
      return errorResponse(
        runtime,
        req,
        new HttpError(403, "CORS_FORBIDDEN", "不允许的跨域来源"),
      );
    }

    try {
      if (pathname === "/api/health" && req.method === "GET") {
        try {
          runtime.db.query("SELECT 1").get();
          fs.accessSync(path.dirname(runtime.dbPath), fs.constants.W_OK);
          fs.accessSync(runtime.filesDir, fs.constants.W_OK);
          // Keep health checks O(1). Full attachment consistency scans run in
          // the maintenance loop and are intentionally not exposed publicly.
          return jsonResponse(runtime, req, { status: "ok" });
        } catch {
          throw new HttpError(503, "STORAGE_UNAVAILABLE", "持久化存储不可用");
        }
      }

      if (pathname === "/api/backup/full" && req.method === "GET") {
        if (!isAuthorized(runtime, req)) {
          return jsonResponse(
            runtime,
            req,
            { error: "请先完成访问授权", code: "AUTH_REQUIRED" },
            401,
          );
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        try {
          const archive = await createFullBackup(runtime, timestamp);
          return response(runtime, req, archive, {
            headers: {
              "Content-Type": "application/x-tar",
              "Content-Disposition": `attachment; filename="excalidraw-full-backup-${timestamp}.tar"`,
              "Cache-Control": "no-store",
            },
          });
        } catch (error: any) {
          throw new HttpError(
            500,
            "BACKUP_FAILED",
            `创建完整备份失败: ${error?.message || "未知错误"}`,
          );
        }
      }

      if (pathname === "/api/backup/snapshot" && req.method === "GET") {
        if (!isAuthorized(runtime, req)) {
          return jsonResponse(
            runtime,
            req,
            { error: "请先完成访问授权", code: "AUTH_REQUIRED" },
            401,
          );
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        try {
          const snapshot = await createDatabaseSnapshot(runtime, timestamp);
          try {
            const backupBytes = await Bun.file(
              snapshot.tempBackupFile,
            ).arrayBuffer();
            return response(runtime, req, backupBytes, {
              headers: {
                "Content-Type": "application/x-sqlite3",
                "Content-Disposition": `attachment; filename="excalidraw-backup-${timestamp}.db"`,
                "Cache-Control": "no-store",
              },
            });
          } finally {
            await snapshot.cleanup().catch(() => {});
          }
        } catch (error: any) {
          throw new HttpError(
            500,
            "BACKUP_FAILED",
            `创建数据库热备失败: ${error?.message || "未知错误"}`,
          );
        }
      }

      if (pathname === "/api/auth/status" && req.method === "GET") {
        cleanupExpiredSessions(runtime, Date.now());
        return jsonResponse(runtime, req, {
          authRequired:
            Boolean(runtime.config.authPassword) &&
            !runtime.config.allowAnonymous,
          authenticated: isAuthorized(runtime, req),
        });
      }

      if (pathname === "/api/auth/verify" && req.method === "POST") {
        const rate = consumeRateLimit(
          runtime.authAttempts,
          getClientKey(runtime, req, requestAddressResolver),
          AUTH_ATTEMPTS_PER_WINDOW,
          AUTH_RATE_WINDOW_MS,
        );
        if (!rate.allowed) {
          return jsonResponse(
            runtime,
            req,
            { error: "认证尝试次数过多，请稍后再试", code: "RATE_LIMITED" },
            429,
            { "Retry-After": String(rate.retryAfter) },
          );
        }
        const body = requireJsonObject(await readJson(req, 64 * 1024));
        const password = body.password;
        if (
          runtime.config.allowAnonymous ||
          !runtime.config.authPassword ||
          verifyPassword(password, runtime.config.authPassword)
        ) {
          return jsonResponse(runtime, req, { success: true }, 200, {
            "Set-Cookie": issueSessionCookie(runtime, req),
          });
        }
        return jsonResponse(
          runtime,
          req,
          { error: "密码错误，请重新输入", code: "INVALID_PASSWORD" },
          401,
        );
      }

      if (pathname === "/api/auth/logout" && req.method === "POST") {
        const token = getSessionToken(runtime, req);
        if (token) {
          runtime.sessions.delete(token);
          try {
            runtime.db.run(
              "DELETE FROM sessions WHERE token = ? OR token = ?",
              [hashSessionToken(runtime, token), token],
            );
          } catch {
            // ignore
          }
        }
        const headers = new Headers({
          "Clear-Site-Data": '"cookies"',
        });
        for (const cookie of clearSessionCookies(runtime, req)) {
          headers.append("Set-Cookie", cookie);
        }
        return response(runtime, req, null, {
          status: 204,
          headers,
        });
      }

      if (pathname.startsWith("/api/") && !isAuthorized(runtime, req)) {
        return jsonResponse(
          runtime,
          req,
          { error: "请先完成访问授权", code: "AUTH_REQUIRED" },
          401,
        );
      }

      if (
        pathname.startsWith("/api/") &&
        ["POST", "PUT", "PATCH", "DELETE"].includes(req.method)
      ) {
        const rate = consumeRateLimit(
          runtime.writeAttempts,
          getClientKey(runtime, req, requestAddressResolver),
          WRITE_REQUESTS_PER_WINDOW,
          WRITE_RATE_WINDOW_MS,
        );
        if (!rate.allowed) {
          return jsonResponse(
            runtime,
            req,
            { error: "请求过于频繁，请稍后再试", code: "RATE_LIMITED" },
            429,
            { "Retry-After": String(rate.retryAfter) },
          );
        }
      }

      if (pathname === "/api/scenes" && req.method === "GET") {
        const rows = runtime.db
          .query(
            `SELECT scenes.id, scenes.name, scenes.created_at, scenes.updated_at,
                    scenes.revision, length(scenes.elements) AS size,
                    scenes.tags_json, scenes.is_favorite, scenes.folder_id,
                    scenes.last_opened_at, scenes.thumbnail_file_id, scenes.deleted_at,
                    folders.name AS folder_name
             FROM scenes
             LEFT JOIN folders ON folders.id = scenes.folder_id
             WHERE scenes.deleted_at IS NULL
             ORDER BY scenes.updated_at DESC`,
          )
          .all()
          .map(getSceneSummary);
        return jsonResponse(runtime, req, rows);
      }

      if (pathname === "/api/scenes/trash" && req.method === "GET") {
        const rows = runtime.db
          .query(
            `SELECT scenes.id, scenes.name, scenes.created_at, scenes.updated_at,
                    scenes.revision, length(scenes.elements) AS size,
                    scenes.tags_json, scenes.is_favorite, scenes.folder_id,
                    scenes.last_opened_at, scenes.thumbnail_file_id, scenes.deleted_at,
                    folders.name AS folder_name
             FROM scenes
             LEFT JOIN folders ON folders.id = scenes.folder_id
             WHERE scenes.deleted_at IS NOT NULL
             ORDER BY scenes.deleted_at DESC`,
          )
          .all()
          .map(getSceneSummary);
        return jsonResponse(runtime, req, rows);
      }

      if (pathname === "/api/scenes" && req.method === "POST") {
        const body = requireJsonObject(
          await readJson(req, runtime.config.maxSceneBodyBytes),
        );
        const id = body.id
          ? validateId(body.id, "scene")
          : `scene_${Date.now().toString(36)}_${randomBytes(4).toString(
              "hex",
            )}`;
        const name = hasOwn(body, "name")
          ? validateName(body.name)
          : "未命名白板";
        const elements = hasOwn(body, "elements")
          ? validateElements(body.elements)
          : [];
        const appState = hasOwn(body, "appState")
          ? validateAppState(body.appState)
          : {};
        const { tags, favorite, folderId } = parseSceneMetadata(runtime, body);
        const fileIds = extractFileIds(elements);
        await assertReferencedFilesExist(runtime, fileIds);
        const now = Date.now();
        try {
          const transaction = runtime.db.transaction(() => {
            runtime.db.run(
              `INSERT INTO scenes
               (id, name, elements, app_state, created_at, updated_at, revision,
                tags_json, is_favorite, folder_id)
               VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
              [
                id,
                name,
                JSON.stringify(elements),
                JSON.stringify(appState),
                now,
                now,
                JSON.stringify(tags),
                favorite ? 1 : 0,
                folderId,
              ],
            );
            syncSceneFileReferences(runtime, id, fileIds);
          });
          transaction();
        } catch (error: any) {
          if (
            String(error?.message || "")
              .toLowerCase()
              .includes("unique")
          ) {
            throw new HttpError(409, "SCENE_EXISTS", "画板 ID 已存在");
          }
          throw error;
        }
        return jsonResponse(
          runtime,
          req,
          getSceneSummary({
            id,
            name,
            created_at: now,
            updated_at: now,
            revision: 1,
            size: JSON.stringify(elements).length,
            tags_json: JSON.stringify(tags),
            is_favorite: favorite ? 1 : 0,
            folder_id: folderId,
            last_opened_at: null,
            thumbnail_file_id: null,
          }),
          201,
        );
      }

      if (
        pathname.startsWith("/api/folders") &&
        pathname === "/api/folders" &&
        req.method === "GET"
      ) {
        const folders = runtime.db
          .query(
            `SELECT folders.id, folders.name, folders.created_at, folders.updated_at,
                    COUNT(scenes.id) AS scene_count
             FROM folders
             LEFT JOIN scenes ON scenes.folder_id = folders.id
             GROUP BY folders.id
             ORDER BY folders.name COLLATE NOCASE ASC`,
          )
          .all();
        return jsonResponse(runtime, req, folders);
      }

      if (pathname === "/api/folders" && req.method === "POST") {
        const body = requireJsonObject(await readJson(req, 64 * 1024));
        const name = validateFolderName(body.name);
        const id = `folder_${Date.now().toString(36)}_${randomBytes(4).toString(
          "hex",
        )}`;
        const now = Date.now();
        try {
          runtime.db.run(
            "INSERT INTO folders (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
            [id, name, now, now],
          );
        } catch (error: any) {
          if (
            String(error?.message || "")
              .toLowerCase()
              .includes("unique")
          ) {
            throw new HttpError(409, "FOLDER_EXISTS", "文件夹 ID 已存在");
          }
          throw error;
        }
        return jsonResponse(
          runtime,
          req,
          { id, name, created_at: now, updated_at: now, scene_count: 0 },
          201,
        );
      }

      if (pathname.startsWith("/api/folders/") && req.method === "PATCH") {
        const id = getPathId(pathname, "/api/folders/", "scene");
        const body = requireJsonObject(await readJson(req, 64 * 1024));
        const name = validateFolderName(body.name);
        const existing = runtime.db
          .query("SELECT id FROM folders WHERE id = ?")
          .get(id);
        if (!existing) {
          throw new HttpError(404, "FOLDER_NOT_FOUND", "文件夹不存在");
        }
        const now = Date.now();
        runtime.db.run(
          "UPDATE folders SET name = ?, updated_at = ? WHERE id = ?",
          [name, now, id],
        );
        return jsonResponse(runtime, req, {
          success: true,
          id,
          name,
          updated_at: now,
        });
      }

      if (pathname.startsWith("/api/folders/") && req.method === "DELETE") {
        const id = getPathId(pathname, "/api/folders/", "scene");
        const existing = runtime.db
          .query("SELECT id FROM folders WHERE id = ?")
          .get(id);
        if (!existing) {
          return jsonResponse(runtime, req, {
            success: true,
            id,
            deleted: false,
          });
        }
        const transaction = runtime.db.transaction(() => {
          runtime.db.run(
            "UPDATE scenes SET folder_id = NULL WHERE folder_id = ?",
            [id],
          );
          runtime.db.run("DELETE FROM folders WHERE id = ?", [id]);
        });
        transaction();
        return jsonResponse(runtime, req, { success: true, id, deleted: true });
      }

      if (
        pathname.startsWith("/api/scenes/") &&
        pathname.endsWith("/restore") &&
        req.method === "POST"
      ) {
        const id = getPathId(
          pathname.slice(0, -"/restore".length),
          "/api/scenes/",
          "scene",
        );
        const existing = runtime.db
          .query("SELECT id, deleted_at FROM scenes WHERE id = ?")
          .get(id) as { id: string; deleted_at: number | null } | null;
        if (!existing) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在");
        }
        runtime.db.run("UPDATE scenes SET deleted_at = NULL WHERE id = ?", [
          id,
        ]);
        return jsonResponse(runtime, req, {
          success: true,
          id,
          restored: true,
        });
      }

      if (pathname.startsWith("/api/scenes/") && req.method === "GET") {
        const id = getPathId(pathname, "/api/scenes/", "scene");
        const row = runtime.db
          .query("SELECT * FROM scenes WHERE id = ? AND deleted_at IS NULL")
          .get(id);
        if (!row) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在或已删除");
        }
        return jsonResponse(runtime, req, parseStoredScene(row));
      }

      if (
        pathname.startsWith("/api/scenes/") &&
        pathname.endsWith("/open") &&
        req.method === "POST"
      ) {
        const id = getPathId(
          pathname.slice(0, -"/open".length),
          "/api/scenes/",
          "scene",
        );
        const existing = runtime.db
          .query("SELECT id FROM scenes WHERE id = ? AND deleted_at IS NULL")
          .get(id);
        if (!existing) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在或已删除");
        }
        const lastOpenedAt = Date.now();
        runtime.db.run("UPDATE scenes SET last_opened_at = ? WHERE id = ?", [
          lastOpenedAt,
          id,
        ]);
        return jsonResponse(runtime, req, { success: true, id, lastOpenedAt });
      }

      if (
        pathname.startsWith("/api/scenes/") &&
        pathname.endsWith("/thumbnail") &&
        req.method === "PUT"
      ) {
        const id = getPathId(
          pathname.slice(0, -"/thumbnail".length),
          "/api/scenes/",
          "scene",
        );
        const existing = runtime.db
          .query("SELECT id FROM scenes WHERE id = ? AND deleted_at IS NULL")
          .get(id);
        if (!existing) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在或已删除");
        }
        const contentType = req.headers.get("content-type")?.toLowerCase();
        if (
          contentType !== "image/png" &&
          contentType !== "image/jpeg" &&
          contentType !== "image/webp"
        ) {
          throw new HttpError(
            415,
            "UNSUPPORTED_THUMBNAIL_TYPE",
            "画板缩略图必须是 PNG、JPEG 或 WebP",
          );
        }
        const bytes = await readBody(req, runtime.config.maxFileBytes);
        if (!bytes.byteLength) {
          throw new HttpError(400, "EMPTY_THUMBNAIL", "画板缩略图不能为空");
        }
        const thumbnailId = `thumbnail_${createHash("sha256")
          .update(id)
          .digest("hex")}`;
        const thumbnailVersionHeader = req.headers.get("x-thumbnail-version");
        const thumbnailVersion = thumbnailVersionHeader
          ? Number(thumbnailVersionHeader)
          : undefined;
        if (
          thumbnailVersion !== undefined &&
          (!Number.isSafeInteger(thumbnailVersion) || thumbnailVersion <= 0)
        ) {
          throw new HttpError(
            400,
            "INVALID_THUMBNAIL_VERSION",
            "画板缩略图版本无效",
          );
        }
        return withThumbnailWriteLock(thumbnailId, async () => {
          const currentThumbnail = runtime.db
            .query("SELECT updated_at FROM files WHERE id = ?")
            .get(thumbnailId) as { updated_at: number } | null;
          if (
            thumbnailVersion !== undefined &&
            currentThumbnail &&
            Number(currentThumbnail.updated_at) >= thumbnailVersion
          ) {
            return jsonResponse(runtime, req, {
              success: true,
              id,
              thumbnail_file_id: thumbnailId,
              stale: true,
            });
          }
          await upsertFile(
            runtime,
            thumbnailId,
            contentType,
            bytes,
            undefined,
            thumbnailVersion,
          );
          runtime.db.run(
            "UPDATE scenes SET thumbnail_file_id = ? WHERE id = ?",
            [thumbnailId, id],
          );
          return jsonResponse(runtime, req, {
            success: true,
            id,
            thumbnail_file_id: thumbnailId,
          });
        });
      }

      if (pathname.startsWith("/api/scenes/") && req.method === "PATCH") {
        const id = getPathId(pathname, "/api/scenes/", "scene");
        const body = requireJsonObject(await readJson(req, 64 * 1024));
        if (
          !["name", "tags", "favorite", "folder_id"].some((key) =>
            hasOwn(body, key),
          )
        ) {
          throw new HttpError(400, "INVALID_METADATA", "没有可更新的画板信息");
        }
        const baseRevision = requireRevision(body.baseRevision);
        const existing = runtime.db
          .query("SELECT * FROM scenes WHERE id = ? AND deleted_at IS NULL")
          .get(id) as { revision: number } | null;
        if (!existing) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在或已删除");
        }
        if (baseRevision !== undefined && baseRevision !== existing.revision) {
          throw new HttpError(
            409,
            "REVISION_CONFLICT",
            "云端画板已被其他操作更新",
          );
        }
        const { name, tags, favorite, folderId } = parseSceneMetadata(
          runtime,
          body,
          existing,
        );
        const now = Date.now();
        const revision = existing.revision + 1;
        runtime.db.run(
          `UPDATE scenes
           SET name = ?, tags_json = ?, is_favorite = ?, folder_id = ?,
               updated_at = ?, revision = ?
           WHERE id = ?`,
          [
            name,
            JSON.stringify(tags),
            favorite ? 1 : 0,
            folderId,
            now,
            revision,
            id,
          ],
        );
        const updated = runtime.db
          .query(
            `SELECT scenes.id, scenes.name, scenes.created_at, scenes.updated_at,
                    scenes.revision, length(scenes.elements) AS size,
                    scenes.tags_json, scenes.is_favorite, scenes.folder_id,
                    scenes.last_opened_at, scenes.thumbnail_file_id, scenes.deleted_at,
                    folders.name AS folder_name
             FROM scenes
             LEFT JOIN folders ON folders.id = scenes.folder_id
             WHERE scenes.id = ?`,
          )
          .get(id);
        return jsonResponse(runtime, req, getSceneSummary(updated));
      }

      if (pathname.startsWith("/api/scenes/") && req.method === "PUT") {
        const id = getPathId(pathname, "/api/scenes/", "scene");
        const body = requireJsonObject(
          await readJson(req, runtime.config.maxSceneBodyBytes),
        );
        const existing = runtime.db
          .query("SELECT * FROM scenes WHERE id = ? AND deleted_at IS NULL")
          .get(id) as any;
        if (!existing) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在或已删除");
        }
        const baseRevision = requireRevision(body.baseRevision);
        const currentRevision = Number(existing.revision) || 1;
        if (baseRevision !== undefined && baseRevision !== currentRevision) {
          throw new HttpError(
            409,
            "REVISION_CONFLICT",
            "云端画板已被其他设备更新",
          );
        }
        const { name, tags, favorite, folderId } = parseSceneMetadata(
          runtime,
          body,
          existing,
        );
        const elements = hasOwn(body, "elements")
          ? validateElements(body.elements)
          : JSON.parse(existing.elements || "[]");
        const appState = hasOwn(body, "appState")
          ? validateAppState(body.appState)
          : JSON.parse(existing.app_state || "{}");
        const fileIds = extractFileIds(elements);
        await assertReferencedFilesExist(runtime, fileIds);
        const now = Date.now();
        const revision = currentRevision + 1;
        const transaction = runtime.db.transaction(() => {
          runtime.db.run(
            `UPDATE scenes
             SET name = ?, elements = ?, app_state = ?, tags_json = ?,
                 is_favorite = ?, folder_id = ?, updated_at = ?, revision = ?
             WHERE id = ?`,
            [
              name,
              JSON.stringify(elements),
              JSON.stringify(appState),
              JSON.stringify(tags),
              favorite ? 1 : 0,
              folderId,
              now,
              revision,
              id,
            ],
          );
          syncSceneFileReferences(runtime, id, fileIds);
        });
        transaction();
        return jsonResponse(runtime, req, {
          success: true,
          id,
          updated_at: now,
          revision,
        });
      }

      if (pathname === "/api/scenes/trash" && req.method === "DELETE") {
        const trashRows = runtime.db
          .query("SELECT id FROM scenes WHERE deleted_at IS NOT NULL")
          .all() as Array<{ id: string }>;
        const ids = trashRows.map((r) => r.id);
        if (ids.length > 0) {
          const transaction = runtime.db.transaction(() => {
            for (const id of ids) {
              runtime.db.run("DELETE FROM scene_files WHERE scene_id = ?", [
                id,
              ]);
              runtime.db.run("DELETE FROM scenes WHERE id = ?", [id]);
            }
          });
          transaction();
        }
        return jsonResponse(runtime, req, {
          success: true,
          deletedCount: ids.length,
        });
      }

      if (pathname.startsWith("/api/scenes/") && req.method === "DELETE") {
        const id = getPathId(pathname, "/api/scenes/", "scene");
        const existing = runtime.db
          .query("SELECT id, deleted_at FROM scenes WHERE id = ?")
          .get(id) as { id: string; deleted_at: number | null } | null;
        if (!existing) {
          return jsonResponse(runtime, req, {
            success: true,
            id,
            deleted: false,
          });
        }
        const isPermanent = url.searchParams.get("permanent") === "true";
        if (isPermanent) {
          const transaction = runtime.db.transaction(() => {
            runtime.db.run("DELETE FROM scene_files WHERE scene_id = ?", [id]);
            runtime.db.run("DELETE FROM scenes WHERE id = ?", [id]);
          });
          transaction();
          return jsonResponse(runtime, req, {
            success: true,
            id,
            deleted: true,
            permanent: true,
          });
        }
        const now = Date.now();
        runtime.db.run("UPDATE scenes SET deleted_at = ? WHERE id = ?", [
          now,
          id,
        ]);
        return jsonResponse(runtime, req, {
          success: true,
          id,
          deleted: true,
          permanent: false,
          deleted_at: now,
        });
      }

      if (pathname === "/api/files" && req.method === "POST") {
        const body = requireJsonObject(
          await readJson(req, runtime.config.maxFilesBodyBytes),
        );
        const uploaded = [];
        for (const [fileId, value] of parseFileUploadEntries(body)) {
          const id = validateId(fileId, "file");
          const data = requireJsonObject(value);
          const mimeType = validateMimeType(data.mimeType || "image/png");
          const bytes = decodeDataUrl(data.dataURL, mimeType);
          uploaded.push(
            await upsertFile(
              runtime,
              id,
              mimeType,
              bytes,
              Number(data.created),
            ),
          );
        }
        return jsonResponse(
          runtime,
          req,
          { success: true, files: uploaded },
          201,
        );
      }

      if (pathname.startsWith("/api/files/") && req.method === "PUT") {
        const id = getPathId(pathname, "/api/files/", "file");
        const contentType = req.headers.get("content-type");
        if (!contentType) {
          throw new HttpError(
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "文件上传必须指定 MIME 类型",
          );
        }
        const mimeType = validateMimeType(contentType);
        const bytes = await readBody(req, runtime.config.maxFileBytes);
        if (!bytes.byteLength) {
          throw new HttpError(400, "EMPTY_FILE", "文件内容不能为空");
        }
        const file = await upsertFile(runtime, id, mimeType, bytes);
        return jsonResponse(runtime, req, { success: true, file }, 201);
      }

      if (pathname.startsWith("/api/files/") && req.method === "GET") {
        const id = getPathId(pathname, "/api/files/", "file");
        const row = runtime.db
          .query("SELECT * FROM files WHERE id = ?")
          .get(id) as any;
        if (!row?.storage_path) {
          throw new HttpError(404, "FILE_NOT_FOUND", "文件不存在");
        }
        const filePath = getFilePath(runtime, id);
        if (!(await fileExists(filePath))) {
          throw new HttpError(404, "FILE_NOT_FOUND", "文件不存在");
        }
        const accept = req.headers.get("accept") || "";
        const wantsBinary =
          accept.includes("application/octet-stream") ||
          accept.includes("image/");
        if (!wantsBinary) {
          const bytes = await Bun.file(filePath).arrayBuffer();
          return jsonResponse(runtime, req, {
            id,
            dataURL: `data:${row.mime_type};base64,${Buffer.from(
              bytes,
            ).toString("base64")}`,
            mimeType: row.mime_type,
            created_at: row.created_at,
          });
        }
        return response(runtime, req, Bun.file(filePath), {
          headers: {
            "Content-Type": row.mime_type,
            "Content-Length": String(row.byte_size),
            "X-File-Created-At": String(row.created_at),
            "Cache-Control": id.startsWith("thumbnail_")
              ? "private, no-cache"
              : "private, max-age=31536000, immutable",
          },
        });
      }

      if (pathname.startsWith("/api/")) {
        throw new HttpError(404, "NOT_FOUND", "接口不存在");
      }

      const staticDir = getStaticDir(runtime);
      const staticPath = buildStaticPath(staticDir, pathname);
      if (!staticPath) {
        throw new HttpError(400, "INVALID_PATH", "无效的资源路径");
      }
      if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
        return response(runtime, req, Bun.file(staticPath), {
          headers: { "Cache-Control": getStaticCacheControl(pathname) },
        });
      }
      const acceptsHtml = (req.headers.get("accept") || "")
        .toLowerCase()
        .includes("text/html");
      if (acceptsHtml) {
        const indexPath = path.join(staticDir, "index.html");
        if (fs.existsSync(indexPath)) {
          return response(runtime, req, Bun.file(indexPath), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-cache",
            },
          });
        }
      }
      if (pathname !== "/") {
        throw new HttpError(404, "STATIC_NOT_FOUND", "资源不存在");
      }
      return response(
        runtime,
        req,
        "Excalidraw Bun Server is running. Please build the frontend first (bun run build).",
        { headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    } catch (error) {
      return errorResponse(runtime, req, error);
    }
  };

  return handler;
};

const startServer = () => {
  const dataDir = path.resolve(process.env.DATA_DIR || "./data");
  const dbPath = path.resolve(
    process.env.DB_PATH || path.join(dataDir, "excalidraw.db"),
  );
  const filesDir = path.resolve(
    process.env.FILES_DIR || path.join(dataDir, "files"),
  );
  const staticDir = process.env.STATIC_DIR
    ? path.resolve(process.env.STATIC_DIR)
    : path.resolve("./excalidraw-app/build");
  const runtime = createRuntime({ dbPath, filesDir, staticDir });
  const serverRef: { current?: ReturnType<typeof Bun.serve> } = {};
  const handler = createRequestHandler(
    runtime,
    (req) => serverRef.current?.requestIP(req)?.address,
  );
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const hostname = process.env.HOST || "0.0.0.0";

  const runMaintenance = () => {
    cleanupExpiredSessions(runtime, Date.now());
    cleanupExpiredRateLimits(runtime, Date.now());
    performDatabaseMaintenance(runtime);
    void cleanupOrphanedFiles(runtime).catch((error) =>
      console.error("[Files] cleanup failed", error),
    );
    void cleanupStaleFileArtifacts(runtime).catch((error) =>
      console.error("[Files] stale artifact cleanup failed", error),
    );
    void inspectStorageConsistency(runtime).then((consistency) => {
      if (
        consistency.missingFiles.length ||
        consistency.untrackedFiles.length ||
        consistency.orphanedReferences
      ) {
        console.warn("[Storage] 一致性检查发现问题", consistency);
      }
    });
  };

  const server = Bun.serve({ hostname, port, fetch: handler });
  serverRef.current = server;
  console.info("[Server] 已启动", {
    address: `http://${hostname}:${server.port}`,
    dbPath,
    filesDir,
    staticDir,
  });
  void cleanupOrphanedFiles(runtime).catch((error) =>
    console.error("[Files] initial cleanup failed", error),
  );
  void cleanupStaleFileArtifacts(runtime).catch((error) =>
    console.error("[Files] initial stale artifact cleanup failed", error),
  );
  void inspectStorageConsistency(runtime).then((consistency) => {
    if (
      consistency.missingFiles.length ||
      consistency.untrackedFiles.length ||
      consistency.orphanedReferences
    ) {
      console.warn(
        "[Storage] initial consistency check found issues",
        consistency,
      );
    }
  });
  setInterval(runMaintenance, 60 * 60 * 1000);

  const handleShutdown = () => {
    process.stdout.write("\n[Server] 正在优雅关闭...\n");
    performDatabaseMaintenance(runtime);
    try {
      runtime.db.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);

  process.stdout.write(`[Database] SQLite initialized at: ${dbPath}\n`);
  process.stdout.write(`[Files] Persistent file directory: ${filesDir}\n`);
  process.stdout.write(
    `🚀 Excalidraw server is running at http://localhost:${port}\n`,
  );
};

if (import.meta.main) {
  startServer();
}
