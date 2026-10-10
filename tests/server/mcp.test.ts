import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "bun:test";

import { createMcpRequestHandler } from "../../server/mcp";
import { createRequestHandler } from "../../server/routes";
import { createRuntime } from "../../server/runtime";
import { createServerConfig } from "../../server/config";

import type { ServerRuntime } from "../../server/types";

const resources: Array<{ runtime: ServerRuntime; directory: string }> = [];

afterEach(async () => {
  for (const { runtime, directory } of resources.splice(0)) {
    runtime.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

const toolResult = <T>(result: {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}) => {
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ ok: true });
  const data = result.structuredContent as Record<string, unknown>;
  const records = [data, ...["items", "boards", "results"].flatMap((key) =>
    Array.isArray(data[key]) ? data[key] as Record<string, unknown>[] : [])];
  for (const record of records) {
    if (typeof record.boardId === "string") expect(record).not.toHaveProperty("id");
  }
  return result.structuredContent as T;
};

describe("Excalidraw MCP endpoint", () => {
  it("supports trusted HTTPS proxy origins and does not trust forwarded hosts on direct connections", async () => {
    for (const trustProxy of [false, true]) {
      const directory = path.join(os.tmpdir(), `excalidraw-mcp-proxy-${crypto.randomUUID()}`);
      const runtime = createRuntime({
        dbPath: path.join(directory, "database.db"),
        filesDir: path.join(directory, "files"),
        config: createServerConfig({ NODE_ENV: "test", ALLOW_ANONYMOUS: "true",
          MCP_TOKEN: "proxy-test-token", TRUST_PROXY: String(trustProxy) }),
      });
      resources.push({ runtime, directory });
      const handler = createMcpRequestHandler(runtime, createRequestHandler(runtime));
      const headers = {
        "X-Forwarded-Proto": "https", "X-Forwarded-Host": "boards.example.com",
        "X-Forwarded-For": "203.0.113.20", Origin: "https://boards.example.com",
      };
      const preflight = await handler.fetch(new Request("http://container:8080/mcp/proxy-test-token", {
        method: "OPTIONS", headers,
      }));
      expect(preflight.status).toBe(trustProxy ? 204 : 403);
      const client = new Client({ name: "proxy-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
      const transport = new StreamableHTTPClientTransport(new URL("https://boards.example.com/mcp/proxy-test-token"), {
        fetch: async (input, init) => {
          const incoming = new Request(input, init);
          const upstreamHeaders = new Headers(incoming.headers);
          for (const [key, value] of Object.entries(headers)) {
            if (key !== "Origin" || trustProxy) upstreamHeaders.set(key, value);
          }
          const upstreamUrl = new URL(incoming.url);
          upstreamUrl.protocol = "http:";
          upstreamUrl.host = "container:8080";
          return handler.fetch(new Request(upstreamUrl, {
            method: incoming.method, headers: upstreamHeaders, signal: incoming.signal,
            ...(incoming.body ? { body: incoming.body, duplex: "half" } : {}),
          }));
        },
      });
      try {
        await client.connect(transport);
        const created = toolResult<{ boardId: string; url: string }>(await client.callTool({
          name: "create_board", arguments: { name: "反代画板" },
        }));
        const origin = trustProxy ? "https://boards.example.com" : "http://container:8080";
        expect(created.url).toBe(`${origin}/?id=${created.boardId}`);
        const read = toolResult<{ url: string }>(await client.callTool({
          name: "get_board", arguments: { boardId: created.boardId, view: "summary" },
        }));
        expect(read.url).toBe(created.url);
      } finally {
        await client.close();
        await handler.close();
      }
    }
  });

  it("requires its URL path token and supports drawing through normal scene routes", async () => {
    const directory = path.join(
      os.tmpdir(),
      `excalidraw-mcp-${crypto.randomUUID()}`,
    );
    const runtime = createRuntime({
      dbPath: path.join(directory, "database.db"),
      filesDir: path.join(directory, "files"),
      config: createServerConfig({
        NODE_ENV: "test",
        ALLOW_ANONYMOUS: "true",
        MCP_TOKEN: "mcp-test-secret/+?%",
      }),
    });
    resources.push({ runtime, directory });

    const apiHandler = createRequestHandler(runtime);
    const mcpHandler = createMcpRequestHandler(runtime, apiHandler);
    const denied = await mcpHandler.fetch(
      new Request("http://test.local/mcp", { method: "POST" }),
    );
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBeNull();
    for (const method of ["GET", "POST", "DELETE"]) {
      for (const pathname of [
        "/mcp",
        "/mcp/",
        "/mcp/wrong-token",
        "/mcp/%ZZ",
        "/mcp/token/extra",
        "/mcp?token=mcp-test-secret%2F%2B%3F%25",
      ]) {
        const rejected = await mcpHandler.fetch(new Request(`http://test.local${pathname}`, {
          method,
          headers: { Authorization: "Bearer mcp-test-secret/+?%" },
        }));
        expect(rejected.status).toBe(401);
      }
    }

    const events: Array<{ sceneId: string; revision: number }> = [];
    runtime.realtime = {
      publishSceneChanged: ({ sceneId, revision }) => {
        events.push({ sceneId, revision });
      },
      publishWorkspaceChanged: () => {},
    };

    const transport = new StreamableHTTPClientTransport(
      new URL(`http://test.local/mcp/${encodeURIComponent(runtime.config.mcpToken!)}`),
      {
        fetch: async (input, init) => {
          return mcpHandler.fetch(new Request(input, init));
        },
      },
    );
    const client = new Client(
      { name: "mcp-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "list_boards",
        "get_board",
        "create_board",
        "add_elements",
        "remove_elements",
        "update_board",
        "update_element", "get_boards_batch", "list_folders", "list_tags", "ensure_folder",
        "create_folder", "update_folder", "delete_folder", "manage_board", "delete_board", "restore_board", "batch_manage_boards",
      ]));
      expect(tools.tools.map((tool) => tool.name).some((name) => /clear_trash|purge|permanent/.test(name))).toBe(false);
      expect(client.getInstructions()).toContain("一次传入名称和全部 elements");

      const created = toolResult<{ boardId: string; name: string; revision: number }>(
        await client.callTool({
          name: "create_board",
          arguments: { name: "Agent diagram" },
        }),
      );
      expect(created.name).toBe("Agent diagram");
      expect(created.revision).toBe(1);
      expect(created.boardId).toStartWith("scene_");
      expect(created).not.toHaveProperty("thumbnail_file_id");
      expect(created).not.toHaveProperty("size");

      const added = toolResult<{
        boardId: string;
        addedCount: number;
        elementIds: string[];
        revision: number;
      }>(
        await client.callTool({
          name: "add_elements",
          arguments: {
            boardId: created.boardId,
            elements: [
              {
                type: "rectangle",
                x: 100,
                y: 120,
                width: 180,
                height: 90,
                text: "入口",
                backgroundColor: "#e8f0ea",
              },
              {
                type: "arrow",
                startX: 280,
                startY: 165,
                endX: 410,
                endY: 165,
              },
              {
                type: "text",
                x: 430,
                y: 140,
                text: "下一步",
                fontSize: 24,
              },
            ],
          },
        }),
      );
      expect(added.boardId).toBe(created.boardId);
      expect(added.addedCount).toBe(4);
      expect(added.elementIds).toHaveLength(4);
      expect(added.revision).toBe(2);

      const board = toolResult<{
        boardId: string;
        revision: number;
        elements: Array<{ id: string; type: string; index: string | null }>;
      }>(
        await client.callTool({
          name: "get_board",
          arguments: { boardId: created.boardId, view: "full" },
        }),
      );
      expect(board.elements.map((element) => element.type)).toEqual([
        "rectangle",
        "text",
        "arrow",
        "text",
      ]);
      expect(board.elements.every((element) => Boolean(element.index))).toBe(true);
      expect(events).toContainEqual({ sceneId: created.boardId, revision: 2 });

      const removed = toolResult<{ removedCount: number; revision: number }>(
        await client.callTool({
          name: "remove_elements",
          arguments: {
            boardId: created.boardId,
            elementIds: [added.elementIds[3]],
          },
        }),
      );
      expect(removed.removedCount).toBe(1);
      expect(removed.revision).toBe(3);

      const removedShape = toolResult<{
        removedCount: number;
        revision: number;
      }>(
        await client.callTool({
          name: "remove_elements",
          arguments: {
            boardId: created.boardId,
            elementIds: [added.elementIds[0]],
          },
        }),
      );
      expect(removedShape.removedCount).toBe(2);
      expect(removedShape.revision).toBe(4);

      const remaining = toolResult<{
        elements: Array<{ type: string }>;
      }>(
        await client.callTool({
          name: "get_board",
          arguments: { boardId: created.boardId },
        }),
      );
      expect(remaining.elements.map((element) => element.type)).toEqual([
        "arrow",
      ]);

      // A whole drawing is created in one tool call, including more than the
      // old 300-spec limit, with a compact receipt instead of duplicate geometry.
      const complete = toolResult<{ boardId: string; revision: number; addedCount: number; elementIds: string[] }>(
        await client.callTool({
          name: "create_board",
          arguments: { name: "一次完成", backgroundColor: "#fefefe", elements: Array.from({ length: 301 }, (_, index) => ({
            type: "rectangle", x: index * 120, y: 0, width: 100, height: 60, text: "节点",
          })) },
        }),
      );
      expect(complete.revision).toBe(1);
      expect(complete.addedCount).toBe(602);
      expect(complete.elementIds).toHaveLength(602);
      expect(complete).not.toHaveProperty("elements");

      const summary = toolResult<{ element_count: number; revision: number }>(await client.callTool({
        name: "get_board", arguments: { boardId: complete.boardId, view: "summary" },
      }));
      expect(summary.element_count).toBe(602);
      expect(summary).not.toHaveProperty("elements");

      const selected = toolResult<{ elements: Array<{ id: string; seed?: number }>; notFoundIds: string[] }>(await client.callTool({
        name: "get_board", arguments: { boardId: complete.boardId, elementIds: [complete.elementIds[0], "missing"] },
      }));
      expect(selected.elements).toHaveLength(1);
      expect(selected.elements[0]).not.toHaveProperty("seed");
      expect(selected.notFoundIds).toEqual(["missing"]);

      const thumbnail = await apiHandler(new Request(`http://test.local/api/scenes/${complete.boardId}/thumbnail?revision=1`, {
        method: "PUT", headers: { "Content-Type": "image/png" }, body: new Uint8Array([1, 2, 3]),
      }));
      expect(thumbnail.status).toBe(200);
      const withThumbnail = await (await apiHandler(new Request(`http://test.local/api/scenes/${complete.boardId}`))).json() as { thumbnail_file_id: string };
      expect(withThumbnail.thumbnail_file_id).toBeTruthy();

      const updated = toolResult<{ revision: number; addedCount: number; removedCount: number }>(await client.callTool({
        name: "update_board", arguments: { boardId: complete.boardId, expectedRevision: 1, name: "已修改",
          removeElementIds: [complete.elementIds[0]], elements: [{ type: "text", x: 0, y: 0, text: "替换内容" }] },
      }));
      expect(updated).toMatchObject({ revision: 2, addedCount: 1, removedCount: 2 });
      const changed = toolResult<{ name: string; thumbnail_file_id: string | null; appState: { viewBackgroundColor: string }; elements: Array<{ id: string }> }>(await client.callTool({
        name: "get_board", arguments: { boardId: complete.boardId, view: "full" },
      }));
      expect(changed.name).toBe("已修改");
      expect(changed).not.toHaveProperty("thumbnail_file_id");
      expect(await (await apiHandler(new Request(`http://test.local/api/scenes/${complete.boardId}`))).json())
        .toHaveProperty("thumbnail_file_id", null);
      expect(changed.appState.viewBackgroundColor).toBe("#fefefe");
      expect(changed.elements).toHaveLength(601);
      expect(changed.elements.some((element) => element.id === complete.elementIds[1])).toBe(false);

      for (const name of ["add_elements", "remove_elements", "update_board"]) {
        const conflict = await client.callTool({ name, arguments: { boardId: complete.boardId, expectedRevision: 1,
          ...(name === "remove_elements" ? { elementIds: [complete.elementIds[2]] }
            : { elements: [{ type: "text", x: 0, y: 0, text: "不会写入" }] }) } });
        expect(conflict.isError).not.toBe(true);
        expect(conflict.structuredContent).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
      }
      const emptyUpdate = await client.callTool({ name: "update_board", arguments: { boardId: complete.boardId } });
      expect(emptyUpdate.structuredContent).toMatchObject({ ok: false, error: { code: "EMPTY_UPDATE" } });
      const notFound = await client.callTool({ name: "get_board", arguments: { boardId: "missing" } });
      expect(notFound.structuredContent).toMatchObject({ ok: false });
      expect(notFound.content[0]).toMatchObject({ type: "text" });
      const unchanged = toolResult<{ revision: number }>(await client.callTool({
        name: "get_board", arguments: { boardId: complete.boardId, view: "summary" },
      }));
      expect(unchanged.revision).toBe(2);

      // Exercise the server validator directly so client-side schema checks cannot mask a write.
      for (const typo of ["zIndex", "strokeColour", "fillStyles"]) {
        const invalidResponse = await mcpHandler.fetch(new Request(
          `http://test.local/mcp/${encodeURIComponent(runtime.config.mcpToken!)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 91, method: "tools/call", params: {
              name: "add_elements", arguments: { boardId: complete.boardId, elements: [{
                type: "rectangle", x: 0, y: 0, width: 100, height: 60, [typo]: 999,
              }] },
            } }),
          },
        ));
        expect(await invalidResponse.text()).toContain("Unrecognized key");
      }
      const afterInvalid = toolResult<{ revision: number }>(await client.callTool({
        name: "get_board", arguments: { boardId: complete.boardId, view: "summary" },
      }));
      expect(afterInvalid.revision).toBe(2);

      const connected = toolResult<{ boardId: string; revision: number }>(await client.callTool({
        name: "create_board", arguments: {
          name: "完整工作流", folderName: "流程文件夹", tags: ["工作流"], favorite: true,
          elements: [
            { id: "source", type: "rectangle", x: 0, y: 0, width: 180, height: 80, text: "开始" },
            { id: "target", type: "rectangle", x: 300, y: 100, width: 180, height: 80, text: "终点" },
            { id: "connector", type: "arrow", points: [[180, 40], [250, 40], [250, 140], [300, 140]],
              startBinding: { elementId: "source" }, endBinding: { elementId: "target" } },
          ],
        },
      }));
      const moved = toolResult<{ revision: number; updatedCount: number }>(await client.callTool({
        name: "update_element", arguments: { boardId: connected.boardId, expectedRevision: 1,
          update: { id: "source", x: 100, strokeColor: "#f00", opacity: 50.5, rotation: 15, roundness: 12 } },
      }));
      expect(moved.revision).toBe(2);
      const styled = toolResult<{ elements: Array<Record<string, unknown>> }>(await client.callTool({
        name: "get_board", arguments: { boardId: connected.boardId, elementIds: ["source", "connector"], view: "full" },
      }));
      expect(styled.elements.find((element) => element.id === "source")).toMatchObject({ strokeColor: "#f00", opacity: 50.5, x: 100 });
      expect(styled.elements.find((element) => element.id === "connector")).toMatchObject({
        startBinding: { elementId: "source" }, endBinding: { elementId: "target" },
      });
      const noop = toolResult<{ revision: number; noop: boolean }>(await client.callTool({
        name: "update_element", arguments: { boardId: connected.boardId, update: { id: "source", strokeColor: "#f00" } },
      }));
      expect(noop).toMatchObject({ revision: 2, noop: true });
      const page = toolResult<{ elements: unknown[]; nextOffset: number; truncated: boolean }>(await client.callTool({
        name: "get_board", arguments: { boardId: complete.boardId, limit: 2 },
      }));
      expect(page).toMatchObject({ nextOffset: 2, truncated: true });
      expect(page.elements).toHaveLength(2);
      const batch = toolResult<{ boards: Array<Record<string, unknown>>; truncated: boolean }>(await client.callTool({
        name: "get_boards_batch", arguments: { boardIds: [complete.boardId, connected.boardId], maxChars: 10_000 },
      }));
      expect(batch.truncated).toBe(true);
      expect(JSON.stringify(batch).length).toBeLessThanOrEqual(10_000);
      const favorites = toolResult<{ items: Array<{ boardId: string }> }>(await client.callTool({
        name: "list_boards", arguments: { favorite: true, tag: "工作流" },
      }));
      expect(favorites.items.map((scene) => scene.boardId)).toContain(connected.boardId);

      const canonicalFavorites = toolResult<{ items: Array<{ boardId: string }> }>(await client.callTool({
        name: "list_boards", arguments: { view: "all", favorite: true, tag: "工作流" },
      }));
      expect(canonicalFavorites.items).toEqual(favorites.items);
      expect(canonicalFavorites.items[0].boardId).toBe(connected.boardId);
      expect(canonicalFavorites.items[0]).not.toHaveProperty("size");
      const favoriteViewSchema = tools.tools.find((tool) => tool.name === "list_boards")!.inputSchema;
      expect((favoriteViewSchema.properties!.view as { enum: string[] }).enum).toEqual(["all", "recent", "trash"]);
      const unfavorites = toolResult<{ items: Array<{ boardId: string }> }>(await client.callTool({
        name: "list_boards", arguments: { favorite: false },
      }));
      expect(unfavorites.items.some((board) => board.boardId === connected.boardId)).toBe(false);
      const missingFolder = await client.callTool({ name: "list_boards", arguments: { folderId: "missing" } });
      expect(missingFolder.structuredContent).toMatchObject({ ok: false, error: { code: "FOLDER_NOT_FOUND" } });

      const summaryBatch = toolResult<{ partial: boolean; truncated: boolean; boards: Array<Record<string, unknown>> }>(await client.callTool({
        name: "get_boards_batch", arguments: { boardIds: [complete.boardId, "missing", connected.boardId], view: "summary" },
      }));
      expect(summaryBatch).toMatchObject({ partial: true, truncated: false });
      expect(summaryBatch.boards[1]).toMatchObject({ boardId: "missing", error: { code: "SCENE_NOT_FOUND" } });
      const allMissing = toolResult<{ partial: boolean; truncated: boolean }>(await client.callTool({
        name: "get_boards_batch", arguments: { boardIds: ["missing"], view: "summary" },
      }));
      expect(allMissing).toMatchObject({ partial: false, truncated: false });
      const smallSummary = toolResult<{ boards: Array<Record<string, unknown>>; truncated: boolean }>(await client.callTool({
        name: "get_boards_batch", arguments: { boardIds: [connected.boardId], view: "summary", maxChars: 1_000 },
      }));
      expect(smallSummary.truncated).toBe(false);
      expect(smallSummary.boards[0]).toMatchObject({ boardId: connected.boardId });
      expect(JSON.stringify(smallSummary).length).toBeLessThanOrEqual(1_000);
      const constrainedBatch = toolResult<{ boards: unknown[]; truncated: boolean }>(await client.callTool({
        name: "get_boards_batch", arguments: { boardIds: [complete.boardId, connected.boardId], maxChars: 1_000 },
      }));
      expect(constrainedBatch.truncated).toBe(true);
      expect(JSON.stringify(constrainedBatch).length).toBeLessThanOrEqual(1_000);
      const impossibleBudget = await client.callTool({ name: "get_boards_batch", arguments: {
        boardIds: Array.from({ length: 20 }, (_, i) => `${i}_${"x".repeat(120)}`), maxChars: 1_000,
      } });
      expect(impossibleBudget.structuredContent).toMatchObject({ ok: false, error: { code: "READ_BUDGET_TOO_SMALL" } });
      for (const view of ["summary", "elements", "full", "input"]) {
        const clean = toolResult<Record<string, unknown>>(await client.callTool({ name: "get_board", arguments: { boardId: complete.boardId, view } }));
        expect(clean).not.toHaveProperty("thumbnail_file_id");
        expect(clean).not.toHaveProperty("size");
      }

      const input = toolResult<{ elements: Array<Record<string, unknown>>; unsupportedElementIds: string[]; warnings: unknown[] }>(await client.callTool({
        name: "get_board", arguments: { boardId: connected.boardId, view: "input" },
      }));
      expect(input.elements).toHaveLength(3);
      expect(input.unsupportedElementIds).toEqual([]);
      expect(input.warnings).toEqual([]);
      const edge = input.elements.find((element) => element.id === "connector")!;
      expect(edge).not.toHaveProperty("angle");
      expect(edge).not.toHaveProperty("boundElements");
      const clone = toolResult<{ boardId: string; requestedElementIds: string[]; generatedElementIds: string[]; elementMap: Array<{ inputIndex: number; elementId: string; labelId?: string }> }>(await client.callTool({
        name: "create_board", arguments: { name: "直接复制可写输出", elements: input.elements },
      }));
      expect(clone.requestedElementIds).toEqual(["source", "target", "connector"]);
      expect(clone.generatedElementIds).toHaveLength(2);
      expect(clone.elementMap).toEqual([
        { inputIndex: 0, elementId: "source", labelId: clone.generatedElementIds[0] },
        { inputIndex: 1, elementId: "target", labelId: clone.generatedElementIds[1] },
        { inputIndex: 2, elementId: "connector" },
      ]);
      const cloneInput = toolResult<{ elements: unknown[] }>(await client.callTool({
        name: "get_board", arguments: { boardId: clone.boardId, view: "input" },
      }));
      expect(cloneInput.elements).toEqual(input.elements);
      const emptyTarget = toolResult<{ boardId: string }>(await client.callTool({ name: "create_board", arguments: { name: "追加复制" } }));
      const appended = toolResult<{ requestedElementIds: string[] }>(await client.callTool({
        name: "add_elements", arguments: { boardId: emptyTarget.boardId, elements: input.elements },
      }));
      expect(appended.requestedElementIds).toEqual(clone.requestedElementIds);
      const readable = toolResult<{ elements: Array<Record<string, unknown>>; pointCoordinateSystem: string }>(await client.callTool({
        name: "get_board", arguments: { boardId: clone.boardId, elementIds: ["connector"] },
      }));
      expect(readable.pointCoordinateSystem).toBe("absolute");
      expect(readable.elements[0].points).toEqual(edge.points);
      const labelBoard = toolResult<{ boardId: string; revision: number; generatedElementIds: string[] }>(await client.callTool({
        name: "create_board", arguments: { name: "标签边界", elements: [{ id: "rr", type: "rectangle", x: 0, y: 0, width: 100, height: 80, text: "短标签" }] },
      }));
      const labelUpdate = toolResult<{ revision: number }>(await client.callTool({ name: "update_element", arguments: {
        boardId: labelBoard.boardId, update: { id: "rr", text: "字".repeat(2_000) }, expectedRevision: labelBoard.revision,
      } }));
      for (const id of ["rr", labelBoard.generatedElementIds[0]]) {
        const tooLong = await client.callTool({ name: "update_element", arguments: {
          boardId: labelBoard.boardId, update: { id, text: "字".repeat(2_001) }, expectedRevision: labelUpdate.revision,
        } });
        expect(tooLong.structuredContent).toMatchObject({ ok: false, error: { code: "INVALID_ELEMENT_UPDATE" } });
      }
      const validLabel = toolResult<{ revision: number; elements: unknown[]; projectionIncomplete: boolean }>(await client.callTool({
        name: "get_board", arguments: { boardId: labelBoard.boardId, view: "input" },
      }));
      expect(validLabel.revision).toBe(labelUpdate.revision);
      expect(validLabel.elements).toHaveLength(1);
      expect(validLabel.projectionIncomplete).toBe(false);
      const legacy = await (await apiHandler(new Request(`http://test.local/api/scenes/${labelBoard.boardId}`))).json() as { elements: Array<Record<string, unknown>> };
      for (const element of legacy.elements) if (element.type === "text") element.originalText = "字".repeat(2_001);
      runtime.db.query("UPDATE scenes SET elements = ? WHERE id = ?").run(JSON.stringify(legacy.elements), labelBoard.boardId);
      const incompleteLabel = toolResult<{ elements: unknown[]; projectionIncomplete: boolean; warnings: Array<{ message: string }> }>(await client.callTool({
        name: "get_board", arguments: { boardId: labelBoard.boardId, view: "input" },
      }));
      expect(incompleteLabel.elements).toHaveLength(0);
      expect(incompleteLabel.projectionIncomplete).toBe(true);
      expect(incompleteLabel.warnings.some((warning) => warning.message.includes("2000"))).toBe(true);
    } finally {
      await client.close();
      await mcpHandler.close();
    }

    expect(runtime.sessions.size).toBe(0);
  });
});
