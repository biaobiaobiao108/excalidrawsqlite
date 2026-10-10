import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "bun:test";
import { createMcpRequestHandler } from "../../server/mcp";
import { createRequestHandler } from "../../server/routes";
import { createRuntime } from "../../server/runtime";
import { createServerConfig } from "../../server/config";

it("MCP supports folders, favorites, tags, safe trash and independent bounded batch management", async () => {
  const directory = path.join(os.tmpdir(), `excalidraw-mcp-management-${crypto.randomUUID()}`);
  const runtime = createRuntime({ dbPath: path.join(directory, "database.db"), filesDir: path.join(directory, "files"), config: createServerConfig({ NODE_ENV: "test", ALLOW_ANONYMOUS: "true", MCP_TOKEN: "management-test" }) });
  const handler = createMcpRequestHandler(runtime, createRequestHandler(runtime));
  const client = new Client({ name: "management-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp/management-test"), { fetch: async (input, init) => handler.fetch(new Request(input, init)) });
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError).not.toBe(true);
    return response.structuredContent as Record<string, any>;
  };
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => /permanent|empty_trash|clear_trash/.test(tool.name))).toBe(false);
    const folder = await call("ensure_folder", { name: "项目", color: "#123456", icon: "book" });
    expect(folder).toMatchObject({ ok: true, created: true, color: "#123456", icon: "book" });
    expect(await call("ensure_folder", { name: "项目", color: "#abcdef", icon: "star" })).toMatchObject({ id: folder.id, created: false, color: "#123456", icon: "book" });
    expect(await call("update_folder", { folderId: folder.id, color: "#654321" })).toMatchObject({ ok: true, name: "项目", color: "#654321" });
    const board = await call("create_board", { name: "管理测试", folderName: "项目", tags: ["计划"], favorite: true });
    const managed = await call("manage_board", { boardId: board.id, expectedRevision: board.revision, name: "重命名", favorite: false, tags: ["进展"], tagMode: "add" });
    expect(managed).toMatchObject({ ok: true, name: "重命名", favorite: false, tags: ["计划", "进展"], revision: board.revision + 1 });
    expect(await call("manage_board", { boardId: board.id, favorite: false, tags: ["进展"], tagMode: "add" })).toMatchObject({ ok: true, noop: true, revision: managed.revision });
    expect(await call("manage_board", { boardId: board.id, tags: ["计划"] })).toMatchObject({ ok: false, error: { code: "INVALID_TAGS" } });
    expect(await call("manage_board", { boardId: board.id, favorite: true, expectedRevision: board.revision })).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
    const invalidMetadata = await client.callTool({ name: "manage_board", arguments: { boardId: board.id, favourit: true } });
    expect(invalidMetadata.isError).toBe(true);
    const invalidNested = await client.callTool({ name: "batch_manage_boards", arguments: { items: [{ action: "manage", boardId: board.id, expectedRevision: managed.revision, favorite: true, unknown: true }] } });
    expect(invalidNested.isError).toBe(true);
    expect(runtime.db.query("SELECT revision FROM scenes WHERE id = ?").get(board.id)).toMatchObject({ revision: managed.revision });
    expect(await call("list_tags", { limit: 1 })).toMatchObject({ ok: true, tags: [expect.objectContaining({ boardCount: 1 })], nextCursor: expect.any(String) });
    const deleted = await call("delete_board", { boardId: board.id, expectedRevision: managed.revision });
    expect(deleted).toMatchObject({ ok: true, deleted: true, noop: false });
    expect(await call("delete_board", { boardId: board.id })).toMatchObject({ ok: true, noop: true });
    expect(await call("delete_folder", { folderId: folder.id, dryRun: true })).toMatchObject({ wouldMoveBoards: 1, dryRun: true });
    expect(await call("delete_folder", { folderId: folder.id })).toMatchObject({ ok: false, error: { code: "CONFIRM_REQUIRED" } });
    expect(await call("delete_folder", { folderId: folder.id, confirm: true, expectedBoardCount: 0 })).toMatchObject({ ok: false, error: { code: "FOLDER_CHANGED" } });
    expect(await call("delete_folder", { folderId: folder.id, confirm: true, expectedBoardCount: 1 })).toMatchObject({ ok: true, movedBoards: 1 });
    expect(await call("restore_board", { boardId: board.id, expectedRevision: deleted.revision })).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
    const restored = await call("restore_board", { boardId: board.id });
    expect(restored).toMatchObject({ ok: true, deleted: false, folder_id: null, revision: deleted.revision + 1 });
    const batch = await call("batch_manage_boards", { items: [{ action: "manage", boardId: board.id, expectedRevision: restored.revision, favorite: true }, { action: "restore", boardId: "nonexistent", expectedRevision: 1 }, { action: "restore", boardId: board.id, expectedRevision: restored.revision + 1 }] });
    expect(batch).toMatchObject({ ok: true, succeeded: 2, failed: 1, partial: true, results: [{ ok: true, favorite: true }, { ok: false, error: { code: "SCENE_NOT_FOUND" } }, { ok: true, noop: true }] });
    await call("create_folder", { name: "重复" });
    await call("create_folder", { name: "重复" });
    expect(await call("ensure_folder", { name: "重复" })).toMatchObject({ ok: false, error: { code: "AMBIGUOUS_FOLDER" } });
    const newFolderBoard = await call("create_board", { name: "新文件夹一次创建", folderName: "新文件夹" });
    expect(newFolderBoard).toMatchObject({ ok: true, folder_id: expect.any(String) });
    expect(await call("manage_board", { boardId: newFolderBoard.id, folderId: null, tags: [], tagMode: "replace" })).toMatchObject({ ok: true, folder_id: null, tags: [] });
  } finally {
    await client.close();
    await handler.close();
    runtime.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
