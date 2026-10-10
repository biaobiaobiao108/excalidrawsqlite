import { expect, test } from "bun:test";
import { createDrawingBatch, drawingElementSchema, compactElement } from "../../server/mcp-drawing";
import { compactDrawingElements } from "../../server/mcp-read";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMcpRequestHandler } from "../../server/mcp";
import { createRequestHandler } from "../../server/routes";
import { createRuntime } from "../../server/runtime";
import { createServerConfig } from "../../server/config";

test("compact reading preserves labels, geometry and connections without paint/editor noise", () => {
  const { elements } = createDrawingBatch([
    { id: "a", type: "rectangle", x: 20, y: 30, width: 100, height: 80, text: "开始", labelId: "caption", rotation: 30 },
    { id: "b", type: "ellipse", x: 300, y: 30, width: 100, height: 80, text: "结束" },
    { id: "edge", type: "arrow", points: [[120, 70], [200, 70], [300, 70]], startBinding: { elementId: "a" }, endBinding: { elementId: "b" } },
    { id: "free", type: "text", x: 0, y: 200, text: "注释" },
  ].map((spec) => drawingElementSchema.parse(spec)));
  const snapshot = structuredClone(elements);
  const compact = compactDrawingElements(elements);
  expect(compact.elements).toHaveLength(4);
  expect(compact.labelOwners.get("caption")).toBe("a");
  expect(compact.elements[0]).toMatchObject({ id: "a", text: "开始", labelId: "caption", x: 20, y: 30, width: 100, height: 80, rotation: 30 });
  expect(compact.elements[2]).toMatchObject({ id: "edge", startBinding: { elementId: "a" }, endBinding: { elementId: "b" } });
  expect(compact.elements[3]).toMatchObject({ id: "free", text: "注释" });
  for (const element of compact.elements) {
    expect(element).not.toHaveProperty("strokeColor");
    expect(element).not.toHaveProperty("angle");
    expect(element).not.toHaveProperty("w");
  }
  expect(JSON.stringify(compact.elements).length).toBeLessThan(JSON.stringify(elements.map(compactElement)).length * 0.6);
  expect(elements).toEqual(snapshot);
  // Orphan labels remain visible instead of turning a damaged scene into missing content.
  const orphan = elements.find((element) => element.id === "caption")!;
  expect(compactDrawingElements([orphan]).elements[0]).toMatchObject({ id: "caption", text: "开始", containerId: "a" });
});

test("default compact reads filter folded labels, paginate semantic objects and work in batches", async () => {
  const directory = path.join(os.tmpdir(), `excalidraw-mcp-read-${crypto.randomUUID()}`);
  const runtime = createRuntime({ dbPath: path.join(directory, "database.db"), filesDir: path.join(directory, "files"),
    config: createServerConfig({ NODE_ENV: "test", ALLOW_ANONYMOUS: "true", MCP_TOKEN: "compact-test" }) });
  const handler = createMcpRequestHandler(runtime, createRequestHandler(runtime));
  const client = new Client({ name: "compact-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp/compact-test"), {
    fetch: async (input, init) => handler.fetch(new Request(input, init)),
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ ok: true });
    return response.structuredContent as Record<string, any>;
  };
  try {
    await client.connect(transport);
    const created = await call("create_board", { name: "紧凑语义",
      elements: [
        { id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 80, text: "待办", labelId: "caption" },
        { id: "b", type: "ellipse", x: 200, y: 0, width: 100, height: 80, text: "完成" },
        { id: "edge", type: "arrow", points: [[100, 40], [200, 40]], startBinding: { elementId: "a" }, endBinding: { elementId: "b" } },
      ] });
    const compact = await call("get_board", { boardId: created.boardId });
    expect(compact).toMatchObject({ matchedCount: 3, elementCount: 5, truncated: false, pointCoordinateSystem: "absolute" });
    expect(compact.elements.map((element: any) => element.id)).toEqual(["a", "b", "edge"]);
    const selected = await call("get_board", { boardId: created.boardId, elementIds: ["caption", "a", "missing"] });
    expect(selected.elements).toHaveLength(1);
    expect(selected.elements[0]).toMatchObject({ id: "a", labelId: "caption", text: "待办" });
    expect(selected.notFoundIds).toEqual(["missing"]);
    const searched = await call("get_board", { boardId: created.boardId, query: "待办", type: "rectangle" });
    expect(searched.elements.map((element: any) => element.id)).toEqual(["a"]);
    const first = await call("get_board", { boardId: created.boardId, view: "compact", limit: 1 });
    expect(first).toMatchObject({ matchedCount: 3, nextOffset: 1, truncated: true });
    const next = await call("get_board", { boardId: created.boardId, offset: first.nextOffset });
    expect(next.elements.map((element: any) => element.id)).toEqual(["b", "edge"]);
    const batch = await call("get_boards_batch", { boardIds: [created.boardId], maxChars: 1000 });
    expect(batch.boards[0].elements).toEqual(compact.elements);
    expect(batch.truncated).toBe(false);
    const styled = await call("get_board", { boardId: created.boardId, view: "elements" });
    expect(styled.elements).toHaveLength(5);
    expect(styled.elements[0]).toHaveProperty("strokeColor");
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(styled).length * 0.6);
  } finally {
    await client.close();
    await handler.close();
    runtime.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
