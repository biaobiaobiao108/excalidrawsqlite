import { sha256Hex } from "./crypto";
import { HttpError } from "./errors";
import type { D1Statement } from "./db";
import type { ServerRuntime } from "./types";
import { getSceneSummary } from "./scenes";

export const CREATE_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_CREATE_REQUESTS = 10_000;

const mcpCreateSessions = new WeakMap<ServerRuntime, Set<string>>();
export const registerMcpCreateSession = (runtime: ServerRuntime, token: string) => {
  let sessions = mcpCreateSessions.get(runtime);
  if (!sessions) { sessions = new Set(); mcpCreateSessions.set(runtime, sessions); }
  if (sessions.size >= 1024 && !sessions.has(token)) throw new HttpError(503, "MCP_SESSION_CAPACITY", "MCP 内部会话已满");
  sessions.add(token);
};
export const unregisterMcpCreateSession = (runtime: ServerRuntime, token: string) => {
  mcpCreateSessions.get(runtime)?.delete(token);
};
export const isMcpCreateSession = (runtime: ServerRuntime, token: string | null) =>
  !!token && !!mcpCreateSessions.get(runtime)?.has(token);
export const getMcpCreateSessionCount = (runtime: ServerRuntime) => mcpCreateSessions.get(runtime)?.size || 0;

// Sorting object keys removes serialization-order differences, while array
// order remains significant. Request body limits bound this transient work.
export const canonicalJson = (value: unknown, depth = 0): string => {
  if (depth > 64) throw new HttpError(400, "INVALID_IDEMPOTENCY_PAYLOAD", "幂等创建参数嵌套超过 64 层");
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

export const parseCreateRequest = async (body: Record<string, unknown>, payload: unknown) => {
  if (body.idempotencyKey === undefined) return null;
  if (typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim() || body.idempotencyKey.length > 128) {
    throw new HttpError(400, "INVALID_IDEMPOTENCY_KEY", "idempotencyKey 必须为 1–128 字符的非空字符串");
  }
  const [keyHash, payloadHash] = await Promise.all([
    sha256Hex(body.idempotencyKey),
    sha256Hex(canonicalJson(payload)),
  ]);
  return { keyHash, payloadHash };
};

export type CreateRequest = NonNullable<Awaited<ReturnType<typeof parseCreateRequest>>>;

const assertPayloadMatches = (entry: { payload_sha256: string }, request: CreateRequest) => {
  if (entry.payload_sha256 !== request.payloadHash) {
    throw new HttpError(409, "IDEMPOTENCY_KEY_CONFLICT", "此 idempotencyKey 已用于不同创建参数；请为新操作使用新 key");
  }
};

export const findCreateReplay = async (runtime: ServerRuntime, request: CreateRequest, now: number): Promise<string | null> => {
  await runtime.db.run("DELETE FROM scene_create_requests WHERE expires_at <= ?", [now]);
  const entry = await runtime.db.query(
    "SELECT payload_sha256, scene_id FROM scene_create_requests WHERE key_sha256 = ?",
  ).get<{ payload_sha256: string; scene_id: string }>(request.keyHash);
  if (entry) {
    assertPayloadMatches(entry, request);
    return entry.scene_id;
  }
  const count = await runtime.db.query("SELECT COUNT(*) AS count FROM scene_create_requests")
    .get<{ count: number }>();
  if ((count?.count || 0) >= MAX_CREATE_REQUESTS) {
    throw new HttpError(503, "IDEMPOTENCY_CAPACITY", "幂等创建记录已满，请等待有效记录过期后重试");
  }
  return null;
};

export const recordCreateRequestStatement = (
  request: CreateRequest,
  sceneId: string,
  now: number,
): D1Statement => ({
  sql: "INSERT INTO scene_create_requests (key_sha256, payload_sha256, scene_id, expires_at) VALUES (?, ?, ?, ?)",
  values: [request.keyHash, request.payloadHash, sceneId, now + CREATE_REQUEST_TTL_MS],
});

/** Read-only MCP preflight before folder-name resolution or random drawing IDs. */
export const lookupMcpCreateReplay = async (
  runtime: ServerRuntime,
  idempotencyKey: string | undefined,
  intent: unknown,
) => {
  const request = await parseCreateRequest({ idempotencyKey }, intent);
  if (!request) return null;
  const record = await runtime.db.query(`SELECT payload_sha256, scene_id FROM scene_create_requests
    WHERE key_sha256 = ? AND expires_at > ?`).get<{ payload_sha256: string; scene_id: string }>(request.keyHash, Date.now());
  if (!record) return null;
  assertPayloadMatches(record, request);
  const row = await runtime.db.query(`SELECT scenes.id, scenes.name, scenes.created_at, scenes.updated_at,
    scenes.revision, scenes.content_bytes AS size, scenes.element_count, scenes.tags_json,
    scenes.is_favorite, scenes.folder_id, scenes.last_opened_at, scenes.thumbnail_file_id,
    scenes.deleted_at, folders.name AS folder_name
    FROM scenes LEFT JOIN folders ON folders.id = scenes.folder_id WHERE scenes.id = ?`)
    .get<Record<string, unknown> & { deleted_at?: number | null }>(record.scene_id);
  if (!row || row.deleted_at != null) {
    throw new HttpError(409, "IDEMPOTENT_BOARD_DELETED", "该幂等创建请求的画板已删除；如需新建请使用新 key");
  }
  return { ...getSceneSummary(row), idempotentReplay: true as const };
};
