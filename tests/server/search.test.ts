import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import {
  createRequestHandler,
  createRuntime,
  createServerConfig,
  type ServerRuntime,
} from "../../server/server";

const runtimes: ServerRuntime[] = [];
const directories: string[] = [];

const createTestServer = () => {
  const directory = path.join(
    os.tmpdir(),
    `excalidraw-search-${crypto.randomUUID()}`,
  );
  const runtime = createRuntime({
    dbPath: path.join(directory, "excalidraw.db"),
    filesDir: path.join(directory, "files"),
    config: createServerConfig({ NODE_ENV: "test", ALLOW_ANONYMOUS: "true" }),
  });
  runtimes.push(runtime);
  directories.push(directory);
  return { runtime, handler: createRequestHandler(runtime) };
};

const search = async (
  handler: ReturnType<typeof createRequestHandler>,
  query: string,
  options = "",
) => {
  const response = await handler(
    new Request(
      `http://localhost/api/scenes?q=${encodeURIComponent(query)}${options}`,
    ),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    items: Array<{ id: string }>;
    totalCount: number;
    nextCursor: string | null;
  };
};

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    runtime.db.close();
  }
  await Promise.all(
    directories.splice(0).map((directory) =>
      fs.rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("scene search", () => {
  it("searches tag values instead of JSON syntax and keeps JSON punctuation literal", async () => {
    const { runtime, handler } = createTestServer();
    runtime.db
      .query(
        `
      INSERT INTO scenes (id, name, elements, app_state, created_at, updated_at, tags_json)
      VALUES (?, ?, '[]', '{}', 1, 1, ?)
    `,
      )
      .run("empty", "空标签", "[]");
    runtime.db
      .query(
        `
      INSERT INTO scenes (id, name, elements, app_state, created_at, updated_at, tags_json)
      VALUES (?, ?, '[]', '{}', 2, 2, ?)
    `,
      )
      .run("punctuation", "标点标签", JSON.stringify(["[]"]));

    const syntaxOnly = await search(handler, "[]");
    expect(syntaxOnly.items.map(({ id }) => id)).toEqual(["punctuation"]);
    expect(syntaxOnly.totalCount).toBe(1);
    expect((await search(handler, '["')).totalCount).toBe(0);
  });

  it("matches Unicode case consistently in names, tags, and folders", async () => {
    const { runtime, handler } = createTestServer();
    runtime.db
      .query(
        "INSERT INTO folders (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)",
      )
      .run("folder", "École");
    runtime.db
      .query(
        `
      INSERT INTO scenes (id, name, elements, app_state, created_at, updated_at, tags_json, folder_id)
      VALUES (?, ?, '[]', '{}', 1, 1, ?, ?)
    `,
      )
      .run("name", "École dessin", "[]", null);
    runtime.db
      .query(
        `
      INSERT INTO scenes (id, name, elements, app_state, created_at, updated_at, tags_json)
      VALUES (?, ?, '[]', '{}', 2, 2, ?)
    `,
      )
      .run("tag", "Étiquette", JSON.stringify(["École"]));
    runtime.db
      .query(
        `
      INSERT INTO scenes (id, name, elements, app_state, created_at, updated_at, tags_json, folder_id)
      VALUES (?, ?, '[]', '{}', 3, 3, '[]', ?)
    `,
      )
      .run("folder_match", "Dossier", "folder");

    for (const [query, id] of [
      ["éCOLE", "name"],
      ["éCOLE", "tag"],
      ["éCOLE", "folder_match"],
    ]) {
      const result = await search(handler, query);
      expect(result.items.map(({ id: itemId }) => itemId)).toContain(id);
      expect(result.totalCount).toBe(3);
    }

    const firstPage = await search(handler, "éCOLE", "&limit=1");
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.totalCount).toBe(3);
    expect(firstPage.nextCursor).toBeTruthy();
    const nextPage = await search(
      handler,
      "éCOLE",
      `&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    );
    expect(nextPage.items).toHaveLength(1);
    expect(nextPage.totalCount).toBe(3);
  });
});
