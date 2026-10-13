import { afterEach, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServerConfig } from "../../server/config";
import { createRuntime } from "../../server/runtime";
import { createRequestHandler } from "../../server/routes";
import { getMcpCreateSessionCount, lookupMcpCreateReplay, MAX_CREATE_REQUESTS, registerMcpCreateSession, unregisterMcpCreateSession } from "../../server/create-idempotency";
import type { ServerRuntime } from "../../server/types";

const resources: Array<{ runtime: ServerRuntime; directory: string }> = [];
const setup = () => {
  const directory = path.join(os.tmpdir(), `excalidraw-idempotency-${crypto.randomUUID()}`);
  const options = { dbPath: path.join(directory, "database.db"), filesDir: path.join(directory, "files"), config: createServerConfig({ NODE_ENV: "test", ALLOW_ANONYMOUS: "true" }) };
  const entry = { runtime: createRuntime(options), directory };
  resources.push(entry);
  const call = (body: unknown, sessionToken?: string) => createRequestHandler(entry.runtime)(new Request("http://localhost/api/scenes", {
    method: "POST", headers: { "Content-Type": "application/json", ...(sessionToken ? { "X-Mcp-Create-Session": sessionToken } : {}) }, body: JSON.stringify(body),
  }));
  return { entry, options, call };
};
afterEach(async () => {
  for (const { runtime, directory } of resources.splice(0)) {
    runtime.db.close?.();
    await rm(directory, { recursive: true, force: true });
  }
});

describe("persistent create idempotency", () => {
  it("serializes concurrent retries, survives restart and returns the current revision", async () => {
    const { entry, options, call } = setup();
    const responses = await Promise.all(Array.from({ length: 4 }, () => call({ name: "创建一次", idempotencyKey: "retry-key", appState: { b: 2, a: 1 } })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 200, 201]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    const id = bodies[0].id;
    expect(new Set(bodies.map((body) => body.id)).size).toBe(1);
    expect(entry.runtime.db.query("SELECT COUNT(*) AS count FROM scenes").get()).toEqual({ count: 1 });
    entry.runtime.db.run("UPDATE scenes SET revision = 5, element_count = 3 WHERE id = ?", [id]);
    entry.runtime.db.close();
    entry.runtime = createRuntime(options);
    const replay = await call({ idempotencyKey: "retry-key", appState: { a: 1, b: 2 }, name: "创建一次" });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id, revision: 5, element_count: 3, idempotentReplay: true });
    const conflict = await call({ name: "不同参数", idempotencyKey: "retry-key" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
    const row = entry.runtime.db.query("SELECT * FROM scene_create_requests").get() as Record<string, unknown>;
    expect(row.key_sha256).not.toBe("retry-key");
    expect(Object.keys(row).sort()).toEqual(["expires_at", "key_sha256", "payload_sha256", "scene_id"]);
  });

  it("keeps deleted-board tombstones until expiry, then allows a new operation", async () => {
    const { entry, call } = setup();
    const body = { name: "已删除", idempotencyKey: "deleted-key" };
    const { id } = await (await call(body)).json();
    entry.runtime.db.run("UPDATE scenes SET deleted_at = ? WHERE id = ?", [Date.now(), id]);
    expect(await (await call(body)).json()).toMatchObject({ code: "IDEMPOTENT_BOARD_DELETED" });
    entry.runtime.db.run("DELETE FROM scenes WHERE id = ?", [id]);
    expect(await (await call(body)).json()).toMatchObject({ code: "IDEMPOTENT_BOARD_DELETED" });
    entry.runtime.db.run("UPDATE scene_create_requests SET expires_at = 0");
    const fresh = await call(body);
    expect(fresh.status).toBe(201);
    expect((await fresh.json()).id).not.toBe(id);
  });

  it("rolls back failed creation and refuses capacity overflow without evicting active keys", async () => {
    const { entry, call } = setup();
    const body = { id: "retry_fixed", name: "失败重试", idempotencyKey: "failure-key" };
    expect((await call({ id: "retry_fixed" })).status).toBe(201);
    expect((await call(body)).status).toBe(409);
    expect(entry.runtime.db.query("SELECT COUNT(*) AS count FROM scene_create_requests").get()).toEqual({ count: 0 });
    entry.runtime.db.run("DELETE FROM scenes");
    expect((await call(body)).status).toBe(201);
    const insert = entry.runtime.db.query("INSERT INTO scene_create_requests VALUES (?, 'hash', 'absent', ?)");
    entry.runtime.db.transaction(() => {
      for (let index = 1; index < MAX_CREATE_REQUESTS; index++) insert.run(`capacity_${index}`, Date.now() + 60_000);
    }).immediate();
    expect(await (await call({ name: "容量超限", idempotencyKey: "new-key" })).json()).toMatchObject({ code: "IDEMPOTENCY_CAPACITY" });
    expect((await call(body)).status).toBe(200);
    expect(entry.runtime.db.query("SELECT COUNT(*) AS count FROM scenes").get()).toEqual({ count: 1 });
  });

  it("accepts stable MCP intent only from a registered internal session", async () => {
    const { entry, call } = setup();
    const body = { idempotencyKey: "mcp-intent", idempotencyPayload: { tool: "create_board", name: "原始请求" }, elements: [{ id: "random_first", type: "rectangle" }] };
    expect(await (await call(body)).json()).toMatchObject({ code: "INVALID_IDEMPOTENCY_PAYLOAD" });
    registerMcpCreateSession(entry.runtime, "internal-test");
    try {
      expect((await call(body, "internal-test")).status).toBe(201);
      const replay = await call({ ...body, elements: [{ id: "random_second", type: "rectangle" }] }, "internal-test");
      expect(replay.status).toBe(200);
      expect((await replay.json()).idempotentReplay).toBe(true);
    } finally {
      unregisterMcpCreateSession(entry.runtime, "internal-test");
    }
    expect(await (await call(body, "internal-test")).json()).toMatchObject({ code: "INVALID_IDEMPOTENCY_PAYLOAD" });
  });

  it("preflights retries before folder side effects without changing records", async () => {
    const { entry, call } = setup();
    const intent = { tool: "create_board", args: { name: "已有画板", folderName: "原文件夹" } };
    expect(await lookupMcpCreateReplay(entry.runtime, undefined, intent)).toBeNull();
    expect(await lookupMcpCreateReplay(entry.runtime, "preflight-key", intent)).toBeNull();
    registerMcpCreateSession(entry.runtime, "preflight-session");
    let id: string;
    try {
      const response = await call({ name: "已有画板", idempotencyKey: "preflight-key", idempotencyPayload: intent }, "preflight-session");
      id = (await response.json()).id;
    } finally { unregisterMcpCreateSession(entry.runtime, "preflight-session"); }
    entry.runtime.db.run("UPDATE scenes SET name = '当前名称', revision = 7, element_count = 9 WHERE id = ?", [id]);
    const snapshot = entry.runtime.db.query("SELECT * FROM scene_create_requests").all();
    const replay = await lookupMcpCreateReplay(entry.runtime, "preflight-key", { args: { folderName: "原文件夹", name: "已有画板" }, tool: "create_board" });
    expect(replay).toMatchObject({ id, name: "当前名称", revision: 7, element_count: 9, idempotentReplay: true });
    await expect(lookupMcpCreateReplay(entry.runtime, "preflight-key", { tool: "create_board", args: { name: "新请求" } })).rejects.toThrow("不同创建参数");
    expect(entry.runtime.db.query("SELECT * FROM scene_create_requests").all()).toEqual(snapshot);
    expect(entry.runtime.db.query("SELECT COUNT(*) AS count FROM folders").get()).toEqual({ count: 0 });
    entry.runtime.db.run("UPDATE scenes SET deleted_at = ? WHERE id = ?", [Date.now(), id]);
    await expect(lookupMcpCreateReplay(entry.runtime, "preflight-key", intent)).rejects.toThrow("画板已删除");
    entry.runtime.db.run("DELETE FROM scenes WHERE id = ?", [id]);
    await expect(lookupMcpCreateReplay(entry.runtime, "preflight-key", intent)).rejects.toThrow("画板已删除");
    entry.runtime.db.run("UPDATE scene_create_requests SET expires_at = 0");
    expect(await lookupMcpCreateReplay(entry.runtime, "preflight-key", intent)).toBeNull();
    expect(entry.runtime.db.query("SELECT COUNT(*) AS count FROM scene_create_requests").get()).toEqual({ count: 1 });
  });
});
