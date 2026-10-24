import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { expect, it } from "bun:test";
import { createServerConfig } from "../../server/config";
import { createMcpRequestHandler } from "../../server/mcp";
import { createRequestHandler } from "../../server/routes";
import { createRuntime } from "../../server/runtime";

it("returns concise color errors through the public MCP client and rejects before writing", async () => {
  const directory = path.join(
    os.tmpdir(),
    `excalidraw-mcp-color-${crypto.randomUUID()}`,
  );
  const runtime = createRuntime({
    dbPath: path.join(directory, "database.db"),
    filesDir: path.join(directory, "files"),
    config: createServerConfig({
      NODE_ENV: "test",
      ALLOW_ANONYMOUS: "true",
      MCP_TOKEN: "color-test",
    }),
  });
  const handler = createMcpRequestHandler(
    runtime,
    createRequestHandler(runtime),
  );
  const client = new Client(
    { name: "color-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("http://test.local/mcp/color-test"),
    {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
    },
  );
  const box = { type: "rectangle", x: 0, y: 0, width: 100, height: 100 };
  try {
    await client.connect(transport);
    await client.listTools(); // Exercise client validation against the advertised JSON schema.
    const failures = [
      {
        name: "create_board",
        arguments: {
          name: "invalid stroke",
          elements: [{ ...box, strokeColor: "#GGGGGG" }],
        },
        field: "elements.0.strokeColor",
      },
      {
        name: "create_board",
        arguments: { name: "invalid background", backgroundColor: "#GGGGGG" },
        field: "backgroundColor",
      },
      {
        name: "create_folder",
        arguments: { name: "invalid folder", color: "#GGGGGG" },
        field: "color",
      },
      {
        name: "create_board",
        arguments: {
          name: "invalid batch",
          elements: Array.from({ length: 100 }, () => ({
            ...box,
            strokeColor: "#GGGGGG",
          })),
        },
        field: "elements.0.strokeColor",
      },
    ];
    for (const { field, ...request } of failures) {
      const response = await client.callTool(request);
      expect(response.isError).toBe(true);
      const text = response.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join(" ");
      expect(text).toContain(field);
      expect(text).toContain("颜色须为");
      expect(text.length).toBeLessThan(400);
      expect(text).not.toContain("pattern");
      expect(text).not.toContain("(?:");
      if (
        field === "elements.0.strokeColor" &&
        request.arguments.name === "invalid batch"
      )
        expect(text).toContain("共 100 处");
    }
    expect(
      runtime.db.query("SELECT COUNT(*) AS count FROM scenes").get(),
    ).toMatchObject({ count: 0 });
    expect(
      runtime.db.query("SELECT COUNT(*) AS count FROM folders").get(),
    ).toMatchObject({ count: 0 });

    const created = await client.callTool({
      name: "create_board",
      arguments: {
        name: "uppercase",
        backgroundColor: "TRANSPARENT",
        elements: [{ ...box, strokeColor: "#AABBCC", backgroundColor: "ReD" }],
      },
    });
    expect(created.isError).not.toBe(true);
    const boardId = (created.structuredContent as { boardId: string }).boardId;
    const read = await client.callTool({
      name: "get_board",
      arguments: { boardId, view: "input" },
    });
    expect(read.structuredContent).toMatchObject({
      elements: [{ strokeColor: "#aabbcc", backgroundColor: "red" }],
    });
    const stored = runtime.db
      .query("SELECT app_state FROM scenes WHERE id = ?")
      .get(boardId) as { app_state: string };
    expect(JSON.parse(stored.app_state)).toMatchObject({
      viewBackgroundColor: "transparent",
    });
    const folder = await client.callTool({
      name: "create_folder",
      arguments: { name: "uppercase folder", color: "ReD" },
    });
    expect(folder.structuredContent).toMatchObject({ color: "red" });
  } finally {
    await client.close();
    await handler.close();
    runtime.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
