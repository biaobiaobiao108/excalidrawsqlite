import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServerConfig } from "../server/config";
import { createMcpRequestHandler } from "../server/mcp";
import { createRequestHandler } from "../server/routes";
import { createRuntime } from "../server/runtime";

// In-process SDK/SQLite benchmark. It excludes network latency and model reasoning.
// Run: bun scripts/benchmark-mcp.ts
const samples = 30;
const tempRoot = path.resolve(os.tmpdir());
const directory = path.resolve(
  tempRoot,
  `excalidraw-mcp-benchmark-${crypto.randomUUID()}`,
);
const runtime = createRuntime({
  dbPath: path.join(directory, "benchmark.db"),
  filesDir: path.join(directory, "files"),
  config: createServerConfig({
    NODE_ENV: "test",
    ALLOW_ANONYMOUS: "true",
    MCP_TOKEN: "benchmark-local-only",
  }),
});
const handler = createMcpRequestHandler(runtime, createRequestHandler(runtime));
const client = new Client(
  { name: "local-benchmark", version: "1.0.0" },
  { versionNegotiation: { mode: "auto" } },
);
const transport = new StreamableHTTPClientTransport(
  new URL("http://benchmark.local/mcp/benchmark-local-only"),
  {
    fetch: async (input, init) => handler.fetch(new Request(input, init)),
  },
);
type Outcome = {
  ok: boolean;
  boardId: string;
  revision: number;
  error?: { code: string };
  [key: string]: unknown;
};
const call = async (
  name: string,
  args: Record<string, unknown>,
  expectedError?: string,
) => {
  // Isolated benchmark requests do not consume the production abuse window.
  runtime.writeAttempts.clear();
  const result = await client.callTool({ name, arguments: args });
  const value = result.structuredContent as Outcome | undefined;
  if (
    !value ||
    (expectedError ? value.error?.code !== expectedError : value.ok !== true)
  ) {
    throw new Error(`Unexpected ${name} outcome: ${JSON.stringify(result)}`);
  }
  return value;
};
const specs = (prefix: string) =>
  Array.from({ length: 100 }, (_, i) => ({
    id: `${prefix}_${i}`,
    type: "rectangle",
    x: (i % 10) * 160,
    y: Math.floor(i / 10) * 100,
    width: 140,
    height: 80,
    text: `节点 ${i}`,
  }));
const quantile = (sorted: number[], p: number) =>
  sorted[Math.ceil(sorted.length * p) - 1];
const measurements: Array<Record<string, string | number>> = [];
const measure = async (
  name: string,
  run: (index: number) => Promise<Outcome>,
) => {
  const durations: number[] = [];
  const sizes: number[] = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    const value = await run(i);
    durations.push(performance.now() - start);
    sizes.push(JSON.stringify(value).length);
  }
  durations.sort((a, b) => a - b);
  sizes.sort((a, b) => a - b);
  measurements.push({
    operation: name,
    samples,
    p50Ms: +quantile(durations, 0.5).toFixed(2),
    p95Ms: +quantile(durations, 0.95).toFixed(2),
    medianResponseChars: quantile(sizes, 0.5),
  });
};

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const schemaChars = JSON.stringify(tools).length;
  const toolSchemaChars = Object.fromEntries(
    tools.tools
      .filter((tool) =>
        [
          "create_board",
          "add_elements",
          "update_board",
          "create_diagram",
        ].includes(tool.name),
      )
      .map((tool) => [tool.name, JSON.stringify(tool.inputSchema).length]),
  );
  const instructionsChars = client.getInstructions()?.length || 0;
  const initial = await call("create_board", {
    name: "基准画板",
    elements: specs("node"),
  });
  const views = Object.fromEntries(
    await Promise.all(
      ["compact", "elements", "input", "full"].map(async (view) => [
        view,
        JSON.stringify(
          await call("get_board", { boardId: initial.boardId, view }),
        ).length,
      ]),
    ),
  );
  const receipts = Object.fromEntries(
    await Promise.all(
      ["minimal", "ids"].map(async (responseMode) => [
        responseMode,
        JSON.stringify(
          await call("create_board", {
            name: "回执基准",
            elements: specs("receipt"),
            responseMode,
          }),
        ).length,
      ]),
    ),
  );
  await measure("create_board 100 / minimal", (i) =>
    call("create_board", { name: `创建 ${i}`, elements: specs("node") }),
  );
  await measure("create_board 100 / ids", (i) =>
    call("create_board", {
      name: `创建映射 ${i}`,
      elements: specs("node"),
      responseMode: "ids",
    }),
  );
  await measure("create_diagram 8", (i) =>
    call("create_diagram", {
      name: `时间线 ${i}`,
      layout: "timeline",
      nodes: Array.from({ length: 8 }, (_, n) => ({
        id: `step${n}`,
        title: `阶段 ${n}`,
        body: "阶段说明",
      })),
    }),
  );
  // Each add sample starts with the same size scene, so scene growth does not distort latency.
  const addBoards = await Promise.all(
    Array.from({ length: samples }, (_, i) =>
      call("create_board", { name: `追加目标 ${i}`, elements: specs("node") }),
    ),
  );
  await measure("add_elements 100 / minimal", (i) =>
    call("add_elements", {
      boardId: addBoards[i].boardId,
      expectedRevision: addBoards[i].revision,
      elements: specs("added"),
    }),
  );
  let revision = initial.revision;
  await measure("update_board 20", async (i) => {
    const value = await call("update_board", {
      boardId: initial.boardId,
      expectedRevision: revision,
      updates: Array.from({ length: 20 }, (_, n) => ({
        id: `node_${n}`,
        x: n * 160 + i + 1,
      })),
    });
    revision = value.revision;
    return value;
  });
  await measure("update_board noop", () =>
    call("update_board", {
      boardId: initial.boardId,
      expectedRevision: revision,
      updates: [{ id: "node_0", x: samples }],
    }),
  );
  await measure("update_board conflict", () =>
    call(
      "update_board",
      {
        boardId: initial.boardId,
        expectedRevision: 1,
        updates: [{ id: "node_0", x: 0 }],
      },
      "REVISION_CONFLICT",
    ),
  );
  console.log(
    JSON.stringify(
      {
        scope:
          "本机进程内 SDK + SQLite，隔离写入频控窗口；不包含模型思考或反代网络；字符数为 structuredContent JSON 长度",
        schemaChars,
        toolSchemaChars,
        instructionsChars,
        viewResponseChars: views,
        receiptResponseChars: receipts,
        measurements,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
  await handler.close();
  runtime.db.close();
  if (!directory.startsWith(tempRoot + path.sep) || directory === tempRoot)
    throw new Error("Unexpected benchmark cleanup path");
  await rm(directory, { recursive: true, force: true });
}
