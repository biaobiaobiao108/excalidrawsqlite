import { expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServerConfig } from "../../server/config";
import { createMcpRequestHandler } from "../../server/mcp";
import { createRequestHandler } from "../../server/routes";
import { createRuntime } from "../../server/runtime";

test("drawing iterations return final positions, warn about overlaps and combine additions with updates", async () => {
  const directory = path.join(os.tmpdir(), `excalidraw-mcp-experience-${crypto.randomUUID()}`);
  const runtime = createRuntime({ dbPath: path.join(directory, "database.db"), filesDir: path.join(directory, "files"),
    config: createServerConfig({ NODE_ENV: "test", ALLOW_ANONYMOUS: "true", MCP_ALLOW_LEGACY_PATH_TOKEN: "true", MCP_TOKEN: "experience-test" }) });
  const handler = createMcpRequestHandler(runtime, createRequestHandler(runtime));
  const client = new Client({ name: "experience-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp/experience-test"), {
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
    const created = await call("create_board", { name: "体验回归", elements: [
      { id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 80, text: "起点", labelId: "caption" },
      { id: "b", type: "rectangle", x: 300, y: 0, width: 100, height: 80 },
    ] });
    const moved = await call("update_element", { boardId: created.boardId, update: { id: "a", dx: 300 } });
    expect(moved).toMatchObject({ elementId: "a", x: 300, y: 0, width: 100, height: 80, label: { id: "caption" } });
    expect(moved.warnings).toContainEqual(expect.objectContaining({ code: "ELEMENT_OVERLAP", elementId: "a", otherElementId: "b" }));
    const full = await call("get_board", { boardId: created.boardId, view: "full" });
    const label = full.elements.find((element: any) => element.id === "caption");
    expect(moved.label).toEqual({ id: label.id, x: label.x, y: label.y, width: label.width, height: label.height });
    const noop = await call("update_element", { boardId: created.boardId, update: { id: "a", dx: 0 } });
    expect(noop).toMatchObject({ noop: true, revision: moved.revision, x: 300, y: 0 });
    const copied = await call("copy_elements", { boardId: created.boardId, elementIds: ["a"], dx: 0, dy: 0 });
    expect(copied.warnings.some((warning: any) => warning.code === "ELEMENT_OVERLAP" && warning.elementId === copied.idMap.a)).toBe(true);
    const combined = await call("update_board", { boardId: created.boardId, elements: [
      { id: "new-node", type: "rectangle", x: 600, y: 0, width: 100, height: 80 },
    ], updates: [{ id: "new-node", text: "一次新增并修改" }, { id: "b", dx: 300 }] });
    expect(combined.warnings.some((warning: any) => warning.code === "ELEMENT_OVERLAP")).toBe(true);
    const read = await call("get_board", { boardId: created.boardId, view: "input", elementIds: ["new-node", "b"] });
    expect(read.elements).toContainEqual(expect.objectContaining({ id: "new-node", text: "一次新增并修改" }));
    expect(read.elements).toContainEqual(expect.objectContaining({ id: "b", x: 600 }));
  } finally {
    await client.close();
    await handler.close();
    runtime.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
