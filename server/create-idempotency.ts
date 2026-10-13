import type { Database } from "bun:sqlite";
import { sha256Hex } from "./crypto";
import { HttpError } from "./errors";
import type { ServerRuntime } from "./types";

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

export const parseCreateRequest = (body: Record<string, unknown>, payload: unknown) => {
  if (body.idempotencyKey === undefined) return null;
  if (typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim() || body.idempotencyKey.length > 128) {
    throw new HttpError(400, "INVALID_IDEMPOTENCY_KEY", "idempotencyKey 必须为 1–128 字符的非空字符串");
  }
  return {
    keyHash: sha256Hex(body.idempotencyKey),
    payloadHash: sha256Hex(canonicalJson(payload)),
  };
};

const queries = new WeakMap<Database, {
  expired: ReturnType<Database["query"]>;
  find: ReturnType<Database["query"]>;
  count: ReturnType<Database["query"]>;
  insert: ReturnType<Database["query"]>;
}>();
const statements = (db: Database) => {
  let result = queries.get(db);
  if (!result) {
    result = {
      expired: db.query("DELETE FROM scene_create_requests WHERE expires_at <= ?"),
      find: db.query("SELECT payload_sha256, scene_id FROM scene_create_requests WHERE key_sha256 = ?"),
      count: db.query("SELECT COUNT(*) AS count FROM scene_create_requests"),
      insert: db.query("INSERT INTO scene_create_requests (key_sha256, payload_sha256, scene_id, expires_at) VALUES (?, ?, ?, ?)"),
    };
    queries.set(db, result);
  }
  return result;
};

// Call inside the same immediate transaction as board creation.
export const findCreateReplay = (db: Database, request: NonNullable<ReturnType<typeof parseCreateRequest>>, now: number): string | null => {
  const stmts = statements(db);
  stmts.expired.run(now);
  const entry = stmts.find.get(request.keyHash) as { payload_sha256: string; scene_id: string } | null;
  if (entry) {
    if (entry.payload_sha256 !== request.payloadHash) throw new HttpError(409, "IDEMPOTENCY_KEY_CONFLICT", "此 idempotencyKey 已用于不同创建参数；请为新操作使用新 key");
    return entry.scene_id;
  }
  const { count } = stmts.count.get() as { count: number };
  if (count >= MAX_CREATE_REQUESTS) throw new HttpError(503, "IDEMPOTENCY_CAPACITY", "幂等创建记录已满，请等待有效记录过期后重试");
  return null;
};

export const recordCreateRequest = (db: Database, request: NonNullable<ReturnType<typeof parseCreateRequest>>, sceneId: string, now: number) => {
  statements(db).insert.run(request.keyHash, request.payloadHash, sceneId, now + CREATE_REQUEST_TTL_MS);
};
