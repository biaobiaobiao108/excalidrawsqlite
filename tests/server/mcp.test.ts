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
  expect(result.content).toEqual([{ type: "text", text: "操作成功；详情见 structuredContent。" }]);
  const data = result.structuredContent as Record<string, unknown>;
  const records = [data, ...["items", "boards", "results"].flatMap((key) =>
    Array.isArray(data[key]) ? data[key] as Record<string, unknown>[] : [])];
  for (const record of records) {
    if (typeof record.boardId === "string") {
      for (const key of ["id", "element_count", "folder_id", "folder_name", "created_at", "updated_at", "last_opened_at", "deleted_at"])
        expect(record).not.toHaveProperty(key);
    }
  }
  if (typeof data.addedCount === "number" && data.elementMap !== undefined) {
    expect(data).not.toHaveProperty("elementIds");
    expect(Array.isArray(data.elementMap)).toBe(true);
    expect(data.elementMap).toHaveLength((data.requestedElementIds as unknown[]).length);
    expect(data.addedCount).toBe((data.requestedElementIds as unknown[]).length + (data.generatedElementIds as unknown[]).length);
  }
  return result.structuredContent as T;
};

describe("Excalidraw MCP endpoint", () => {
  it("detects escaped grid text through its native group and keeps shape collisions advisory", async () => {
    const directory = path.join(os.tmpdir(), `excalidraw-mcp-group-overflow-${crypto.randomUUID()}`);
    const runtime = createRuntime({ dbPath: path.join(directory, "database.db"), filesDir: path.join(directory, "files"),
      config: createServerConfig({ NODE_ENV: "test", ALLOW_ANONYMOUS: "true", MCP_TOKEN: "group-overflow-test" }) });
    resources.push({ runtime, directory });
    const handler = createMcpRequestHandler(runtime, createRequestHandler(runtime));
    const client = new Client({ name: "group-overflow-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp/group-overflow-test"), {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
    });
    const invoke = async <T>(name: string, args: Record<string, unknown>) =>
      toolResult<T>(await client.callTool({ name, arguments: args }));
    type Issue = { type: string; elementIds: string[]; severity: string; message: string; suggestedUpdate?: unknown };
    type Inspection = { revision: number; complete: boolean; issues: Issue[];
      checks: { text_overflow: { checkedPairs: number; skippedNoContainer: number } } };
    try {
      await client.connect(transport);
      const created = await invoke<{ boardId: string }>("create_layout", {
        name: "六张复杂卡片", columns: 3, cardWidth: 320,
        cards: [
          { id: "first", title: "长标题中文与 English 一起自动换行".repeat(3), body: "中文正文\n第二行 mixed English 123\n第三行" },
          { id: "second", title: "第二张", body: "中文 English mixed 内容与数字 2026".repeat(8) },
          { id: "third", title: "多行\n标题", body: "多行正文\n再一行\n第三行" },
          { id: "fourth", title: "", body: "仅正文仍有原生分组容器" },
          { id: "fifth", title: "仅标题", body: "" },
          { id: "sixth", title: "末张卡片", body: "短正文" },
        ],
      });
      const initial = await invoke<Inspection>("inspect_layout", { boardId: created.boardId, checks: ["text_overflow"] });
      expect(initial.complete).toBe(true);
      expect(initial.issues).toEqual([]);
      expect(initial.checks.text_overflow.checkedPairs).toBeGreaterThan(0);
      expect(initial.checks.text_overflow.skippedNoContainer).toBe(0);
      await invoke("update_board", { boardId: created.boardId, updates: [{ id: "first:body", dx: 1500 }] });
      const before = await invoke<Record<string, unknown>>("get_board", { boardId: created.boardId, view: "full" });
      const escaped = await invoke<Inspection>("inspect_layout", { boardId: created.boardId, checks: ["text_overflow"] });
      expect(escaped.complete).toBe(true);
      expect(escaped.issues).toContainEqual(expect.objectContaining({ type: "text_overflow",
        elementIds: expect.arrayContaining(["first:body", "first:background"]) }));
      expect(escaped.checks.text_overflow.checkedPairs).toBeGreaterThan(0);
      expect(escaped.checks.text_overflow.skippedNoContainer).toBe(0);
      expect(escaped.revision).toBe(before.revision as number);
      expect(await invoke("get_board", { boardId: created.boardId, view: "full" })).toEqual(before);
      await invoke("update_board", { boardId: created.boardId, updates: [{ id: "first:body", dx: -1500 }] });
      expect((await invoke<Inspection>("inspect_layout", { boardId: created.boardId, checks: ["text_overflow"] })).issues).toEqual([]);
      await invoke("add_elements", { boardId: created.boardId,
        elements: [{ type: "text", id: "free-text", x: 2000, y: 2000, text: "普通独立文字" }] });
      const withFree = await invoke<Inspection>("inspect_layout", { boardId: created.boardId, checks: ["text_overflow"] });
      expect(withFree.issues).toEqual([]);
      expect(withFree.checks.text_overflow.skippedNoContainer).toBe(1);

      const collisionBoard = await invoke<{ boardId: string }>("create_board", {
        name: "装饰阴影与实际碰撞", elements: [
          { type: "rectangle", id: "background", x: 0, y: 0, width: 400, height: 560,
            fillStyle: "solid", backgroundColor: "white" },
          { type: "rectangle", id: "shadow", x: 6, y: 6, width: 400, height: 560,
            fillStyle: "solid", backgroundColor: "#dddddd" },
          { type: "rectangle", id: "overlap-a", x: 1000, y: 0, width: 120, height: 120 },
          { type: "rectangle", id: "overlap-b", x: 1040, y: 0, width: 120, height: 120 },
        ],
      });
      const collisions = await invoke<{ complete: boolean; issues: Issue[] }>("inspect_layout",
        { boardId: collisionBoard.boardId, checks: ["element_collision"] });
      expect(collisions.complete).toBe(true);
      expect(collisions.issues).toContainEqual(expect.objectContaining({ type: "element_collision", severity: "warning",
        elementIds: expect.arrayContaining(["background", "shadow"]) }));
      expect(collisions.issues).toContainEqual(expect.objectContaining({ type: "element_collision", severity: "warning",
        elementIds: expect.arrayContaining(["overlap-a", "overlap-b"]) }));
      for (const issue of collisions.issues) {
        expect(issue).not.toHaveProperty("suggestedUpdate");
        expect(issue.message).not.toContain("566");
      }
    } finally {
      await client.close();
      await handler.close();
    }
  });

  it("creates measured grouped layouts and retries creation without duplicating boards or folders", async () => {
    const directory = path.join(os.tmpdir(), `excalidraw-mcp-layout-${crypto.randomUUID()}`);
    const runtime = createRuntime({ dbPath: path.join(directory, "database.db"), filesDir: path.join(directory, "files"),
      config: createServerConfig({ NODE_ENV: "test", ALLOW_ANONYMOUS: "true", MCP_TOKEN: "layout-test" }) });
    resources.push({ runtime, directory });
    const handler = createMcpRequestHandler(runtime, createRequestHandler(runtime));
    const client = new Client({ name: "layout-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp/layout-test"), {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
    });
    const invoke = async <T>(name: string, args: Record<string, unknown>) =>
      toolResult<T>(await client.callTool({ name, arguments: args }));
    type Element = { id: string; x: number; y: number; width: number; height: number; groupIds: string[];
      text?: string; startBinding?: { elementId: string } | null; endBinding?: { elementId: string } | null };
    type Board = { boardId: string; revision: number; elements: Element[] };
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["measure_text", "create_layout", "inspect_layout"]));
      expect(tools.tools.find((tool) => tool.name === "measure_text")?.annotations?.readOnlyHint).toBe(true);
      const measured = await invoke<{ text: string; width: number; height: number; estimated: boolean }>("measure_text",
        { text: "中文自动换行测量".repeat(4), width: 100, fontSize: 18, fontFamily: "system" });
      expect(measured.estimated).toBe(true);
      expect(measured.text).toContain("\n");
      const layoutArgs = { name: "知识卡片", idempotencyKey: "grid-retry", columns: 2, cardWidth: 240,
        cards: [{ id: "one", title: "第一张", body: "自动换行中文正文".repeat(12) }, { id: "two", title: "第二张", body: "短正文" }] };
      const layout = await invoke<{ boardId: string; revision: number; addedCount: number;
        cards: Array<{ groupId: string; elementIds: string[] }> }>("create_layout", layoutArgs);
      expect(layout.addedCount).toBe(6);
      const first = await invoke<Board>("get_board", { boardId: layout.boardId, view: "full" });
      for (const card of layout.cards) {
        expect(card.elementIds).toHaveLength(3);
        expect(first.elements.filter((element) => card.elementIds.includes(element.id)).every((element) => element.groupIds.includes(card.groupId))).toBe(true);
      }
      const inspection = await invoke<{ issues: unknown[]; complete: boolean }>("inspect_layout",
        { boardId: layout.boardId, checks: ["text_overlap", "text_overflow"] });
      expect(inspection.complete).toBe(true);
      expect(inspection.issues).toEqual([]);
      const replay = await invoke<Record<string, unknown>>("create_layout", { ...layoutArgs, responseMode: "ids" });
      expect(replay).toMatchObject({ boardId: layout.boardId, revision: 1, addedCount: 0, idempotentReplay: true, elementCount: 6 });
      expect(replay).not.toHaveProperty("cards");
      expect(replay).not.toHaveProperty("elementMap");
      expect((await invoke<Board>("get_board", { boardId: layout.boardId, view: "full" })).elements).toEqual(first.elements);
      await invoke("add_elements", { boardId: layout.boardId, elements: [{ type: "text", id: "measured", x: 1000, y: 1000,
        text: "中文自动换行测量".repeat(4), width: 100, fontSize: 18, fontFamily: "system" }] });
      const next = await invoke<Board>("get_board", { boardId: layout.boardId, view: "full" });
      expect(next.elements.find((element) => element.id === "measured")).toMatchObject({ width: measured.width, height: measured.height, text: measured.text });
      expect(await invoke("create_layout", layoutArgs)).toMatchObject({ boardId: layout.boardId, revision: next.revision, addedCount: 0, elementCount: 7 });

      const drawingArgs = { name: "有分组的画板", folderName: "幂等文件夹", idempotencyKey: "drawing-retry", autoBind: true,
        elements: [
          { type: "rectangle", id: "a", groupIds: ["inner", "outer"], x: 0, y: 0, width: 100, height: 100, text: "节点", labelId: "caption" },
          { type: "text", id: "title", groupId: "inner", x: 0, y: 150, text: "独立标题" },
          { type: "ellipse", id: "b", x: 300, y: 0, width: 100, height: 100 },
          { type: "arrow", id: "edge", points: [[110, 50], [290, 50]] },
        ] };
      const drawing = await invoke<{ boardId: string; autoBinding: { bindings: unknown[] } }>("create_board", drawingArgs);
      expect(drawing.autoBinding.bindings).toHaveLength(2);
      const native = await invoke<Board>("get_board", { boardId: drawing.boardId, view: "full" });
      expect(native.elements.find((element) => element.id === "edge")).toMatchObject({ startBinding: { elementId: "a" }, endBinding: { elementId: "b" } });
      const writable = await invoke<Board>("get_board", { boardId: drawing.boardId, view: "input" });
      expect(writable.elements.find((element) => element.id === "a")?.groupIds).toEqual(["inner", "outer"]);
      const copied = await invoke<{ groupIdMap: Record<string, string>; idMap: Record<string, string> }>("copy_elements",
        { boardId: drawing.boardId, elementIds: ["a", "title"], dx: 0, dy: 300 });
      expect(copied.groupIdMap.inner).not.toBe("inner");
      const copiedNative = await invoke<Board>("get_board", { boardId: drawing.boardId, view: "full" });
      expect(copiedNative.elements.find((element) => element.id === copied.idMap.a)?.groupIds)
        .toEqual([copied.groupIdMap.inner, copied.groupIdMap.outer]);
      const folder = runtime.db.query("SELECT id FROM folders WHERE name = ?").get("幂等文件夹") as { id: string };
      await invoke("delete_folder", { folderId: folder.id, confirm: true });
      const retry = await invoke<Record<string, unknown>>("create_board", { ...drawingArgs, responseMode: "ids" });
      expect(retry).toMatchObject({ boardId: drawing.boardId, idempotentReplay: true, addedCount: 0 });
      expect(retry).not.toHaveProperty("autoBinding");
      expect(runtime.db.query("SELECT COUNT(*) AS count FROM folders WHERE name = ?").get("幂等文件夹")).toEqual({ count: 0 });
      const conflict = await client.callTool({ name: "create_board", arguments: { ...drawingArgs, name: "改参数" } });
      expect(conflict.structuredContent).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });
      await invoke("add_elements", { boardId: drawing.boardId, elements: [{ type: "arrow", id: "legacy", points: [[110, 50], [290, 50]] }] });
      const added = await invoke<{ autoBinding: { bindings: Array<{ elementId: string; endpoint: string; targetId: string }> } }>("add_elements", {
        boardId: drawing.boardId, autoBind: true, elements: [{ type: "arrow", id: "new-edge", points: [[110, 50], [290, 50]], startBinding: { elementId: "a" } }],
      });
      expect(added.autoBinding.bindings).toEqual([{ elementId: "new-edge", endpoint: "endBinding", targetId: "b" }]);
      const updated = await invoke<{ autoBinding: { bindings: Array<{ elementId: string }> } }>("update_board", {
        boardId: drawing.boardId, autoBind: true, elements: [{ type: "arrow", id: "updated-edge", points: [[110, 50], [290, 50]] }],
      });
      expect(updated.autoBinding.bindings).toHaveLength(2);
      const attached = await invoke<Board>("get_board", { boardId: drawing.boardId, view: "full" });
      expect(attached.elements.find((element) => element.id === "legacy")).toMatchObject({ startBinding: null, endBinding: null });
      expect(attached.elements.find((element) => element.id === "new-edge")).toMatchObject({ startBinding: { elementId: "a" }, endBinding: { elementId: "b" } });

      const diagramArgs = { name: "流程图重试", idempotencyKey: "diagram-retry", nodes: [{ id: "node", title: "节点" }] };
      const diagram = await invoke<{ boardId: string }>("create_diagram", diagramArgs);
      expect(await invoke("create_diagram", { ...diagramArgs, responseMode: "ids" })).toMatchObject({ boardId: diagram.boardId, addedCount: 0, idempotentReplay: true });
      const crossToolConflict = await client.callTool({ name: "create_board", arguments: { name: diagramArgs.name, idempotencyKey: diagramArgs.idempotencyKey } });
      expect(crossToolConflict.structuredContent).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });
      expect(runtime.db.query("SELECT COUNT(*) AS count FROM scenes").get()).toEqual({ count: 3 });
    } finally {
      await client.close();
      await handler.close();
    }
    expect(runtime.sessions.size).toBe(0);
  });

  it("inspects selected layout checks through the SDK without changing the board", async () => {
    const directory = path.join(os.tmpdir(), `excalidraw-mcp-inspect-${crypto.randomUUID()}`);
    const runtime = createRuntime({ dbPath: path.join(directory, "database.db"), filesDir: path.join(directory, "files"),
      config: createServerConfig({ NODE_ENV: "test", ALLOW_ANONYMOUS: "true", MCP_TOKEN: "inspect-test" }) });
    resources.push({ runtime, directory });
    const handler = createMcpRequestHandler(runtime, createRequestHandler(runtime));
    const client = new Client({ name: "inspect-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp/inspect-test"), {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
    });
    type Inspection = { boardId: string; revision: number; complete: boolean;
      summary: { errors: number; warnings: number };
      issues: Array<{ type: string; severity: string; elementIds: string[]; message: string; suggestion?: string;
        metrics?: { overlapRatio?: number }; suggestedUpdate?: { id: string; dx: number; dy: number } }> };
    const invoke = async <T>(name: string, args: Record<string, unknown>) =>
      toolResult<T>(await client.callTool({ name, arguments: args }));
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const tool = listed.tools.find((item) => item.name === "inspect_layout");
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      const created = await invoke<{ boardId: string; revision: number }>("create_board", {
        name: "检查布局", elements: [
          { type: "text", id: "first", x: 0, y: 0, text: "重叠的第一段文字" },
          { type: "text", id: "second", x: 0, y: 0, text: "重叠的第二段文字" },
          { type: "rectangle", id: "tiny", x: 500, y: 0, width: 80, height: 20,
            text: "绑定文字太长\n第二行\n第三行\n第四行", labelId: "overflow-label" },
          { type: "arrow", id: "decoration", points: [[100, 500], [200, 500]] },
        ],
      });
      const before = await invoke<Record<string, unknown>>("get_board", { boardId: created.boardId, view: "full" });
      const full = await invoke<Inspection>("inspect_layout", { boardId: created.boardId });
      expect(full.boardId).toBe(created.boardId);
      expect(full.revision).toBe(created.revision);
      expect(full.complete).toBe(true);
      expect(full.summary.errors + full.summary.warnings).toBe(full.issues.length);
      expect(full.issues).toContainEqual(expect.objectContaining({ type: "text_overlap", elementIds: expect.arrayContaining(["first", "second"]) }));
      expect(full.issues.some((issue) => issue.type === "text_overflow" && issue.elementIds.includes("overflow-label"))).toBe(true);
      expect(full.issues.some((issue) => issue.type === "arrow_connection" && issue.elementIds.includes("decoration"))).toBe(false);
      for (const issue of full.issues) {
        expect(["text_overlap", "text_overflow", "element_collision", "arrow_connection"]).toContain(issue.type);
        expect(["warning", "error"]).toContain(issue.severity);
        expect(issue.message.length).toBeGreaterThan(0);
      }
      const textOnly = await invoke<Inspection>("inspect_layout", { boardId: created.boardId, checks: ["text_overlap"] });
      expect(textOnly.issues.length).toBeGreaterThan(0);
      expect(textOnly.issues.every((issue) => issue.type === "text_overlap")).toBe(true);
      const after = await invoke<Record<string, unknown>>("get_board", { boardId: created.boardId, view: "full" });
      expect(after).toEqual(before);
      const revision = runtime.db.query("SELECT revision FROM scenes WHERE id = ?").get(created.boardId);
      expect(revision).toEqual({ revision: created.revision });
      for (const checks of [["unknown"], []]) {
        const invalid = await client.callTool({ name: "inspect_layout", arguments: { boardId: created.boardId, checks } });
        expect(invalid.isError).toBe(true);
      }
      const missing = await client.callTool({ name: "inspect_layout", arguments: { boardId: "missing-board" } });
      expect(missing.structuredContent).toMatchObject({ ok: false, error: { code: "SCENE_NOT_FOUND" } });
      const overlap = full.issues.find((issue) => issue.type === "text_overlap" && issue.elementIds.includes("second"))!;
      expect(overlap.metrics?.overlapRatio).toBeGreaterThan(0);
      expect(overlap.suggestedUpdate?.id).toBe("second");
      const moved = await invoke<{ revision: number }>("update_board", { boardId: created.boardId,
        updates: [overlap.suggestedUpdate!], expectedRevision: created.revision });
      const corrected = await invoke<Inspection>("inspect_layout", { boardId: created.boardId, checks: ["text_overlap"] });
      expect(corrected.revision).toBe(moved.revision);
      expect(corrected.issues.some((issue) => issue.elementIds.includes("first") && issue.elementIds.includes("second"))).toBe(false);
    } finally {
      await client.close();
      await handler.close();
    }
  });

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
        requestedElementIds: string[];
        generatedElementIds: string[];
        elementMap: Array<{ inputIndex: number; elementId: string; labelId?: string }>;
        revision: number;
      }>(
        await client.callTool({
          name: "add_elements",
          arguments: {
            responseMode: "ids",
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
      expect(added.requestedElementIds).toHaveLength(3);
      expect(added.generatedElementIds).toHaveLength(1);
      expect(added.elementMap).toEqual([
        { inputIndex: 0, elementId: added.requestedElementIds[0], labelId: added.generatedElementIds[0] },
        { inputIndex: 1, elementId: added.requestedElementIds[1] },
        { inputIndex: 2, elementId: added.requestedElementIds[2] },
      ]);
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
            elementIds: [added.requestedElementIds[2]],
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
            elementIds: [added.requestedElementIds[0]],
          },
        }),
      );
      expect(removedShape.removedCount).toBe(2);
      expect(removedShape.revision).toBe(4);
      expect(removedShape).toMatchObject({ elementCount: 1, requestedRemovedCount: 1, cascadeRemovedCount: 1, notFoundIds: [] });
      const missingRemoval = toolResult(await client.callTool({ name: "remove_elements", arguments: {
        boardId: created.boardId, elementIds: ["ghost", "ghost"],
      } }));
      expect(missingRemoval).toMatchObject({ removedCount: 0, requestedRemovedCount: 0, cascadeRemovedCount: 0,
        notFoundIds: ["ghost"], elementCount: 1, revision: 4, noop: true });
      const missingBatchRemoval = toolResult(await client.callTool({ name: "update_board", arguments: {
        boardId: created.boardId, removeElementIds: ["ghost"],
      } }));
      expect(missingBatchRemoval).toMatchObject({ removedCount: 0, notFoundIds: ["ghost"], elementCount: 1, revision: 4, noop: true });

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
      const complete = toolResult<{ boardId: string; revision: number; addedCount: number; requestedElementIds: string[]; generatedElementIds: string[] }>(
        await client.callTool({
          name: "create_board",
          arguments: { responseMode: "ids", name: "一次完成", backgroundColor: "#fefefe", elements: Array.from({ length: 301 }, (_, index) => ({
            type: "rectangle", x: index * 120, y: 0, width: 100, height: 60, text: "节点",
          })) },
        }),
      );
      expect(complete.revision).toBe(1);
      expect(complete.addedCount).toBe(602);
      expect(complete.requestedElementIds).toHaveLength(301);
      expect(complete.generatedElementIds).toHaveLength(301);
      expect(complete).not.toHaveProperty("elements");

      const summary = toolResult<{ elementCount: number; revision: number; createdAt: number; updatedAt: number }>(await client.callTool({
        name: "get_board", arguments: { boardId: complete.boardId, view: "summary" },
      }));
      expect(summary.elementCount).toBe(602);
      expect(summary.createdAt).toBeGreaterThan(0);
      expect(summary.updatedAt).toBeGreaterThan(0);
      expect(summary).not.toHaveProperty("elements");

      const selected = toolResult<{ elements: Array<{ id: string; seed?: number }>; notFoundIds: string[] }>(await client.callTool({
        name: "get_board", arguments: { boardId: complete.boardId, elementIds: [complete.requestedElementIds[0], "missing"] },
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

      const updated = toolResult<{ revision: number; addedCount: number; removedCount: number; elementMap: Array<{ inputIndex: number; elementId: string }> }>(await client.callTool({
        name: "update_board", arguments: { responseMode: "ids", boardId: complete.boardId, expectedRevision: 1, name: "已修改",
          removeElementIds: [complete.requestedElementIds[0], "ghost"], elements: [{ id: "replacement", type: "text", x: 0, y: 0, text: "替换内容" }] },
      }));
      expect(updated).toMatchObject({ revision: 2, addedCount: 1, removedCount: 2, requestedRemovedCount: 1,
        cascadeRemovedCount: 1, notFoundIds: ["ghost"], elementCount: 601 });
      expect(updated.elementMap).toEqual([{ inputIndex: 0, elementId: "replacement" }]);
      const changed = toolResult<{ name: string; thumbnail_file_id: string | null; appState: { viewBackgroundColor: string }; elements: Array<{ id: string }> }>(await client.callTool({
        name: "get_board", arguments: { boardId: complete.boardId, view: "full" },
      }));
      expect(changed.name).toBe("已修改");
      expect(changed).not.toHaveProperty("thumbnail_file_id");
      expect(await (await apiHandler(new Request(`http://test.local/api/scenes/${complete.boardId}`))).json())
        .toHaveProperty("thumbnail_file_id", null);
      expect(changed.appState.viewBackgroundColor).toBe("#fefefe");
      expect(changed.elements).toHaveLength(601);
      expect(changed.elements.some((element) => element.id === complete.generatedElementIds[0])).toBe(false);

      for (const name of ["add_elements", "remove_elements", "update_board"]) {
        const conflict = await client.callTool({ name, arguments: { boardId: complete.boardId, expectedRevision: 1,
          ...(name === "remove_elements" ? { elementIds: [complete.requestedElementIds[1]] }
            : { elements: [{ type: "text", x: 0, y: 0, text: "不会写入" }] }) } });
        expect(conflict.isError).not.toBe(true);
        expect(conflict.structuredContent).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
      }
      const emptyUpdate = await client.callTool({ name: "update_board", arguments: { boardId: complete.boardId } });
      expect(emptyUpdate.structuredContent).toMatchObject({ ok: false, error: { code: "EMPTY_UPDATE" } });
      const notFound = await client.callTool({ name: "get_board", arguments: { boardId: "missing" } });
      expect(notFound.structuredContent).toMatchObject({ ok: false });
      expect(notFound.content[0]).toMatchObject({ type: "text", text: "操作失败：画板不存在或已删除" });
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
      expect(summaryBatch.boards[0]).toMatchObject({ ok: true });
      expect(summaryBatch.boards[1]).toMatchObject({ ok: false, boardId: "missing", error: { code: "SCENE_NOT_FOUND" } });
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
        expect(clean).not.toHaveProperty("projectionIncomplete");
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
        name: "create_board", arguments: { responseMode: "ids", name: "直接复制可写输出", elements: input.elements },
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
        name: "add_elements", arguments: { responseMode: "ids", boardId: emptyTarget.boardId, elements: input.elements },
      }));
      expect(appended.requestedElementIds).toEqual(clone.requestedElementIds);
      const readable = toolResult<{ elements: Array<Record<string, unknown>>; pointCoordinateSystem: string }>(await client.callTool({
        name: "get_board", arguments: { boardId: clone.boardId, elementIds: ["connector"] },
      }));
      expect(readable.pointCoordinateSystem).toBe("absolute");
      expect(readable.elements[0].points).toEqual(edge.points);
      const labelBoard = toolResult<{ boardId: string; revision: number; generatedElementIds: string[] }>(await client.callTool({
        name: "create_board", arguments: { responseMode: "ids", name: "标签边界", elements: [{ id: "rr", type: "rectangle", x: 0, y: 0, width: 100, height: 80, text: "短标签" }] },
      }));
      const labelStyleUpdate = toolResult<{ revision: number }>(await client.callTool({ name: "update_element", arguments: {
        boardId: labelBoard.boardId, update: { id: "rr", labelId: labelBoard.generatedElementIds[0],
          labelStyle: { fontSize: 24, strokeColor: "#f00", opacity: 70 } }, expectedRevision: labelBoard.revision,
      } }));
      const styledLabel = toolResult<{ elements: Array<Record<string, unknown>> }>(await client.callTool({ name: "get_board", arguments: {
        boardId: labelBoard.boardId, view: "input",
      } }));
      expect(styledLabel.elements[0]).toMatchObject({ id: "rr", labelId: labelBoard.generatedElementIds[0],
        labelStyle: { fontSize: 24, strokeColor: "#f00", opacity: 70 } });
      expect(styledLabel.elements[0].strokeColor).not.toBe("#f00");
      const labelNoop = toolResult<{ revision: number; noop: boolean }>(await client.callTool({ name: "update_element", arguments: {
        boardId: labelBoard.boardId, update: { id: "rr", labelStyle: { fontSize: 24, strokeColor: "#f00", opacity: 70 } },
      } }));
      expect(labelNoop).toMatchObject({ revision: labelStyleUpdate.revision, noop: true });
      const labelViaBoard = toolResult<{ revision: number; updatedCount: number }>(await client.callTool({ name: "update_board", arguments: {
        boardId: labelBoard.boardId, updates: [{ id: "rr", labelStyle: { fontSize: 20 } }], expectedRevision: labelStyleUpdate.revision,
      } }));
      expect(labelViaBoard.updatedCount).toBe(1);
      const wrongLabelId = await client.callTool({ name: "update_element", arguments: {
        boardId: labelBoard.boardId, update: { id: "rr", labelId: "rename-is-not-an-update" },
      } });
      expect(wrongLabelId.structuredContent).toMatchObject({ ok: false, error: { code: "INVALID_ELEMENT_UPDATE" } });
      const labelUpdate = toolResult<{ revision: number }>(await client.callTool({ name: "update_element", arguments: {
        boardId: labelBoard.boardId, update: { id: "rr", text: "字".repeat(2_000) }, expectedRevision: labelViaBoard.revision,
      } }));
      for (const id of ["rr", labelBoard.generatedElementIds[0]]) {
        const tooLong = await client.callTool({ name: "update_element", arguments: {
          boardId: labelBoard.boardId, update: { id, text: "字".repeat(2_001) }, expectedRevision: labelUpdate.revision,
        } });
        expect(tooLong.structuredContent).toMatchObject({ ok: false, error: { code: "INVALID_ELEMENT_UPDATE" } });
      }
      const validLabel = toolResult<{ revision: number; elements: unknown[]; unsupportedElementIds: string[]; warnings: unknown[] }>(await client.callTool({
        name: "get_board", arguments: { boardId: labelBoard.boardId, view: "input" },
      }));
      expect(validLabel.revision).toBe(labelUpdate.revision);
      expect(validLabel.elements).toHaveLength(1);
      expect(validLabel.unsupportedElementIds).toEqual([]);
      expect(validLabel.warnings).toEqual([]);
      const legacy = await (await apiHandler(new Request(`http://test.local/api/scenes/${labelBoard.boardId}`))).json() as { elements: Array<Record<string, unknown>> };
      for (const element of legacy.elements) if (element.type === "text") element.originalText = "字".repeat(2_001);
      runtime.db.query("UPDATE scenes SET elements = ? WHERE id = ?").run(JSON.stringify(legacy.elements), labelBoard.boardId);
      const incompleteLabel = toolResult<{ elements: unknown[]; unsupportedElementIds: string[]; warnings: Array<{ message: string }>; truncated: boolean }>(await client.callTool({
        name: "get_board", arguments: { boardId: labelBoard.boardId, view: "input" },
      }));
      expect(incompleteLabel.elements).toHaveLength(0);
      expect(incompleteLabel.unsupportedElementIds).toContain("rr");
      expect(incompleteLabel.truncated).toBe(false);
      expect(incompleteLabel.warnings.some((warning) => warning.message.includes("2000"))).toBe(true);
      const fixedBoard = toolResult<{ boardId: string }>(await client.callTool({
        name: "create_board", arguments: { name: "固定宽度文字", elements: [
          { type: "text", id: "paragraph", x: 20, y: 30, width: 100, fontSize: 20, text: "中文段落自动换行测试内容" },
        ] },
      }));
      const fixedRead = toolResult<{ elements: Array<Record<string, unknown>> }>(await client.callTool({
        name: "get_board", arguments: { boardId: fixedBoard.boardId, view: "full" },
      }));
      expect(fixedRead.elements[0]).toMatchObject({ width: 100, autoResize: false });
      expect(String(fixedRead.elements[0].text)).toContain("\n");
      toolResult(await client.callTool({ name: "update_board", arguments: {
        boardId: fixedBoard.boardId, updates: [{ id: "paragraph", width: 200 }],
      } }));
      const fixedInput = toolResult<{ elements: Array<Record<string, unknown>>; warnings: unknown[] }>(await client.callTool({
        name: "get_board", arguments: { boardId: fixedBoard.boardId, view: "input" },
      }));
      expect(fixedInput.elements[0]).toMatchObject({ width: 200, autoResize: false, text: "中文段落自动换行测试内容" });
      expect(fixedInput.warnings).toEqual([]);
    } finally {
      await client.close();
      await mcpHandler.close();
    }

    expect(runtime.sessions.size).toBe(0);
  });
});
