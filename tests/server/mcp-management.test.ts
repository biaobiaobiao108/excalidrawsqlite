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
    for (const color of ["#f00", "#f008", "#ff000080", "red", "transparent"]) {
      const colored = await call("create_folder", { name: `颜色 ${color}`, color });
      expect(colored).toMatchObject({ ok: true, color });
      expect(await call("update_folder", { folderId: colored.id, color: "  NAVY  " })).toMatchObject({ ok: true, color: "navy" });
    }
    const invalidColor = await client.callTool({ name: "create_folder", arguments: { name: "非法颜色", color: "url(https://example.com)" } });
    expect(invalidColor.isError).toBe(true);
    const board = await call("create_board", { name: "管理测试", folderName: "项目", tags: ["计划"], favorite: true });
    const managed = await call("manage_board", { boardId: board.id, expectedRevision: board.revision, name: "重命名", favorite: false, tags: ["进展"], tagMode: "add" });
    expect(managed).toMatchObject({ ok: true, name: "重命名", favorite: false, tags: ["计划", "进展"], revision: board.revision + 1 });
    const savedMetadata = runtime.db.query("SELECT revision, updated_at FROM scenes WHERE id = ?").get(board.id);
    // Force a measurable timestamp difference if a supposedly noop operation writes.
    await Bun.sleep(5);
    expect(await call("manage_board", { boardId: board.id, favorite: false, tags: ["进展"], tagMode: "add" })).toMatchObject({ ok: true, noop: true, revision: managed.revision });
    expect(runtime.db.query("SELECT revision, updated_at FROM scenes WHERE id = ?").get(board.id)).toEqual(savedMetadata);
    expect(await call("manage_board", { boardId: board.id, tags: ["计划"] })).toMatchObject({ ok: false, error: { code: "INVALID_TAGS" } });
    expect(await call("manage_board", { boardId: board.id, favorite: true, expectedRevision: board.revision })).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
    const invalidMetadata = await client.callTool({ name: "manage_board", arguments: { boardId: board.id, favourit: true } });
    expect(invalidMetadata.isError).toBe(true);
    const invalidNested = await client.callTool({ name: "batch_manage_boards", arguments: { items: [{ action: "manage", boardId: board.id, expectedRevision: managed.revision, favorite: true, unknown: true }] } });
    expect(invalidNested.isError).toBe(true);
    const missingRevision = await client.callTool({ name: "batch_manage_boards", arguments: { items: [{ action: "manage", boardId: board.id, favorite: true }] } });
    expect(missingRevision.isError).toBe(true);
    expect(JSON.stringify(missingRevision.content)).toContain("items.0.expectedRevision");
    const invalidAction = await client.callTool({ name: "batch_manage_boards", arguments: { items: [{ action: "destroy", boardId: board.id, expectedRevision: managed.revision }] } });
    expect(invalidAction.isError).toBe(true);
    expect(JSON.stringify(invalidAction.content)).toContain("items.0.action");
    const forbiddenMetadata = await client.callTool({ name: "batch_manage_boards", arguments: { items: [{ action: "delete", boardId: board.id, expectedRevision: managed.revision, favorite: true }] } });
    expect(forbiddenMetadata.isError).toBe(true);
    expect(JSON.stringify(forbiddenMetadata.content)).toContain("items.0.favorite");
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
    // Moving out of the deleted folder and restoring each advance revision.
    expect(restored).toMatchObject({ ok: true, deleted: false, folder_id: null, revision: deleted.revision + 2 });
    const batch = await call("batch_manage_boards", { items: [{ action: "manage", boardId: board.id, expectedRevision: restored.revision, favorite: true }, { action: "restore", boardId: "nonexistent", expectedRevision: 1 }, { action: "restore", boardId: board.id, expectedRevision: restored.revision + 1 }] });
    expect(batch).toMatchObject({ ok: true, succeeded: 2, failed: 1, partial: true, results: [{ ok: true, favorite: true }, { ok: false, error: { code: "SCENE_NOT_FOUND" } }, { ok: true, noop: true }] });
    const originalDuplicate = await call("create_folder", { name: "重复" });
    expect(await call("create_folder", { name: " 重复 " })).toMatchObject({ ok: false, error: { code: "FOLDER_NAME_EXISTS" } });
    const otherFolder = await call("create_folder", { name: "另一个" });
    expect(await call("update_folder", { folderId: otherFolder.id, name: "重复" })).toMatchObject({ ok: false, error: { code: "FOLDER_NAME_EXISTS" } });
    // Existing databases can contain old duplicate names. Do not migrate/delete them.
    runtime.db.run("INSERT INTO folders (id, name, icon, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", ["folder_legacy_duplicate", "重复", "folder", "#315f4c", 1, 1]);
    expect(await call("ensure_folder", { name: "重复" })).toMatchObject({ ok: false, error: { code: "AMBIGUOUS_FOLDER" } });
    expect(await call("manage_board", { boardId: board.id, folderName: "重复" })).toMatchObject({ ok: false, error: { code: "AMBIGUOUS_FOLDER" } });
    expect(await call("manage_board", { boardId: board.id, folderId: originalDuplicate.id })).toMatchObject({ ok: true, folder_id: originalDuplicate.id });
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => call("ensure_folder", { name: "并发文件夹" })));
    expect(new Set(concurrent.map((item) => item.id)).size).toBe(1);
    expect(concurrent.filter((item) => item.created)).toHaveLength(1);
    expect(runtime.db.query("SELECT COUNT(*) AS count FROM folders WHERE name = ?").get("并发文件夹")).toEqual({ count: 1 });
    const newFolderBoard = await call("create_board", { name: "新文件夹一次创建", folderName: "新文件夹" });
    expect(newFolderBoard).toMatchObject({ ok: true, folder_id: expect.any(String) });
    expect(await call("manage_board", { boardId: newFolderBoard.id, folderId: null, tags: [], tagMode: "replace" })).toMatchObject({ ok: true, folder_id: null, tags: [] });
    const taggedBoard = await call("create_board", { name: "分页边界", tags: ["cursor-a", "cursor-b"] });
    const tagPage = await call("list_tags", { limit: 1 });
    expect(tagPage).toMatchObject({ tags: [{ name: "cursor-a", boardCount: 1 }], nextCursor: "cursor-a" });
    await call("manage_board", { boardId: taggedBoard.boardId, tags: ["cursor-b"], tagMode: "replace" });
    expect(await call("list_tags", { cursor: tagPage.nextCursor, limit: 1 })).toMatchObject({ tags: [{ name: "cursor-b", boardCount: 1 }] });
    await call("manage_board", { boardId: taggedBoard.boardId, tags: ["cursor-a-renamed", "cursor-b"], tagMode: "replace" });
    expect(await call("list_tags", { cursor: tagPage.nextCursor, limit: 2 })).toMatchObject({ tags: [{ name: "cursor-a-renamed", boardCount: 1 }, { name: "cursor-b", boardCount: 1 }] });
  } finally {
    await client.close();
    await handler.close();
    runtime.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
