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
  return result.structuredContent as T;
};

describe("Excalidraw MCP endpoint", () => {
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

      const created = toolResult<{ id: string; name: string; revision: number }>(
        await client.callTool({
          name: "create_board",
          arguments: { name: "Agent diagram" },
        }),
      );
      expect(created.name).toBe("Agent diagram");
      expect(created.revision).toBe(1);

      const added = toolResult<{
        boardId: string;
        addedCount: number;
        elementIds: string[];
        revision: number;
      }>(
        await client.callTool({
          name: "add_elements",
          arguments: {
            boardId: created.id,
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
      expect(added.boardId).toBe(created.id);
      expect(added.addedCount).toBe(4);
      expect(added.elementIds).toHaveLength(4);
      expect(added.revision).toBe(2);

      const board = toolResult<{
        id: string;
        revision: number;
        elements: Array<{ id: string; type: string; index: string | null }>;
      }>(
        await client.callTool({
          name: "get_board",
          arguments: { boardId: created.id, view: "full" },
        }),
      );
      expect(board.elements.map((element) => element.type)).toEqual([
        "rectangle",
        "text",
        "arrow",
        "text",
      ]);
      expect(board.elements.every((element) => Boolean(element.index))).toBe(true);
      expect(events).toContainEqual({ sceneId: created.id, revision: 2 });

      const removed = toolResult<{ removedCount: number; revision: number }>(
        await client.callTool({
          name: "remove_elements",
          arguments: {
            boardId: created.id,
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
            boardId: created.id,
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
          arguments: { boardId: created.id },
        }),
      );
      expect(remaining.elements.map((element) => element.type)).toEqual([
        "arrow",
      ]);

      // A whole drawing is created in one tool call, including more than the
      // old 300-spec limit, with a compact receipt instead of duplicate geometry.
      const complete = toolResult<{ id: string; revision: number; addedCount: number; elementIds: string[] }>(
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
        name: "get_board", arguments: { boardId: complete.id, view: "summary" },
      }));
      expect(summary.element_count).toBe(602);
      expect(summary).not.toHaveProperty("elements");

      const selected = toolResult<{ elements: Array<{ id: string; seed?: number }>; notFoundIds: string[] }>(await client.callTool({
        name: "get_board", arguments: { boardId: complete.id, elementIds: [complete.elementIds[0], "missing"] },
      }));
      expect(selected.elements).toHaveLength(1);
      expect(selected.elements[0]).not.toHaveProperty("seed");
      expect(selected.notFoundIds).toEqual(["missing"]);

      const thumbnail = await apiHandler(new Request(`http://test.local/api/scenes/${complete.id}/thumbnail?revision=1`, {
        method: "PUT", headers: { "Content-Type": "image/png" }, body: new Uint8Array([1, 2, 3]),
      }));
      expect(thumbnail.status).toBe(200);
      const withThumbnail = await (await apiHandler(new Request(`http://test.local/api/scenes/${complete.id}`))).json() as { thumbnail_file_id: string };
      expect(withThumbnail.thumbnail_file_id).toBeTruthy();

      const updated = toolResult<{ revision: number; addedCount: number; removedCount: number }>(await client.callTool({
        name: "update_board", arguments: { boardId: complete.id, expectedRevision: 1, name: "已修改",
          removeElementIds: [complete.elementIds[0]], elements: [{ type: "text", x: 0, y: 0, text: "替换内容" }] },
      }));
      expect(updated).toMatchObject({ revision: 2, addedCount: 1, removedCount: 2 });
      const changed = toolResult<{ name: string; thumbnail_file_id: string | null; appState: { viewBackgroundColor: string }; elements: Array<{ id: string }> }>(await client.callTool({
        name: "get_board", arguments: { boardId: complete.id, view: "full" },
      }));
      expect(changed.name).toBe("已修改");
      expect(changed.thumbnail_file_id).toBeNull();
      expect(changed.appState.viewBackgroundColor).toBe("#fefefe");
      expect(changed.elements).toHaveLength(601);
      expect(changed.elements.some((element) => element.id === complete.elementIds[1])).toBe(false);

      for (const name of ["add_elements", "remove_elements", "update_board"]) {
        const conflict = await client.callTool({ name, arguments: { boardId: complete.id, expectedRevision: 1,
          ...(name === "remove_elements" ? { elementIds: [complete.elementIds[2]] }
            : { elements: [{ type: "text", x: 0, y: 0, text: "不会写入" }] }) } });
        expect(conflict.isError).not.toBe(true);
        expect(conflict.structuredContent).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
      }
      const emptyUpdate = await client.callTool({ name: "update_board", arguments: { boardId: complete.id } });
      expect(emptyUpdate.structuredContent).toMatchObject({ ok: false, error: { code: "EMPTY_UPDATE" } });
      const notFound = await client.callTool({ name: "get_board", arguments: { boardId: "missing" } });
      expect(notFound.structuredContent).toMatchObject({ ok: false });
      expect(notFound.content[0]).toMatchObject({ type: "text" });
      const unchanged = toolResult<{ revision: number }>(await client.callTool({
        name: "get_board", arguments: { boardId: complete.id, view: "summary" },
      }));
      expect(unchanged.revision).toBe(2);

      // Exercise the server validator directly so client-side schema checks cannot mask a write.
      for (const typo of ["zIndex", "strokeColour", "fillStyles"]) {
        const invalidResponse = await mcpHandler.fetch(new Request(
          `http://test.local/mcp/${encodeURIComponent(runtime.config.mcpToken!)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 91, method: "tools/call", params: {
              name: "add_elements", arguments: { boardId: complete.id, elements: [{
                type: "rectangle", x: 0, y: 0, width: 100, height: 60, [typo]: 999,
              }] },
            } }),
          },
        ));
        expect(await invalidResponse.text()).toContain("Unrecognized key");
      }
      const afterInvalid = toolResult<{ revision: number }>(await client.callTool({
        name: "get_board", arguments: { boardId: complete.id, view: "summary" },
      }));
      expect(afterInvalid.revision).toBe(2);

      const connected = toolResult<{ id: string; revision: number }>(await client.callTool({
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
        name: "update_element", arguments: { boardId: connected.id, expectedRevision: 1,
          update: { id: "source", x: 100, strokeColor: "#f00", opacity: 50.5, rotation: 15, roundness: 12 } },
      }));
      expect(moved.revision).toBe(2);
      const styled = toolResult<{ elements: Array<Record<string, unknown>> }>(await client.callTool({
        name: "get_board", arguments: { boardId: connected.id, elementIds: ["source", "connector"], view: "full" },
      }));
      expect(styled.elements.find((element) => element.id === "source")).toMatchObject({ strokeColor: "#f00", opacity: 50.5, x: 100 });
      expect(styled.elements.find((element) => element.id === "connector")).toMatchObject({
        startBinding: { elementId: "source" }, endBinding: { elementId: "target" },
      });
      const noop = toolResult<{ revision: number; noop: boolean }>(await client.callTool({
        name: "update_element", arguments: { boardId: connected.id, update: { id: "source", strokeColor: "#f00" } },
      }));
      expect(noop).toMatchObject({ revision: 2, noop: true });
      const page = toolResult<{ elements: unknown[]; nextOffset: number; truncated: boolean }>(await client.callTool({
        name: "get_board", arguments: { boardId: complete.id, limit: 2 },
      }));
      expect(page).toMatchObject({ nextOffset: 2, truncated: true });
      expect(page.elements).toHaveLength(2);
      const batch = toolResult<{ boards: Array<Record<string, unknown>>; truncated: boolean }>(await client.callTool({
        name: "get_boards_batch", arguments: { boardIds: [complete.id, connected.id], maxChars: 10_000 },
      }));
      expect(batch.truncated).toBe(true);
      expect(JSON.stringify(batch).length).toBeLessThanOrEqual(10_000);
      const favorites = toolResult<{ items: Array<{ id: string }> }>(await client.callTool({
        name: "list_boards", arguments: { view: "favorites", tag: "工作流" },
      }));
      expect(favorites.items.map((scene) => scene.id)).toContain(connected.id);
    } finally {
      await client.close();
      await mcpHandler.close();
    }

    expect(runtime.sessions.size).toBe(0);
  });
});
