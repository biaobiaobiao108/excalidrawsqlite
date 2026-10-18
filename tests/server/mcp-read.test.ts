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
    { id: "edge", type: "arrow", x: 120, y: 70, points: [[0, 0], [80, 0], [180, 0]], startBinding: { elementId: "a" }, endBinding: { elementId: "b" } },
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
        { id: "edge", type: "arrow", x: 100, y: 40, points: [[0, 0], [100, 0]], startBinding: { elementId: "a" }, endBinding: { elementId: "b" } },
      ] });
    const compact = await call("get_board", { boardId: created.boardId });
    expect(compact).toMatchObject({ matchedCount: 3, elementCount: 5, viewElementCount: 3,
      returnedElementCount: 3, truncated: false, pointCoordinateSystem: "relative" });
    expect(compact.elements.map((element: any) => element.id)).toEqual(["a", "b", "edge"]);
    const selected = await call("get_board", { boardId: created.boardId, elementIds: ["caption", "a", "missing"] });
    expect(selected.elements).toHaveLength(1);
    expect(selected).toMatchObject({ viewElementCount: 3, matchedCount: 1, returnedElementCount: 1 });
    expect(selected.elements[0]).toMatchObject({ id: "a", labelId: "caption", text: "待办" });
    expect(selected.notFoundIds).toEqual(["missing"]);
    const writableLabel = await call("get_board", { boardId: created.boardId, view: "input", elementIds: ["caption", "missing"] });
    expect(writableLabel.elements).toHaveLength(1);
    expect(writableLabel.elements[0]).toMatchObject({ id: "a", labelId: "caption" });
    expect(writableLabel.notFoundIds).toEqual(["missing"]);
    const unchanged = await call("update_board", { boardId: created.boardId, updates: writableLabel.elements });
    expect(unchanged).toMatchObject({ noop: true, revision: 1 });
    const searched = await call("get_board", { boardId: created.boardId, query: "待办", type: "rectangle" });
    expect(searched.elements.map((element: any) => element.id)).toEqual(["a"]);
    const first = await call("get_board", { boardId: created.boardId, view: "compact", limit: 1 });
    expect(first).toMatchObject({ viewElementCount: 3, returnedElementCount: 1, matchedCount: 3, nextOffset: 1, truncated: true });
    const next = await call("get_board", { boardId: created.boardId, offset: first.nextOffset });
    expect(next.elements.map((element: any) => element.id)).toEqual(["b", "edge"]);
    const batch = await call("get_boards_batch", { boardIds: [created.boardId], maxChars: 1000 });
    expect(batch.boards[0].elements).toEqual(compact.elements);
    expect(batch.truncated).toBe(false);
    const styled = await call("get_board", { boardId: created.boardId, view: "elements" });
    expect(styled.elements).toHaveLength(5);
    expect(styled.elements[0]).toHaveProperty("strokeColor");
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(styled).length * 0.6);
    const target = await call("create_board", { name: "复制目标" });
    const copied = await call("copy_elements", { boardId: created.boardId, targetBoardId: target.boardId,
      elementIds: ["caption", "edge"], dx: 40, dy: 50, expectedRevision: 1, sourceExpectedRevision: 1 });
    expect(copied).toMatchObject({ boardId: target.boardId, sourceBoardId: created.boardId, revision: 2, addedCount: 3 });
    const targetRead = await call("get_board", { boardId: target.boardId, view: "full" });
    expect(targetRead.elements.find((element: any) => element.id === copied.idMap.a)).toMatchObject({ x: 40, y: 50 });
    expect(targetRead.elements.find((element: any) => element.id === copied.idMap.edge)).toMatchObject({
      startBinding: { elementId: copied.idMap.a }, endBinding: null,
    });
    const rejected = await client.callTool({ name: "copy_elements", arguments: {
      boardId: created.boardId, targetBoardId: target.boardId, elementIds: ["edge"], externalBindings: "preserve",
    } });
    expect(rejected.structuredContent).toMatchObject({ ok: false, error: { code: "INVALID_COPY_BINDING" } });
    const conflict = await client.callTool({ name: "copy_elements", arguments: {
      boardId: created.boardId, targetBoardId: target.boardId, elementIds: ["a"], expectedRevision: 1,
    } });
    expect(conflict.structuredContent).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
  } finally {
    await client.close();
    await handler.close();
    runtime.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
