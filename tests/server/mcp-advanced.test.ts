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
type Board = { revision: number; elements: Element[] };

const withClient = async (
  run: (
    client: Client,
    invoke: <T>(
      name: string,
      args: Record<string, unknown>,
      ok?: boolean,
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
      async <T>(name: string, args: Record<string, unknown>, ok = true) => {
        const response = await client.callTool({ name, arguments: args });
        expect(response.isError).not.toBe(true);
        expect(response.structuredContent).toMatchObject({ ok });
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

describe("advanced MCP SDK regressions", () => {
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
      const batch = await invoke(
        "get_boards_batch",
        {
          boardIds: [board.boardId, "missing-board"],
          view: "summary",
        },
        false,
      );
      expect(batch.text).toMatch(/成功\s*1/);
      expect(batch.text).toMatch(/失败\s*1/);
      const failedBatch = await invoke(
        "get_boards_batch",
        {
          boardIds: ["missing-board"],
          view: "summary",
        },
        false,
      );
      expect(failedBatch.text).toMatch(/失败\s*1/);
      const managed = await invoke(
        "batch_manage_boards",
        {
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
        },
        false,
      );
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
