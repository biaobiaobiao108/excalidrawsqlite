import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { expect, it } from "bun:test";
import { createMcpRequestHandler } from "../../server/mcp";
import { createRequestHandler } from "../../server/routes";
import { createRuntime } from "../../server/runtime";
import { createServerConfig } from "../../server/config";

it("keeps normal receipts small, exposes IDs on demand and persists semantic diagrams once", async () => {
  const directory = path.join(
    os.tmpdir(),
    `mcp-efficiency-${crypto.randomUUID()}`,
  );
  const runtime = createRuntime({
    dbPath: path.join(directory, "db"),
    filesDir: path.join(directory, "files"),
    config: createServerConfig({
      NODE_ENV: "test",
      ALLOW_ANONYMOUS: "true",
      MCP_TOKEN: "efficiency",
    }),
  });
  const api = createRequestHandler(runtime);
  const writes: string[] = [];
  const handler = createMcpRequestHandler(runtime, async (req) => {
    if (req.method === "POST" || req.method === "PUT")
      writes.push(`${req.method} ${new URL(req.url).pathname}`);
    return api(req);
  });
  const client = new Client(
    { name: "efficiency-test", version: "1" },
    { versionNegotiation: { mode: "auto" } },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("http://test/mcp/efficiency"),
    {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
    },
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(response.structuredContent).toHaveProperty("ok", true);
    return response.structuredContent as Record<string, any>;
  };
  try {
    await client.connect(transport);
    const elements = Array.from({ length: 100 }, (_, i) => ({
      type: "rectangle",
      id: `node${i}`,
      x: i * 400,
      y: 0,
      width: 320,
      height: 100,
      text: `节点 ${i}`,
      strokeColor: "#AABBCC",
    }));
    const minimal = await call("create_board", { name: "精简", elements });
    expect(minimal.addedCount).toBe(200);
    expect(minimal.elementCount).toBe(200);
    expect(JSON.stringify(minimal).length).toBeLessThan(500);
    for (const key of [
      "elementMap",
      "requestedElementIds",
      "generatedElementIds",
      "createdAt",
      "updatedAt",
    ])
      expect(minimal).not.toHaveProperty(key);
    const ids = await call("create_board", {
      name: "ID回执",
      elements,
      responseMode: "ids",
    });
    expect(ids.elementMap).toHaveLength(100);
    expect(ids.requestedElementIds).toHaveLength(100);
    expect(ids.generatedElementIds).toHaveLength(100);
    const input = await call("get_board", {
      boardId: minimal.boardId,
      view: "input",
      elementIds: ["node0"],
    });
    expect(input.elements[0].strokeColor).toBe("#aabbcc");
    writes.length = 0;
    const added = await call("add_elements", {
      boardId: minimal.boardId,
      elements: [{ type: "text", x: 0, y: 0, text: "追加" }],
    });
    expect(added.addedCount).toBe(1);
    expect(added.elementCount).toBe(201);
    expect(added).not.toHaveProperty("elementMap");
    expect(writes).toEqual([`PUT /api/scenes/${minimal.boardId}`]);
    writes.length = 0;
    const updated = await call("update_board", {
      boardId: minimal.boardId,
      updates: [
        { id: "node0", text: "修改" },
        { id: "node1", x: 800 },
      ],
      elements: [{ type: "text", x: 0, y: 100, text: "批量追加" }],
      name: "一次修改",
    });
    expect(updated.updatedCount).toBe(2);
    expect(updated.addedCount).toBe(1);
    expect(updated).not.toHaveProperty("elementMap");
    expect(writes).toEqual([`PUT /api/scenes/${minimal.boardId}`]);
    writes.length = 0;
    const noop = await call("update_board", {
      boardId: minimal.boardId,
      updates: [{ id: "node0", text: "修改" }],
    });
    expect(noop.noop).toBe(true);
    expect(noop.revision).toBe(updated.revision);
    expect(writes).toEqual([]);
    const diagram = await call("create_diagram", {
      name: "流程",
      layout: "flowchart",
      favorite: true,
      nodes: [
        { id: "a", title: "开始" },
        { id: "b", title: "步骤" },
        { id: "c", title: "结束" },
      ],
    });
    expect(diagram.nodeCount).toBe(3);
    expect(diagram.edgeCount).toBe(2);
    expect(diagram.addedCount).toBe(8);
    expect(diagram).not.toHaveProperty("elementMap");
    expect(writes).toEqual(["POST /api/scenes"]);
    const diagramRead = await call("get_board", { boardId: diagram.boardId });
    expect(diagramRead.elements).toHaveLength(5);
    expect(
      diagramRead.elements.find((e: Record<string, unknown>) => e.id === "a")
        .text,
    ).toBe("开始");
    const edge = diagramRead.elements.find(
      (e: Record<string, unknown>) => e.type === "arrow",
    );
    expect(edge.startBinding.elementId).toBe("a");
    expect(edge.endBinding.elementId).toBe("b");
    expect(
      await call("get_board", { boardId: diagram.boardId, view: "summary" }),
    ).toHaveProperty("favorite", true);
    const tools = await client.listTools();
    const core = tools.tools.filter((tool) =>
      ["create_board", "add_elements", "update_board"].includes(tool.name),
    );
    expect(core).toHaveLength(3);
    expect(core.every((tool) => "$defs" in tool.inputSchema)).toBe(true);
    expect(
      JSON.stringify(tools.tools.find((tool) => tool.name === "create_diagram"))
        .length,
    ).toBeLessThan(6_000);
    const invalid = await client.callTool({
      name: "create_board",
      arguments: {
        name: "失败",
        elements: elements.map((element) => ({
          ...element,
          strokeColor: "invalid",
        })),
      },
    });
    expect(invalid.isError).toBe(true);
    const errors = invalid.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join(" ");
    expect(errors).toContain("elements.0.strokeColor");
    expect(errors).toContain("共 100 处");
    expect(errors.length).toBeLessThan(1_200);
  } finally {
    await client.close();
    await handler.close();
    runtime.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
