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
    const data = response.structuredContent as Record<string, any>;
    if (data.ok === false) expect(response.isError).toBe(true);
    else expect(response.isError).not.toBe(true);
    expect(response.content).toHaveLength(1);
    const summary = response.content[0];
    expect(summary.type).toBe("text");
    if (summary.type === "text") {
      expect(summary.text.length).toBeLessThanOrEqual(1024);
      expect(summary.text).not.toContain("详情见 structuredContent");
      if (typeof data.boardId === "string") expect(summary.text).toContain(data.boardId);
      if (data.ok && name === "ensure_folder") expect(summary.text).toContain(data.created ? "已创建" : "已复用");
      if (data.ok && name === "create_folder") expect(summary.text).toContain("已创建");
      if (data.noop) expect(summary.text).toContain("无需修改");
      if (name === "batch_manage_boards") {
        expect(summary.text).toContain(`成功 ${data.succeeded}`);
        expect(summary.text).toContain(`失败 ${data.failed}`);
      }
    }
    for (const folder of [data, ...(data.folders || []), ...(data.folder ? [data.folder] : [])]) {
      if (typeof folder.icon === "string") {
        for (const key of ["scene_count", "created_at", "updated_at"])
          expect(folder).not.toHaveProperty(key);
      }
    }
    if (typeof data.boardId === "string") {
      for (const key of ["id", "folder_id", "created_at", "updated_at", "deleted_at", "element_count"])
        expect(data).not.toHaveProperty(key);
    }
    for (const item of data.results || []) {
      if (typeof item.boardId === "string") expect(item).not.toHaveProperty("id");
    }
    return data;
  };
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => /permanent|empty_trash|clear_trash/.test(tool.name))).toBe(false);
    const folder = await call("ensure_folder", { name: "项目", color: "#123456", icon: "book" });
    expect(folder).toMatchObject({ ok: true, created: true, color: "#123456", icon: "book" });
    expect(folder.id).toStartWith("folder_");
    expect(folder).not.toHaveProperty("boardId");
    expect(folder.createdAt).toBeGreaterThan(0);
    const folderList = await call("list_folders", {});
    expect(folderList.folders[0]).toMatchObject({ id: folder.id, boardCount: 0 });
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
    const managed = await call("manage_board", { boardId: board.boardId, expectedRevision: board.revision, name: "重命名", favorite: false, tags: ["进展"], tagMode: "add" });
    expect(managed).toMatchObject({ ok: true, name: "重命名", favorite: false, tags: ["计划", "进展"], revision: board.revision + 1 });
    const savedMetadata = runtime.db.query("SELECT revision, updated_at FROM scenes WHERE id = ?").get(board.boardId);
    // Force a measurable timestamp difference if a supposedly noop operation writes.
    await Bun.sleep(5);
    expect(await call("manage_board", { boardId: board.boardId, favorite: false, tags: ["进展"], tagMode: "add" })).toMatchObject({ ok: true, noop: true, revision: managed.revision });
    expect(runtime.db.query("SELECT revision, updated_at FROM scenes WHERE id = ?").get(board.boardId)).toEqual(savedMetadata);
    expect(await call("manage_board", { boardId: board.boardId, tags: ["计划", "进展"] })).toMatchObject({ ok: true, noop: true, tags: ["计划", "进展"] });
    expect(await call("manage_board", { boardId: board.boardId, tagMode: "add" })).toMatchObject({ ok: false, error: { code: "INVALID_TAGS" } });
    expect(await call("manage_board", { boardId: board.boardId, favorite: true, expectedRevision: board.revision })).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
    const invalidMetadata = await client.callTool({ name: "manage_board", arguments: { boardId: board.boardId, favourit: true } });
    expect(invalidMetadata.isError).toBe(true);
    const invalidNested = await client.callTool({ name: "batch_manage_boards", arguments: { items: [{ action: "manage", boardId: board.boardId, expectedRevision: managed.revision, favorite: true, unknown: true }] } });
    expect(invalidNested.isError).toBe(true);
    const missingRevision = await client.callTool({ name: "batch_manage_boards", arguments: { items: [{ action: "manage", boardId: board.boardId, favorite: true }] } });
    expect(missingRevision.isError).toBe(true);
    expect(JSON.stringify(missingRevision.content)).toContain("items.0.expectedRevision");
    const invalidAction = await client.callTool({ name: "batch_manage_boards", arguments: { items: [{ action: "destroy", boardId: board.boardId, expectedRevision: managed.revision }] } });
    expect(invalidAction.isError).toBe(true);
    expect(JSON.stringify(invalidAction.content)).toContain("items.0.action");
    const forbiddenMetadata = await client.callTool({ name: "batch_manage_boards", arguments: { items: [{ action: "delete", boardId: board.boardId, expectedRevision: managed.revision, favorite: true }] } });
    expect(forbiddenMetadata.isError).toBe(true);
    expect(JSON.stringify(forbiddenMetadata.content)).toContain("items.0.favorite");
    expect(runtime.db.query("SELECT revision FROM scenes WHERE id = ?").get(board.boardId)).toMatchObject({ revision: managed.revision });
    expect(await call("list_tags", { limit: 1 })).toMatchObject({ ok: true, tags: [expect.objectContaining({ boardCount: 1 })], nextCursor: expect.any(String) });
    const deleted = await call("delete_board", { boardId: board.boardId, expectedRevision: managed.revision });
    expect(deleted).toMatchObject({ ok: true, deleted: true, noop: false });
    expect(await call("delete_board", { boardId: board.boardId })).toMatchObject({ ok: true, noop: true });
    expect(await call("delete_folder", { folderId: folder.id, dryRun: true })).toMatchObject({ wouldMoveBoards: 1, dryRun: true });
    expect(await call("delete_folder", { folderId: folder.id })).toMatchObject({ ok: false, error: { code: "CONFIRM_REQUIRED" } });
    expect(await call("delete_folder", { folderId: folder.id, confirm: true, expectedBoardCount: 0 })).toMatchObject({ ok: false, error: { code: "FOLDER_CHANGED" } });
    expect(await call("delete_folder", { folderId: folder.id, confirm: true, expectedBoardCount: 1 })).toMatchObject({ ok: true, movedBoards: 1 });
    expect(await call("restore_board", { boardId: board.boardId, expectedRevision: deleted.revision })).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
    const restored = await call("restore_board", { boardId: board.boardId });
    // Moving out of the deleted folder and restoring each advance revision.
    expect(restored).toMatchObject({ ok: true, deleted: false, folderId: null, revision: deleted.revision + 2 });
    const batch = await call("batch_manage_boards", { items: [{ action: "manage", boardId: board.boardId, expectedRevision: restored.revision, favorite: true }, { action: "restore", boardId: "nonexistent", expectedRevision: 1 }, { action: "restore", boardId: board.boardId, expectedRevision: restored.revision + 1 }] });
    expect(batch).toMatchObject({ ok: true, succeeded: 2, failed: 1, partial: true, results: [{ ok: true, favorite: true }, { ok: false, error: { code: "SCENE_NOT_FOUND" } }, { ok: true, noop: true }] });
    const batchDelete = await call("batch_manage_boards", { items: [{ action: "delete", boardId: board.boardId, expectedRevision: restored.revision + 1 }] });
    expect(batchDelete).toMatchObject({ ok: true, succeeded: 1, failed: 0, partial: false, results: [{ ok: true, action: "delete", deleted: true }] });
    const batchRestore = await call("batch_manage_boards", { items: [{ action: "restore", boardId: board.boardId, expectedRevision: batchDelete.results[0].revision }] });
    expect(batchRestore).toMatchObject({ ok: true, results: [{ ok: true, action: "restore", deleted: false }] });
    const recentIds: string[] = [];
    for (const [index, openedAt] of [100, 300, 300, null].entries()) {
      const recentBoard = await call("create_board", { name: `recent-regression-${index}` });
      recentIds.push(recentBoard.boardId);
      runtime.db.run("UPDATE scenes SET last_opened_at = ?, updated_at = ? WHERE id = ?", [openedAt, 1000 - index, recentBoard.boardId]);
    }
    const expectedRecent = [recentIds[1], recentIds[2]].sort().reverse().concat(recentIds[0]!);
    let recentCursor: string | undefined;
    const recentPageIds: string[] = [];
    for (let index = 0; index < 3; index++) {
      const recentPage = await call("list_boards", { view: "recent", query: "recent-regression-", limit: 1, ...(recentCursor ? { cursor: recentCursor } : {}) });
      expect(recentPage.items).toHaveLength(1);
      expect(recentPage.items[0].lastOpenedAt).not.toBeNull();
      recentPageIds.push(recentPage.items[0].boardId);
      recentCursor = recentPage.nextCursor;
    }
    expect(recentPageIds).toEqual(expectedRecent);
    expect(recentCursor).toBeNull();
    const originalDuplicate = await call("create_folder", { name: "重复" });
    expect(await call("create_folder", { name: " 重复 " })).toMatchObject({ ok: false, error: { code: "FOLDER_NAME_EXISTS" } });
    const otherFolder = await call("create_folder", { name: "另一个" });
    expect(await call("update_folder", { folderId: otherFolder.id, name: "重复" })).toMatchObject({ ok: false, error: { code: "FOLDER_NAME_EXISTS" } });
    // Existing databases can contain old duplicate names. Do not migrate/delete them.
    runtime.db.run("INSERT INTO folders (id, name, icon, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", ["folder_legacy_duplicate", "重复", "folder", "#315f4c", 1, 1]);
    expect(await call("ensure_folder", { name: "重复" })).toMatchObject({ ok: false, error: { code: "AMBIGUOUS_FOLDER" } });
    expect(await call("manage_board", { boardId: board.boardId, folderName: "重复" })).toMatchObject({ ok: false, error: { code: "AMBIGUOUS_FOLDER" } });
    expect(await call("manage_board", { boardId: board.boardId, folderId: originalDuplicate.id })).toMatchObject({ ok: true, folderId: originalDuplicate.id });
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => call("ensure_folder", { name: "并发文件夹" })));
    expect(new Set(concurrent.map((item) => item.id)).size).toBe(1);
    expect(concurrent.filter((item) => item.created)).toHaveLength(1);
    expect(runtime.db.query("SELECT COUNT(*) AS count FROM folders WHERE name = ?").get("并发文件夹")).toEqual({ count: 1 });
    const newFolderBoard = await call("create_board", { name: "新文件夹一次创建", folderName: "新文件夹" });
    expect(newFolderBoard.ok).toBe(true);
    expect(typeof newFolderBoard.boardId).toBe("string");
    expect(await call("get_board", { boardId: newFolderBoard.boardId, view: "summary" })).toMatchObject({ folderId: expect.any(String) });
    expect(await call("manage_board", { boardId: newFolderBoard.boardId, folderId: null, tags: [], tagMode: "replace" })).toMatchObject({ ok: true, folderId: null, tags: [] });
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
