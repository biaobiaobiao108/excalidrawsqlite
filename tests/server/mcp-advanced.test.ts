import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { describe, expect, it } from "bun:test";
import { createMcpRequestHandler } from "../../server/mcp";
import { createRequestHandler } from "../../server/routes";
import { createRuntime } from "../../server/runtime";
import { createServerConfig } from "../../server/config";

type Element = {
  id: string;
  type: string;
  x: number;
  y: number;
  groupIds: string[];
  points?: number[][];
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
};
type Region = {
  regionId: string;
  backgroundId: string;
  titleId: string;
  groupId: string;
  nodeIds: string[];
  elementIds: string[];
};
type Board = { revision: number; elements: Element[] };

const withClient = async (
  run: (
    client: Client,
    invoke: <T>(
      name: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: T; text: string }>,
  ) => Promise<void>,
) => {
  const directory = path.join(
    os.tmpdir(),
    `excalidraw-mcp-advanced-${crypto.randomUUID()}`,
  );
  const runtime = createRuntime({
    dbPath: path.join(directory, "database.db"),
    filesDir: path.join(directory, "files"),
    config: createServerConfig({
      NODE_ENV: "test",
      ALLOW_ANONYMOUS: "true",
      MCP_TOKEN: "advanced-test",
    }),
  });
  const handler = createMcpRequestHandler(
    runtime,
    createRequestHandler(runtime),
  );
  const client = new Client(
    { name: "advanced-regression", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("http://test.local/mcp/advanced-test"),
    {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
    },
  );
  try {
    await client.connect(transport);
    await run(
      client,
      async <T>(name: string, args: Record<string, unknown>) => {
        const response = await client.callTool({ name, arguments: args });
        expect(response.isError).not.toBe(true);
        expect(response.structuredContent).toMatchObject({ ok: true });
        expect(response.content).toHaveLength(1);
        const content = response.content[0];
        expect(content.type).toBe("text");
        const text = content.type === "text" ? content.text : "";
        expect(text.length).toBeGreaterThan(0);
        expect(text.length).toBeLessThanOrEqual(1024);
        expect(text).not.toContain("详情见 structuredContent");
        expect(text).not.toContain('"elements":');
        return { data: response.structuredContent as T, text };
      },
    );
  } finally {
    await client.close();
    await handler.close();
    runtime.db.close();
    await rm(directory, { recursive: true, force: true });
  }
};

describe("advanced diagram MCP SDK regressions", () => {
  it("creates editable architecture and both swimlane directions with clean text geometry and durable retries", async () => {
    await withClient(async (_client, invoke) => {
      for (const scenario of [
        {
          layout: "architecture",
          direction: "vertical",
          regions: [
            { id: "outer", title: "应用架构层" },
            { id: "frontend", title: "用户界面与复杂交互", parentId: "outer" },
            { id: "backend", title: "服务处理与存储", parentId: "outer" },
          ],
        },
        {
          layout: "swimlane",
          direction: "horizontal",
          regions: [
            { id: "frontend", title: "用户与前端" },
            { id: "backend", title: "服务端与存储" },
          ],
        },
        {
          layout: "swimlane",
          direction: "vertical",
          regions: [
            { id: "frontend", title: "用户与前端" },
            { id: "backend", title: "服务端与存储" },
          ],
        },
      ]) {
        const args = {
          ...scenario,
          name: `${scenario.layout}-${scenario.direction} 中文全景图`,
          idempotencyKey: `${scenario.layout}-${scenario.direction}`,
          responseMode: "ids",
          nodes: [
            {
              id: "entry",
              regionId: "frontend",
              title: "中文长标题自动换行与 English 混合内容".repeat(3),
              body: "用户输入\n中文正文与 English 混排".repeat(6),
            },
            {
              id: "validate",
              regionId: "frontend",
              title: "校验与反馈",
              body: "处理分支以及循环反馈",
            },
            {
              id: "service",
              regionId: "backend",
              title: "服务处理",
              body: "执行与持久化",
            },
            {
              id: "store",
              regionId: "backend",
              title: "保存",
              body: "同步完成",
            },
          ],
          edges: [
            { from: "entry", to: "validate" },
            { from: "validate", to: "service" },
            { from: "entry", to: "store" },
            { from: "service", to: "validate" },
            { from: "store", to: "store" },
          ],
        };
        const created = await invoke<{
          boardId: string;
          revision: number;
          url: string;
          regions: Region[];
          bounds: unknown;
        }>("create_diagram", args);
        expect(created.text).toContain(args.name);
        expect(created.text).toContain(created.data.boardId);
        expect(created.text).toContain(created.data.url);
        expect(created.data.regions).toHaveLength(scenario.regions.length);
        expect(created.data.bounds).toBeDefined();
        const inspected = await invoke<{
          complete: boolean;
          issues: unknown[];
        }>("inspect_layout", {
          boardId: created.data.boardId,
          checks: ["text_overlap", "text_overflow"],
        });
        expect(inspected.data.complete).toBe(true);
        expect(inspected.data.issues).toEqual([]);
        const before = (
          await invoke<Board>("get_board", {
            boardId: created.data.boardId,
            view: "full",
          })
        ).data;
        for (const region of created.data.regions) {
          expect(
            before.elements.some(
              (element) => element.id === region.backgroundId,
            ),
          ).toBe(true);
          expect(
            before.elements.some((element) => element.id === region.titleId),
          ).toBe(true);
          for (const nodeId of region.nodeIds) {
            expect(
              before.elements.find((element) => element.id === nodeId)
                ?.groupIds,
            ).toContain(region.groupId);
          }
        }
        const crossing = before.elements.find(
          (element) =>
            element.type === "arrow" &&
            element.startBinding?.elementId === "validate" &&
            element.endBinding?.elementId === "service",
        )!;
        expect(crossing).toBeDefined();
        expect(crossing.groupIds).toEqual([]);
        await invoke("update_board", {
          boardId: created.data.boardId,
          updates: [{ id: "service", dx: 50, dy: 25 }],
        });
        const moved = (
          await invoke<Board>("get_board", {
            boardId: created.data.boardId,
            view: "full",
          })
        ).data;
        const movedArrow = moved.elements.find(
          (element) => element.id === crossing.id,
        )!;
        expect(movedArrow.endBinding?.elementId).toBe("service");
        expect([movedArrow.x, movedArrow.y, movedArrow.points]).not.toEqual([
          crossing.x,
          crossing.y,
          crossing.points,
        ]);
        const replayed = await invoke<Record<string, unknown>>(
          "create_diagram",
          { ...args, responseMode: "minimal" },
        );
        expect(replayed.text).toContain("已有画板");
        expect(replayed.data).toMatchObject({
          boardId: created.data.boardId,
          revision: moved.revision,
          addedCount: 0,
          idempotentReplay: true,
        });
        expect(replayed.data).not.toHaveProperty("regions");
        expect(
          (
            await invoke<Board>("get_board", {
              boardId: created.data.boardId,
              view: "full",
            })
          ).data,
        ).toEqual(moved);
        const copied = await invoke<{
          idMap: Record<string, string>;
          groupIdMap: Record<string, string>;
        }>("copy_elements", {
          boardId: created.data.boardId,
          elementIds: before.elements
            .filter((element) => element.type !== "arrow")
            .map((element) => element.id),
          dx: 3000,
          dy: 0,
        });
        const afterCopy = (
          await invoke<Board>("get_board", {
            boardId: created.data.boardId,
            view: "full",
          })
        ).data;
        for (const original of before.elements.filter(
          (element) => element.type !== "arrow",
        )) {
          const duplicate = afterCopy.elements.find(
            (element) => element.id === copied.data.idMap[original.id],
          );
          expect(duplicate).toBeDefined();
          expect(duplicate!.groupIds).toEqual(
            original.groupIds.map((groupId) => copied.data.groupIdMap[groupId]),
          );
        }
      }
    });
  });

  it("rejects invalid advanced structures without creating a board and never invents edges", async () => {
    await withClient(async (client, invoke) => {
      const baseline = {
        name: "有效单区域",
        layout: "architecture",
        regions: [{ id: "region", title: "服务层" }],
        nodes: [
          { id: "a", title: "节点甲", regionId: "region" },
          { id: "b", title: "节点乙", regionId: "region" },
        ],
      };
      const created = await invoke<{ boardId: string; edgeCount: number }>(
        "create_diagram",
        baseline,
      );
      expect(created.data.edgeCount).toBe(0);
      const before = (await invoke<{ items: unknown[] }>("list_boards", {}))
        .data;
      const invalid = [
        { ...baseline, nodes: [{ id: "a", title: "无归属" }] },
        {
          ...baseline,
          nodes: [{ id: "a", title: "不存在的区域", regionId: "missing" }],
        },
        {
          ...baseline,
          regions: [
            { id: "region", title: "甲" },
            { id: "region", title: "乙" },
          ],
        },
        {
          ...baseline,
          regions: [{ id: "region", title: "循环", parentId: "region" }],
        },
        {
          ...baseline,
          regions: [...baseline.regions, { id: "empty", title: "空区域" }],
        },
        {
          ...baseline,
          regions: [
            { id: "outer", title: "外层" },
            { id: "middle", title: "中层", parentId: "outer" },
            { id: "region", title: "第三层", parentId: "middle" },
          ],
        },
        { ...baseline, edges: [{ from: "a", to: "missing" }] },
        {
          ...baseline,
          layout: "swimlane",
          regions: [
            { id: "region", title: "根" },
            { id: "child", title: "嵌套泳道", parentId: "region" },
          ],
        },
      ];
      for (const args of invalid) {
        const response = await client.callTool({
          name: "create_diagram",
          arguments: args,
        });
        expect(
          response.isError === true ||
            (response.structuredContent as { ok?: boolean } | undefined)?.ok ===
              false,
        ).toBe(true);
        expect(response.content[0].type).toBe("text");
      }
      expect((await invoke("list_boards", {})).data).toEqual(before);
    });
  });

  it("keeps concurrent summaries tied to operations and surfaces skipped, incomplete, pagination and batch outcomes", async () => {
    await withClient(async (client, invoke) => {
      const concurrent = await Promise.all([
        invoke<{ boardId: string; revision: number }>("create_board", {
          name: "摘要定位",
          elements: [
            { type: "text", id: "standalone", x: 0, y: 0, text: "独立文字" },
            {
              type: "rectangle",
              id: "large",
              x: 10000,
              y: 10000,
              width: 100000,
              height: 100000,
            },
          ],
        }),
        invoke<{ width: number; height: number }>("measure_text", {
          text: "中文 English\n换行",
          width: 120,
        }),
      ]);
      const board = concurrent[0].data;
      expect(concurrent[0].text).toContain("摘要定位");
      expect(concurrent[1].text).toContain("估算");
      expect(concurrent[1].text).not.toContain("摘要定位");
      const noop = await invoke("manage_board", {
        boardId: board.boardId,
        name: "摘要定位",
      });
      expect(noop.text).toContain("无需修改");
      const skip = await invoke<{
        checks: { text_overflow: { skippedNoContainer: number } };
      }>("inspect_layout", {
        boardId: board.boardId,
        checks: ["text_overflow"],
      });
      expect(skip.data.checks.text_overflow.skippedNoContainer).toBe(1);
      expect(skip.text).toMatch(/跳过|未找到|无容器/);
      const incomplete = await invoke<{ complete: boolean }>("inspect_layout", {
        boardId: board.boardId,
        checks: ["element_collision"],
      });
      expect(incomplete.data.complete).toBe(false);
      expect(incomplete.text).toMatch(/未完成|不完整|未完整/);
      await invoke("create_board", { name: "第二张", elements: [] });
      const listed = await invoke("list_boards", { limit: 1 });
      expect(listed.text).toMatch(/分页|后续|下一页|还有|更多/);
      const truncated = await invoke<{ truncated: boolean }>("get_board", {
        boardId: board.boardId,
        view: "full",
        limit: 1,
      });
      expect(truncated.data.truncated).toBe(true);
      expect(truncated.text).toMatch(/截断|分页|更多|下一/);
      const batch = await invoke("get_boards_batch", {
        boardIds: [board.boardId, "missing-board"],
        view: "summary",
      });
      expect(batch.text).toMatch(/成功\s*1/);
      expect(batch.text).toMatch(/失败\s*1/);
      const failedBatch = await invoke("get_boards_batch", {
        boardIds: ["missing-board"],
        view: "summary",
      });
      expect(failedBatch.text).toMatch(/失败\s*1/);
      const managed = await invoke("batch_manage_boards", {
        items: [
          {
            boardId: board.boardId,
            expectedRevision: board.revision,
            action: "manage",
            favorite: true,
          },
          {
            boardId: "missing-board",
            expectedRevision: 1,
            action: "manage",
            favorite: true,
          },
        ],
      });
      expect(managed.text).toMatch(/成功\s*1/);
      expect(managed.text).toMatch(/失败\s*1/);
      const response = await client.callTool({
        name: "get_board",
        arguments: { boardId: "missing-board" },
      });
      expect(response.structuredContent).toMatchObject({ ok: false });
      const error = response.structuredContent as {
        error: { message: string };
      };
      expect(response.content).toEqual([
        { type: "text", text: `操作失败：${error.error.message}` },
      ]);
    });
  });
});
