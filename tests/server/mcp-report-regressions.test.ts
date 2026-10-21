import { expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServerConfig } from "../../server/config";
import { createMcpRequestHandler } from "../../server/mcp";
import { createDrawingBatch, drawingElementSchema } from "../../server/mcp-drawing";
import { createRequestHandler } from "../../server/routes";
import { createRuntime } from "../../server/runtime";

const fixture = (trashRetentionDays = "7") => {
  const directory = path.join(os.tmpdir(), `excalidraw-mcp-report-${crypto.randomUUID()}`);
  const runtime = createRuntime({ dbPath: path.join(directory, "database.db"), filesDir: path.join(directory, "files"),
    config: createServerConfig({ NODE_ENV: "test", ALLOW_ANONYMOUS: "true", MCP_ALLOW_LEGACY_PATH_TOKEN: "true", MCP_TOKEN: "report-test", TRASH_RETENTION_DAYS: trashRetentionDays }) });
  const api = createRequestHandler(runtime);
  const mcp = createMcpRequestHandler(runtime, api);
  return { api, mcp, async close() {
    await mcp.close();
    runtime.db.close();
    await rm(directory, { recursive: true, force: true });
  } };
};

test("MCP initialization works for Python, curl and ordinary client user agents; only notifications return 202", async () => {
  const context = fixture();
  try {
    for (const userAgent of ["Python-urllib/3.13", "curl/8.0", "ordinary-mcp-client/1.0"]) {
      const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "User-Agent": userAgent };
      const initialize = await context.mcp.fetch(new Request("http://test.local/mcp/report-test", {
        method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ua-regression", version: "1.0.0" } } }),
      }));
      expect(initialize.status).toBe(200);
      const initializeBody = await initialize.text();
      expect(initializeBody).toContain("protocolVersion");
      expect(initializeBody).toContain("回收站保留 7 天");
      const session = initialize.headers.get("mcp-session-id");
      const notification = await context.mcp.fetch(new Request("http://test.local/mcp/report-test", {
        method: "POST", headers: { ...headers, ...(session ? { "mcp-session-id": session } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }));
      expect(notification.status).toBe(202);
      expect(await notification.text()).toBe("");
      const client = new Client({ name: "ua-regression", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
      const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp/report-test"), {
        fetch: async (input, init) => {
          const request = new Request(input, init);
          request.headers.set("User-Agent", userAgent);
          return context.mcp.fetch(request);
        },
      });
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools.some((tool) => tool.name === "get_board")).toBe(true);
      } finally {
        await client.close();
      }
    }
  } finally {
    await context.close();
  }
});

test("MCP input reports unsupported images, refuses copying them and preserves them during supported updates", async () => {
  const context = fixture();
  const client = new Client({ name: "image-regression", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp/report-test"), {
    fetch: async (input, init) => context.mcp.fetch(new Request(input, init)),
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ ok: true });
    return response.structuredContent as Record<string, any>;
  };
  try {
    const shape = createDrawingBatch([drawingElementSchema.parse({
      id: "shape", type: "rectangle", x: 0, y: 0, width: 100, height: 80,
    })]).elements[0];
    // A native pending image has no attachment yet, as during an editor insertion.
    const image = { ...shape, id: "image", type: "image", x: 200, index: "a1", fileId: null, status: "pending", scale: [1, 1], crop: null };
    const created = await context.api(new Request("http://test.local/api/scenes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "图片保留", elements: [shape, image], appState: {} }),
    }));
    expect(created.status).toBe(201);
    const board = await created.json() as { id: string };
    await client.connect(transport);
    const input = await call("get_board", { boardId: board.id, view: "input" });
    expect(input.elementCount).toBe(2);
    expect(input.elements.map((element: any) => element.id)).toEqual(["shape"]);
    expect(input.unsupportedElementIds).toEqual(["image"]);
    expect(input.warnings).toContainEqual(expect.objectContaining({ elementId: "image", code: "UNSUPPORTED_ELEMENT_TYPE" }));
    const rejected = await client.callTool({ name: "copy_elements", arguments: { boardId: board.id, elementIds: ["shape", "image"] } });
    expect(rejected.structuredContent).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_COPY_SELECTION" } });
    const unchanged = await call("get_board", { boardId: board.id, view: "full" });
    expect(unchanged.revision).toBe(1);
    expect(unchanged.elements).toHaveLength(2);
    await call("update_board", { boardId: board.id, updates: [{ ...input.elements[0], x: 30 }] });
    await call("add_elements", { boardId: board.id, elements: [{ type: "text", x: 0, y: 150, text: "新增注释" }] });
    const updated = await call("get_board", { boardId: board.id, view: "full" });
    expect(updated.elementCount).toBe(3);
    expect(updated.elements.find((element: any) => element.id === "image")).toEqual(unchanged.elements.find((element: any) => element.id === "image"));
    expect(updated.elements.find((element: any) => element.id === "shape")).toMatchObject({ x: 30 });
  } finally {
    await client.close();
    await context.close();
  }
});
