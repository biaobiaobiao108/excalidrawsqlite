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
  fileId?: string;
};
type Board = { revision: number; elements: Element[] };

const withClient = async (
  run: (
    invoke: <T>(
      name: string,
      args: Record<string, unknown>,
      ok?: boolean,
    ) => Promise<{ data: T; text: string }>,
    apiHandler: ReturnType<typeof createRequestHandler>,
  ) => Promise<void>,
) => {
  const directory = path.join(
    os.tmpdir(),
    `excalidraw-mcp-text-diagrams-${crypto.randomUUID()}`,
  );
  const runtime = createRuntime({
    dbPath: path.join(directory, "database.db"),
    filesDir: path.join(directory, "files"),
    config: createServerConfig({
      NODE_ENV: "test",
      ALLOW_ANONYMOUS: "true",
      MCP_TOKEN: "text-diagrams-test",
    }),
  });
  const apiHandler = createRequestHandler(runtime);
  const handler = createMcpRequestHandler(runtime, apiHandler);
  const client = new Client(
    { name: "text-diagrams-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("http://test.local/mcp/text-diagrams-test"),
    {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
    },
  );
  try {
    await client.connect(transport);
    await run(
      async <T>(name: string, args: Record<string, unknown>, ok = true) => {
        const response = await client.callTool({ name, arguments: args });
        expect(Boolean(response.isError)).toBe(!ok);
        expect(response.structuredContent).toMatchObject({ ok });
        expect(response.content).toHaveLength(1);
        const content = response.content[0];
        expect(content.type).toBe("text");
        const text = content.type === "text" ? content.text : "";
        expect(text.length).toBeGreaterThan(0);
        return { data: response.structuredContent as T, text };
      },
      apiHandler,
    );
  } finally {
    await client.close();
    await handler.close();
    runtime.db.close();
    await rm(directory, { recursive: true, force: true });
  }
};

describe("MCP create_from_mermaid and create_from_markdown", () => {
  it("converts Mermaid flowchart to native editable elements and supports idempotent retries", async () => {
    await withClient(async (invoke) => {
      const mermaid = [
        "flowchart TD",
        '  A["接收请求"] --> B{"鉴权通过?"}',
        '  B -->|"是"| C["写入 SQLite"]',
        '  B -->|"否"| D["返回 401"]',
      ].join("\n");

      const first = await invoke<{
        boardId: string;
        revision: number;
        elementCount: number;
        convertedAsImage: boolean;
        fileCount: number;
      }>("create_from_mermaid", {
        name: "Mermaid 流程图",
        mermaid,
        idempotencyKey: "mermaid-flow-1",
      });
      expect(first.data.convertedAsImage).toBe(false);
      expect(first.data.fileCount).toBe(0);
      expect(first.data.elementCount).toBeGreaterThan(5);

      const read = await invoke<Board>("get_board", {
        boardId: first.data.boardId,
        view: "elements",
      });
      const types = new Set(read.data.elements.map((el) => el.type));
      expect(types.has("rectangle")).toBe(true);
      expect(types.has("diamond")).toBe(true);
      expect(types.has("arrow")).toBe(true);
      expect(types.has("text")).toBe(true);

      const replay = await invoke<{
        boardId: string;
        addedCount: number;
        idempotentReplay: boolean;
      }>("create_from_mermaid", {
        name: "Mermaid 流程图",
        mermaid,
        idempotencyKey: "mermaid-flow-1",
      });
      expect(replay.data.idempotentReplay).toBe(true);
      expect(replay.data.addedCount).toBe(0);
      expect(replay.data.boardId).toBe(first.data.boardId);
    });
  });

  it("uploads sanitized SVG fallback files for Mermaid chart types like pie", async () => {
    await withClient(async (invoke, apiHandler) => {
      const created = await invoke<{
        boardId: string;
        elementCount: number;
        convertedAsImage: boolean;
        fileCount: number;
      }>("create_from_mermaid", {
        name: "饼图测试",
        mermaid: 'pie title 占比\n  "A" : 60\n  "B" : 40',
      });
      expect(created.data.convertedAsImage).toBe(true);
      expect(created.data.fileCount).toBe(1);
      expect(created.data.elementCount).toBe(1);

      const read = await invoke<Board>("get_board", {
        boardId: created.data.boardId,
        view: "full",
      });
      const imageEl = read.data.elements[0];
      expect(imageEl?.type).toBe("image");
      expect(imageEl?.fileId).toBeTruthy();

      const fileRes = await apiHandler(
        new Request(`http://test.local/api/files/${imageEl.fileId}`),
      );
      expect(fileRes.status).toBe(200);
      expect(fileRes.headers.get("content-type")).toBe("image/svg+xml");
      expect(fileRes.headers.get("content-security-policy")).toContain(
        "sandbox",
      );
      const svgBody = await fileRes.text();
      expect(svgBody).toContain("<svg");
    });
  });

  it("reports structured INVALID_INPUT on Mermaid syntax errors", async () => {
    await withClient(async (invoke) => {
      const failed = await invoke<{
        error: { code: string; message: string };
      }>(
        "create_from_mermaid",
        {
          name: "错误流程图",
          mermaid: "flowchart TD\n  A --> ]]]",
        },
        false,
      );
      expect(failed.data.error.code).toBe("INVALID_INPUT");
      expect(failed.data.error.message.length).toBeGreaterThan(0);
    });
  });

  it("creates mindmap board from Markdown outline and rejects empty input", async () => {
    await withClient(async (invoke) => {
      const markdown = [
        "# 狐涂画板",
        "- 前端",
        "  - React",
        "  - Canvas",
        "- 服务端",
        "  - Bun",
        "  - SQLite",
      ].join("\n");

      const created = await invoke<{
        boardId: string;
        nodeCount: number;
        elementCount: number;
      }>("create_from_markdown", {
        name: "架构思维导图",
        markdown,
        theme: "light",
        idempotencyKey: "md-mindmap-1",
      });
      expect(created.data.nodeCount).toBe(7);
      expect(created.data.elementCount).toBeGreaterThanOrEqual(20);

      const read = await invoke<Board>("get_board", {
        boardId: created.data.boardId,
        view: "full",
      });
      const types = new Set(read.data.elements.map((el) => el.type));
      expect(types.has("rectangle")).toBe(true);
      expect(types.has("arrow")).toBe(true);
      expect(types.has("text")).toBe(true);

      const emptyFailed = await invoke<{
        error: { code: string };
      }>(
        "create_from_markdown",
        {
          name: "空导图",
          markdown: "   \n  ",
        },
        false,
      );
      expect(emptyFailed.data.error.code).toBe("INVALID_INPUT");
    });
  });
});
