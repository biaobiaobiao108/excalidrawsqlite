import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "bun:test";
import { createMcpRequestHandler } from "../../server/mcp";
import { createRequestHandler } from "../../server/routes";
import { createRuntime } from "../../server/runtime";
import { createServerConfig } from "../../server/config";

const withMcp = async (run: (client: Client) => Promise<void>) => {
  const directory = path.join(os.tmpdir(), `excalidraw-mcp-report-${crypto.randomUUID()}`);
  const runtime = createRuntime({ dbPath: path.join(directory, "database.db"), filesDir: path.join(directory, "files"),
    config: createServerConfig({ NODE_ENV: "test", ALLOW_ANONYMOUS: "true", MCP_TOKEN: "report-test" }) });
  const handler = createMcpRequestHandler(runtime, createRequestHandler(runtime));
  const client = new Client({ name: "report-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp/report-test"), {
    fetch: (input, init) => handler.fetch(new Request(input, init)),
  });
  try { await client.connect(transport); await run(client); }
  finally { await client.close(); await handler.close(); runtime.db.close(); await rm(directory, { recursive: true, force: true }); }
};
type Data = Record<string, unknown>;
type Geometry = { elementId: string; height: number; lineHeight: number; lineHeightPx: number; lineCount: number };
type InputPage = { boardId: string; revision: number; elements: Data[]; elementGeometry: Geometry[];
  nextOffset: number | null; truncated: boolean; returnedElementCount: number };
type Inspection = { complete: boolean; issues: Array<{ type: string; elementIds: string[]; severityHint?: string }>;
  checks: { text_overflow: { status: string; checkedContainers: number; skippedNoContainer: number } } };
const read = async <T>(client: Client, name: string, args: Data): Promise<T> => {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ ok: true });
  return result.structuredContent as T;
};

it("reports unexecuted free-text overflow honestly and exposes bounded readonly input geometry", () => withMcp(async (client) => {
  const created = await read<{ boardId: string; revision: number }>(client, "create_board", {
    name: "无绑定文字容器", elements: [
      { type: "rectangle", id: "box", x: 0, y: 0, width: 60, height: 40, fillStyle: "solid", backgroundColor: "white" },
      { type: "text", id: "body", x: 10, y: 10, width: 100, text: "中文内容，混排 English！".repeat(8) },
    ],
  });
  const before = await read<{ revision: number; elements: Data[] }>(client, "get_board", { boardId: created.boardId, view: "full" });
  const untouched = await read<Inspection>(client, "inspect_layout", { boardId: created.boardId, checks: ["text_overflow"] });
  expect(untouched.complete).toBe(false);
  expect(["not_executed", "partial"]).toContain(untouched.checks.text_overflow.status);
  expect(untouched.checks.text_overflow.checkedContainers).toBe(0);
  expect(untouched.checks.text_overflow.skippedNoContainer).toBe(1);
  expect(untouched.issues).toEqual([]);
  const inferred = await read<Inspection>(client, "inspect_layout", {
    boardId: created.boardId, checks: ["text_overflow"], inferTextContainers: true,
  });
  expect(inferred.complete).toBe(true);
  expect(inferred.issues).toContainEqual(expect.objectContaining({ type: "text_overflow", elementIds: expect.arrayContaining(["body", "box"]) }));
  expect(await read(client, "get_board", { boardId: created.boardId, view: "full" })).toEqual(before);
  const input = await read<InputPage>(client, "get_board", { boardId: created.boardId, view: "input", elementIds: ["body"] });
  const native = before.elements.find((element) => element.id === "body")!;
  expect(input.elementGeometry).toEqual([{ elementId: "body", height: native.height as number, lineHeight: native.lineHeight as number,
    lineHeightPx: (native.fontSize as number) * (native.lineHeight as number), lineCount: (native.text as string).split("\n").length }]);
  expect(input.elements[0]).not.toHaveProperty("height");
  expect(input.elements[0]).not.toHaveProperty("lineHeight");
  expect(await read(client, "update_board", { boardId: created.boardId, updates: input.elements }))
    .toMatchObject({ noop: true, revision: created.revision, updatedCount: 0 });

  await read(client, "add_elements", { boardId: created.boardId, elements: Array.from({ length: 12 }, (_, index) => ({
    type: "text", id: `page-${index}`, x: index * 200, y: 1000, width: 100, text: "用于测试几何元数据的预算分页".repeat(10),
  })) });
  const page = await read<InputPage>(client, "get_board", { boardId: created.boardId, view: "input", type: "text", maxChars: 2400 });
  expect(JSON.stringify(page).length).toBeLessThanOrEqual(2400);
  expect(page.truncated).toBe(true);
  expect(page.nextOffset).toBe(page.elements.length);
  expect(page.elementGeometry.map((geometry) => geometry.elementId)).toEqual(page.elements.map((element) => element.id as string));
  expect(page.returnedElementCount).toBe(page.elementGeometry.length);
  const next = await read<InputPage>(client, "get_board", { boardId: created.boardId, view: "input", type: "text", offset: page.nextOffset, maxChars: 2400 });
  expect(JSON.stringify(next).length).toBeLessThanOrEqual(2400);
  expect(next.elementGeometry.map((geometry) => geometry.elementId)).toEqual(next.elements.map((element) => element.id as string));
  expect(next.elements.some((element) => page.elements.some((first) => first.id === element.id))).toBe(false);
  const batchResponse = await client.callTool({ name: "get_boards_batch", arguments: {
    boardIds: [created.boardId, "missing-report-board"], view: "input", maxChars: 4000,
  } });
  expect(batchResponse.isError).not.toBe(true);
  const batch = batchResponse.structuredContent as { ok: boolean; partial: boolean; boards: Array<InputPage & { ok: boolean; error?: Data }> };
  expect(batch).toMatchObject({ ok: true, partial: true });
  expect(JSON.stringify(batch).length).toBeLessThanOrEqual(4000);
  expect(batch.boards[0].ok).toBe(true);
  expect(batch.boards[0].elementGeometry.map((geometry) => geometry.elementId)).toEqual(batch.boards[0].elements.filter((element) => element.type === "text").map((element) => element.id as string));
  expect(batch.boards[1]).toMatchObject({ ok: false, error: { code: "SCENE_NOT_FOUND" } });
}));

it("returns native line heights, useful bounded diagnostic summaries and consistent tool errors", () => withMcp(async (client) => {
  for (const text of ["，", "👩🏽‍💻", "🇨🇳", "1️⃣"]) {
    const measured = await read<Data>(client, "measure_text", { text, fontSize: 20, fontFamily: "system" });
    expect(measured.width).toBeCloseTo(20, 8);
    expect(measured.lineHeightPx).toBeCloseTo((measured.lineHeight as number) * 20, 8);
    expect(measured.height).toBeCloseTo((measured.lineHeightPx as number) * (measured.lineCount as number), 8);
    expect(measured).not.toHaveProperty("lines");
  }
  const created = await read<{ boardId: string; revision: number }>(client, "create_board", {
    name: "摘要检查", elements: Array.from({ length: 6 }, (_, index) => ({ type: "text", id: `overlap-${index}`, x: 0, y: 0, text: "重叠文字" })),
  });
  const diagnostic = await client.callTool({ name: "inspect_layout", arguments: { boardId: created.boardId, checks: ["text_overlap"] } });
  expect(diagnostic.isError).not.toBe(true);
  const content = diagnostic.content.find((item) => item.type === "text");
  if (content?.type !== "text") throw new Error("missing diagnostic summary");
  const inspected = diagnostic.structuredContent as Inspection;
  expect(content.text.length).toBeLessThanOrEqual(1024);
  expect(content.text.split("\n")).toHaveLength(2);
  expect(content.text).toContain(`text_overlap×${inspected.issues.length}`);
  expect(content.text).toContain("最大几何重叠");
  const hint = inspected.issues.find((issue) => issue.severityHint)?.severityHint;
  expect(hint).toBeDefined();
  expect(content.text).toContain(hint!);
  expect(content.text.split("\n")[1].split("；").filter((entry) => entry.includes("/text_overlap")).length).toBeLessThanOrEqual(3);
  expect(content.text).not.toContain(JSON.stringify(diagnostic.structuredContent));
  await read(client, "update_board", { boardId: created.boardId, updates: [{ id: "overlap-0", dx: 200 }] });
  for (const [name, args, code] of [
    ["get_board", { boardId: "missing-report-board" }, "SCENE_NOT_FOUND"],
    ["update_board", { boardId: created.boardId, expectedRevision: created.revision, updates: [{ id: "overlap-1", dx: 1 }] }, "REVISION_CONFLICT"],
  ] as const) {
    const failed = await client.callTool({ name, arguments: args });
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toMatchObject({ ok: false, error: { code } });
    expect(failed.content.some((item) => item.type === "text" && item.text.includes("操作失败"))).toBe(true);
  }
  const invalidColor = await client.callTool({ name: "create_board", arguments: { name: "无效颜色", backgroundColor: "#GGGGGG" } });
  expect(invalidColor.isError).toBe(true);
  expect(invalidColor.content.some((item) => item.type === "text" && item.text.includes("颜色"))).toBe(true);
}));
