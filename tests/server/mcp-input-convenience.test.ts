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

it("supports local linear origins and default tag replacement through the public SDK", async () => {
  const directory = path.join(
    os.tmpdir(),
    `excalidraw-mcp-convenience-${crypto.randomUUID()}`,
  );
  const runtime = createRuntime({
    dbPath: path.join(directory, "database.db"),
    filesDir: path.join(directory, "files"),
    config: createServerConfig({
      NODE_ENV: "test",
      ALLOW_ANONYMOUS: "true",
      MCP_TOKEN: "convenience-test",
    }),
  });
  const handler = createMcpRequestHandler(
    runtime,
    createRequestHandler(runtime),
  );
  const client = new Client(
    { name: "convenience-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("http://test.local/mcp/convenience-test"),
    {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
    },
  );
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ ok: true });
    return response.structuredContent as Record<string, any>;
  };
  try {
    await client.connect(transport);
    const board = await invoke("create_board", {
      name: "原点与标签",
      tags: ["旧标签"],
      elements: [
        {
          type: "line",
          id: "line",
          x: 100,
          y: 200,
          points: [
            [0, 0],
            [50, 20],
          ],
        },
        {
          type: "arrow",
          id: "arrow",
          x: -100,
          y: -200,
          points: [
            [0, 0],
            [60, 30],
          ],
        },
      ],
    });
    const input = await invoke("get_board", {
      boardId: board.boardId,
      view: "input",
    });
    expect(input.elements[0]).toMatchObject({
      x: 100,
      y: 200,
      points: [
        [0, 0],
        [50, 20],
      ],
    });
    expect(input.elements[1]).toMatchObject({
      x: -100,
      y: -200,
      points: [
        [0, 0],
        [60, 30],
      ],
    });
    expect(
      await invoke("update_board", {
        boardId: board.boardId,
        updates: input.elements,
      }),
    ).toMatchObject({ noop: true, revision: board.revision });
    await invoke("update_element", {
      boardId: board.boardId,
      update: {
        id: "arrow",
        x: 300,
        y: 400,
        points: [
          [0, 0],
          [40, 10],
        ],
      },
    });
    const updated = await invoke("get_board", {
      boardId: board.boardId,
      view: "input",
      elementIds: ["arrow"],
    });
    expect(updated.elements[0]).toMatchObject({
      x: 300,
      y: 400,
      points: [
        [0, 0],
        [40, 10],
      ],
    });
    const replaced = await invoke("manage_board", {
      boardId: board.boardId,
      tags: ["新标签"],
    });
    expect(replaced.tags).toEqual(["新标签"]);
    expect(
      await invoke("manage_board", {
        boardId: board.boardId,
        tags: ["新标签"],
      }),
    ).toMatchObject({ noop: true, revision: replaced.revision });
    expect(
      (
        await invoke("manage_board", {
          boardId: board.boardId,
          tags: ["追加"],
          tagMode: "add",
        })
      ).tags,
    ).toEqual(["新标签", "追加"]);
    expect(
      (
        await invoke("manage_board", {
          boardId: board.boardId,
          tags: ["新标签"],
          tagMode: "remove",
        })
      ).tags,
    ).toEqual(["追加"]);
    const batch = await invoke("batch_manage_boards", {
      items: [
        {
          action: "manage",
          boardId: board.boardId,
          expectedRevision: (
            await invoke("get_board", {
              boardId: board.boardId,
              view: "summary",
            })
          ).revision,
          tags: [],
        },
      ],
    });
    expect(batch.results[0]).toMatchObject({ ok: true, tags: [] });
    const before = runtime.db
      .query("SELECT revision FROM scenes WHERE id = ?")
      .get(board.boardId);
    const invalid = await client.callTool({
      name: "add_elements",
      arguments: {
        boardId: board.boardId,
        elements: [
          {
            type: "line",
            x: 100,
            points: [
              [0, 0],
              [10, 10],
            ],
          },
        ],
      },
    });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid.content)).toContain("x/y 原点");
    for (const element of [
      {
        type: "line",
        points: [
          [100, 200],
          [150, 220],
        ],
      },
      { type: "arrow", startX: 100, startY: 200, endX: 150, endY: 220 },
    ]) {
      const rejectedCreate = await client.callTool({
        name: "add_elements",
        arguments: {
          boardId: board.boardId,
          elements: [element],
        },
      });
      expect(rejectedCreate.isError).toBe(true);
      const { type, ...geometry } = element;
      const rejectedUpdate = await client.callTool({
        name: "update_element",
        arguments: {
          boardId: board.boardId,
          update: { id: type === "line" ? "line" : "arrow", ...geometry },
        },
      });
      expect(rejectedUpdate.isError).toBe(true);
    }
    expect(
      runtime.db
        .query("SELECT revision FROM scenes WHERE id = ?")
        .get(board.boardId),
    ).toEqual(before);
  } finally {
    await client.close();
    await handler.close();
    runtime.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
