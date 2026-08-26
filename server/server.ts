import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_PORT = 8080;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_SCENE_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_FILES_BODY_BYTES = 32 * 1024 * 1024;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AUTH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const AUTH_COOKIE_PRODUCTION = "__Host-excalidraw_session";
const AUTH_COOKIE_DEVELOPMENT = "excalidraw_session";
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SCENE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MIME_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const MAX_SCENE_NAME_LENGTH = 120;
const MAX_AUTH_PASSWORD_LENGTH = 256;
const MAX_BATCH_FILES = 64;
const AUTH_ATTEMPTS_PER_WINDOW = 5;
const AUTH_RATE_WINDOW_MS = 15 * 60 * 1000;
const WRITE_REQUESTS_PER_WINDOW = 120;
const WRITE_RATE_WINDOW_MS = 60 * 1000;
const ORPHAN_FILE_GRACE_MS = 24 * 60 * 60 * 1000;

export type ServerConfig = {
  authPassword: string;
  allowAnonymous: boolean;
  nodeEnv: string;
  corsOrigins: Set<string>;
  maxFileBytes: number;
  maxSceneBodyBytes: number;
  maxFilesBodyBytes: number;
  sessionTtlMs: number;
};

export type ServerRuntime = {
  db: Database;
  filesDir: string;
  staticDir?: string;
  config: ServerConfig;
  sessions: Map<string, number>;
  authAttempts: Map<string, { startedAt: number; count: number }>;
  writeAttempts: Map<string, { startedAt: number; count: number }>;
};

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

const parsePositiveIntegerEnv = (value: string | undefined, fallback: number) => {
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

  db.run(`
    CREATE TABLE IF NOT EXISTS scenes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      elements TEXT NOT NULL,
      app_state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1
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

  db.run(
    "CREATE INDEX IF NOT EXISTS idx_scenes_updated_at ON scenes(updated_at DESC)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_scene_files_file_id ON scene_files(file_id)",
  );

  // Keep scene records usable if a database created by an earlier build is reused.
  ensureColumn(db, "scenes", "revision", "INTEGER NOT NULL DEFAULT 1");
  // The old data_url column, when present, is intentionally left untouched. New
  // writes never use it; this project does not perform an implicit data migration.
  ensureColumn(db, "files", "storage_path", "TEXT");
  ensureColumn(db, "files", "byte_size", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "files", "sha256", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "files", "updated_at", "INTEGER NOT NULL DEFAULT 0");

  db.run("PRAGMA user_version = 1");
};

export const createRuntime = (options: {
  dbPath: string;
  filesDir: string;
  staticDir?: string;
  config?: ServerConfig;
}): ServerRuntime => {
  fs.mkdirSync(path.dirname(path.resolve(options.dbPath)), { recursive: true });
  fs.mkdirSync(path.resolve(options.filesDir), { recursive: true });
  const db = new Database(options.dbPath, { create: true });
  initializeDatabase(db);

  return {
    db,
    filesDir: path.resolve(options.filesDir),
    staticDir: options.staticDir,
    config: options.config || createServerConfig(),
    sessions: new Map(),
    authAttempts: new Map(),
    writeAttempts: new Map(),
  };
};

const cleanupExpiredSessions = (runtime: ServerRuntime, now: number) => {
  for (const [token, expiresAt] of runtime.sessions) {
    if (expiresAt <= now) {
      runtime.sessions.delete(token);
    }
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

const getClientKey = (req: Request) =>
  req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

const isAllowedOrigin = (runtime: ServerRuntime, req: Request) => {
  const origin = req.headers.get("origin");
  return !origin || runtime.config.corsOrigins.has(origin);
};

const securityHeaders = (runtime: ServerRuntime, req: Request) => {
  const headers = new Headers({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
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
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
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
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });

const errorResponse = (runtime: ServerRuntime, req: Request, error: unknown) => {
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
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "请求必须使用 JSON 格式");
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
    throw new HttpError(400, "INVALID_NAME", "画板名称不能为空且不能超过 120 个字符");
  }
  return name;
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

const getPathId = (pathname: string, prefix: string, kind: "file" | "scene") => {
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

const getSessionCookieName = (runtime: ServerRuntime) =>
  runtime.config.nodeEnv === "production"
    ? AUTH_COOKIE_PRODUCTION
    : AUTH_COOKIE_DEVELOPMENT;

const issueSessionCookie = (runtime: ServerRuntime) => {
  const token = randomBytes(32).toString("base64url");
  runtime.sessions.set(token, Date.now() + runtime.config.sessionTtlMs);
  const secure = runtime.config.nodeEnv === "production" ? "; Secure" : "";
  return `${getSessionCookieName(runtime)}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}${secure}`;
};

const clearSessionCookie = (runtime: ServerRuntime) =>
  `${getSessionCookieName(runtime)}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;

const isAuthorized = (runtime: ServerRuntime, req: Request) => {
  if (runtime.config.allowAnonymous || !runtime.config.authPassword) {
    return true;
  }
  const token = getCookie(req, getSessionCookieName(runtime));
  const expiresAt = runtime.sessions.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    runtime.sessions.delete(token);
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

const writeFileAtomically = async (filePath: string, data: Uint8Array) => {
  const tempPath = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  await Bun.write(tempPath, data);
  try {
    await fs.promises.rename(tempPath, filePath);
  } catch (error: any) {
    // Windows does not replace an existing file with rename(). Keep the same
    // atomic path on POSIX and use a safe replacement fallback on Windows.
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") {
      await fs.promises.rm(tempPath, { force: true });
      throw error;
    }
    await fs.promises.rm(filePath, { force: true });
    await fs.promises.rename(tempPath, filePath);
  }
};

const upsertFile = async (
  runtime: ServerRuntime,
  id: string,
  mimeType: string,
  data: Uint8Array,
  createdAt?: number,
) => {
  if (data.byteLength > runtime.config.maxFileBytes) {
    throw new HttpError(413, "FILE_TOO_LARGE", "单个文件不能超过 4 MiB");
  }
  const filePath = getFilePath(runtime, id);
  const hash = createHash("sha256").update(data).digest("hex");
  const now = Date.now();
  const previous = runtime.db
    .query("SELECT created_at FROM files WHERE id = ?")
    .get(id) as { created_at: number } | null;

  await writeFileAtomically(filePath, data);
  try {
    runtime.db.run(
      `INSERT INTO files (id, storage_path, mime_type, byte_size, sha256, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
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
    if (!previous) {
      await fs.promises.rm(filePath, { force: true });
    }
    throw error;
  }

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
    throw new HttpError(400, "INVALID_FILE_DATA", "文件必须是有效的 Base64 data URL");
  }
  const data = Buffer.from(match[2], "base64");
  if (!data.byteLength) {
    throw new HttpError(400, "INVALID_FILE_DATA", "文件内容不能为空");
  }
  return new Uint8Array(data);
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
      !(await fs.promises.stat(getFilePath(runtime, fileId)).catch(() => null))
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
      revision: Number(row.revision) || 1,
    };
  } catch {
    throw new HttpError(500, "CORRUPT_SCENE", "画板数据损坏");
  }
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

const cleanupOrphanedFiles = async (runtime: ServerRuntime) => {
  const cutoff = Date.now() - ORPHAN_FILE_GRACE_MS;
  const rows = runtime.db
    .query(
      `SELECT id, storage_path FROM files
       WHERE updated_at < ?
         AND NOT EXISTS (SELECT 1 FROM scene_files WHERE scene_files.file_id = files.id)`,
    )
    .all(cutoff) as Array<{ id: string; storage_path: string | null }>;

  for (const row of rows) {
    if (row.storage_path) {
      await fs.promises.rm(getFilePath(runtime, row.id), { force: true });
    }
    runtime.db.run(
      `DELETE FROM files
       WHERE id = ?
         AND NOT EXISTS (SELECT 1 FROM scene_files WHERE scene_files.file_id = files.id)`,
      [row.id],
    );
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

export const createRequestHandler = (runtime: ServerRuntime) => {
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
        runtime.db.query("SELECT 1").get();
        return jsonResponse(runtime, req, { status: "ok" });
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
          getClientKey(req),
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
          return jsonResponse(
            runtime,
            req,
            { success: true },
            200,
            { "Set-Cookie": issueSessionCookie(runtime) },
          );
        }
        return jsonResponse(
          runtime,
          req,
          { error: "密码错误，请重新输入", code: "INVALID_PASSWORD" },
          401,
        );
      }

      if (pathname === "/api/auth/logout" && req.method === "POST") {
        const token = getCookie(req, getSessionCookieName(runtime));
        runtime.sessions.delete(token);
        return response(runtime, req, null, {
          status: 204,
          headers: {
            "Set-Cookie": clearSessionCookie(runtime),
            "Clear-Site-Data": '"cookies"',
          },
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
          getClientKey(req),
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
            "SELECT id, name, created_at, updated_at, revision, length(elements) AS size FROM scenes ORDER BY updated_at DESC",
          )
          .all();
        return jsonResponse(runtime, req, rows);
      }

      if (pathname === "/api/scenes" && req.method === "POST") {
        const body = requireJsonObject(
          await readJson(req, runtime.config.maxSceneBodyBytes),
        );
        const id = body.id
          ? validateId(body.id, "scene")
          : `scene_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
        const name = hasOwn(body, "name")
          ? validateName(body.name)
          : "未命名白板";
        const elements = hasOwn(body, "elements")
          ? validateElements(body.elements)
          : [];
        const appState = hasOwn(body, "appState")
          ? validateAppState(body.appState)
          : {};
        const fileIds = extractFileIds(elements);
        await assertReferencedFilesExist(runtime, fileIds);
        const now = Date.now();
        try {
          const transaction = runtime.db.transaction(() => {
            runtime.db.run(
              `INSERT INTO scenes (id, name, elements, app_state, created_at, updated_at, revision)
               VALUES (?, ?, ?, ?, ?, ?, 1)`,
              [
                id,
                name,
                JSON.stringify(elements),
                JSON.stringify(appState),
                now,
                now,
              ],
            );
            syncSceneFileReferences(runtime, id, fileIds);
          });
          transaction();
        } catch (error: any) {
          if (String(error?.message || "").toLowerCase().includes("unique")) {
            throw new HttpError(409, "SCENE_EXISTS", "画板 ID 已存在");
          }
          throw error;
        }
        return jsonResponse(
          runtime,
          req,
          { id, name, created_at: now, updated_at: now, revision: 1 },
          201,
        );
      }

      if (pathname.startsWith("/api/scenes/") && req.method === "GET") {
        const id = getPathId(pathname, "/api/scenes/", "scene");
        const row = runtime.db.query("SELECT * FROM scenes WHERE id = ?").get(id);
        if (!row) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在");
        }
        return jsonResponse(runtime, req, parseStoredScene(row));
      }

      if (pathname.startsWith("/api/scenes/") && req.method === "PATCH") {
        const id = getPathId(pathname, "/api/scenes/", "scene");
        const body = requireJsonObject(await readJson(req, 64 * 1024));
        if (!hasOwn(body, "name")) {
          throw new HttpError(400, "INVALID_NAME", "缺少画板名称");
        }
        const name = validateName(body.name);
        const baseRevision = requireRevision(body.baseRevision);
        const existing = runtime.db
          .query("SELECT revision FROM scenes WHERE id = ?")
          .get(id) as { revision: number } | null;
        if (!existing) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在");
        }
        if (baseRevision !== undefined && baseRevision !== existing.revision) {
          throw new HttpError(409, "REVISION_CONFLICT", "云端画板已被其他操作更新");
        }
        const now = Date.now();
        const revision = existing.revision + 1;
        runtime.db.run(
          "UPDATE scenes SET name = ?, updated_at = ?, revision = ? WHERE id = ?",
          [name, now, revision, id],
        );
        return jsonResponse(runtime, req, {
          success: true,
          id,
          updated_at: now,
          revision,
        });
      }

      if (pathname.startsWith("/api/scenes/") && req.method === "PUT") {
        const id = getPathId(pathname, "/api/scenes/", "scene");
        const body = requireJsonObject(
          await readJson(req, runtime.config.maxSceneBodyBytes),
        );
        const existing = runtime.db
          .query("SELECT * FROM scenes WHERE id = ?")
          .get(id) as any;
        if (!existing) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在");
        }
        const baseRevision = requireRevision(body.baseRevision);
        const currentRevision = Number(existing.revision) || 1;
        if (baseRevision !== undefined && baseRevision !== currentRevision) {
          throw new HttpError(409, "REVISION_CONFLICT", "云端画板已被其他设备更新");
        }
        const name = hasOwn(body, "name")
          ? validateName(body.name)
          : existing.name;
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
             SET name = ?, elements = ?, app_state = ?, updated_at = ?, revision = ?
             WHERE id = ?`,
            [
              name,
              JSON.stringify(elements),
              JSON.stringify(appState),
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

      if (pathname.startsWith("/api/scenes/") && req.method === "DELETE") {
        const id = getPathId(pathname, "/api/scenes/", "scene");
        const existing = runtime.db.query("SELECT id FROM scenes WHERE id = ?").get(id);
        if (!existing) {
          return jsonResponse(runtime, req, { success: true, id, deleted: false });
        }
        const transaction = runtime.db.transaction(() => {
          runtime.db.run("DELETE FROM scene_files WHERE scene_id = ?", [id]);
          runtime.db.run("DELETE FROM scenes WHERE id = ?", [id]);
        });
        transaction();
        return jsonResponse(runtime, req, { success: true, id, deleted: true });
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
            await upsertFile(runtime, id, mimeType, bytes, Number(data.created)),
          );
        }
        return jsonResponse(runtime, req, { success: true, files: uploaded }, 201);
      }

      if (pathname.startsWith("/api/files/") && req.method === "PUT") {
        const id = getPathId(pathname, "/api/files/", "file");
        const mimeType = validateMimeType(
          req.headers.get("content-type") || "application/octet-stream",
        );
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
        if (!(await fs.promises.stat(filePath).catch(() => null))) {
          throw new HttpError(404, "FILE_NOT_FOUND", "文件不存在");
        }
        const accept = req.headers.get("accept") || "";
        const wantsBinary =
          accept.includes("application/octet-stream") || accept.includes("image/");
        if (!wantsBinary) {
          const bytes = await Bun.file(filePath).arrayBuffer();
          return jsonResponse(runtime, req, {
            id,
            dataURL: `data:${row.mime_type};base64,${Buffer.from(bytes).toString("base64")}`,
            mimeType: row.mime_type,
            created_at: row.created_at,
          });
        }
        return response(runtime, req, Bun.file(filePath), {
          headers: {
            "Content-Type": row.mime_type,
            "Content-Length": String(row.byte_size),
            "X-File-Created-At": String(row.created_at),
            "Cache-Control": "private, max-age=31536000, immutable",
          },
        });
      }

      if (pathname.startsWith("/api/")) {
        throw new HttpError(404, "NOT_FOUND", "接口不存在");
      }

      const staticDir = getStaticDir(runtime);
      const staticPath = buildStaticPath(staticDir, pathname);
      if (
        staticPath &&
        fs.existsSync(staticPath) &&
        fs.statSync(staticPath).isFile()
      ) {
        return response(runtime, req, Bun.file(staticPath));
      }
      const indexPath = path.join(staticDir, "index.html");
      if (fs.existsSync(indexPath)) {
        return response(runtime, req, Bun.file(indexPath), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
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
  const runtime = createRuntime({ dbPath, filesDir });
  const handler = createRequestHandler(runtime);
  const port = Number(process.env.PORT) || DEFAULT_PORT;

  Bun.serve({ port, fetch: handler });
  void cleanupOrphanedFiles(runtime).catch((error) =>
    console.error("[Files] initial cleanup failed", error),
  );
  setInterval(() => {
    void cleanupOrphanedFiles(runtime).catch((error) =>
      console.error("[Files] cleanup failed", error),
    );
  }, 60 * 60 * 1000);

  console.log(`[Database] SQLite initialized at: ${dbPath}`);
  console.log(`[Files] Persistent file directory: ${filesDir}`);
  console.log(`🚀 Excalidraw server is running at http://localhost:${port}`);
};

if (import.meta.main) {
  startServer();
}
