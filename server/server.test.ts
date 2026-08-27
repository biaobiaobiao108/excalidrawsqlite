import fs, { rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";

import {
  createRequestHandler,
  createRuntime,
  createServerConfig,
  type ServerRuntime,
} from "./server";

const runtimes: ServerRuntime[] = [];
const testDirectories: string[] = [];

const createTestRuntime = (env: Record<string, string | undefined> = {}) => {
  const root = Bun.env.TEMP || Bun.env.TMP || ".";
  const directory = `${root}/excalidraw-server-test-${crypto.randomUUID()}`;
  const config = createServerConfig({
    NODE_ENV: "test",
    AUTH_PASSWORD: "test-password",
    ...env,
  });
  const runtime = createRuntime({
    dbPath: path.join(directory, "excalidraw.db"),
    filesDir: path.join(directory, "files"),
    config,
  });
  runtimes.push(runtime);
  testDirectories.push(directory);
  return { runtime, directory, handler: createRequestHandler(runtime) };
};

const request = (
  handler: ReturnType<typeof createRequestHandler>,
  pathname: string,
  init: RequestInit = {},
) => handler(new Request(`http://localhost${pathname}`, init));

const jsonRequest = (
  handler: ReturnType<typeof createRequestHandler>,
  pathname: string,
  body: unknown,
  init: RequestInit = {},
) =>
  request(handler, pathname, {
    method: "POST",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    body: JSON.stringify(body),
  });

const responseJson = async <T>(response: Response) =>
  (await response.json()) as T;

const authenticate = async (
  handler: ReturnType<typeof createRequestHandler>,
) => {
  const response = await jsonRequest(handler, "/api/auth/verify", {
    password: "test-password",
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toBeTruthy();
  expect(cookie).not.toContain("test-password");
  return cookie!.split(";", 1)[0];
};

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    runtime.db.close();
  }
  for (const directory of testDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("cloud persistence server", () => {
  it("requires explicit production authentication configuration", () => {
    expect(() => createServerConfig({ NODE_ENV: "production" })).toThrow();
    expect(
      createServerConfig({ NODE_ENV: "production", ALLOW_ANONYMOUS: "true" })
        .allowAnonymous,
    ).toBe(true);
  });

  it("rate limits repeated failed authentication attempts", async () => {
    const { handler } = createTestRuntime();
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await jsonRequest(handler, "/api/auth/verify", {
        password: "wrong-password",
      });
      expect(response.status).toBe(401);
    }
    const limited = await jsonRequest(handler, "/api/auth/verify", {
      password: "wrong-password",
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("keeps production HTTP sessions usable while securing HTTPS sessions", async () => {
    const { handler } = createTestRuntime({ NODE_ENV: "production" });
    const httpCookie = await authenticate(handler);
    expect(httpCookie.startsWith("excalidraw_session=")).toBe(true);
    expect(httpCookie).not.toContain("Secure");

    const scenes = await request(handler, "/api/scenes", {
      headers: { Cookie: httpCookie },
    });
    expect(scenes.status).toBe(200);

    const httpsResponse = await handler(
      new Request("https://localhost/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "test-password" }),
      }),
    );
    const httpsCookie = httpsResponse.headers.get("set-cookie") || "";
    expect(httpsCookie.startsWith("__Host-excalidraw_session=")).toBe(true);
    expect(httpsCookie).toContain("Secure");

    const logout = await handler(
      new Request("https://localhost/api/auth/logout", {
        method: "POST",
        headers: { Cookie: httpsCookie.split(";", 1)[0] },
      }),
    );
    const clearedCookies = logout.headers.getSetCookie();
    expect(clearedCookies).toHaveLength(2);
    expect(clearedCookies.join("\n")).toContain("__Host-excalidraw_session=");
    expect(clearedCookies.join("\n")).toContain("excalidraw_session=");
  });

  it("trusts forwarded HTTPS only when explicitly configured", async () => {
    const { handler } = createTestRuntime({
      NODE_ENV: "production",
      TRUST_PROXY: "true",
    });
    const response = await handler(
      new Request("http://localhost/api/auth/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-Proto": "https",
        },
        body: JSON.stringify({ password: "test-password" }),
      }),
    );
    expect(response.headers.get("set-cookie")).toContain(
      "__Host-excalidraw_session=",
    );
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });

  it("accepts same-origin API writes behind a trusted HTTPS proxy", async () => {
    const { handler } = createTestRuntime({
      NODE_ENV: "production",
      TRUST_PROXY: "true",
    });
    const cookie = await authenticate(handler);
    const response = await handler(
      new Request("http://internal-proxy/api/scenes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://whiteboard.example",
          "X-Forwarded-Host": "whiteboard.example",
          "X-Forwarded-Proto": "https",
          Cookie: cookie,
        },
        body: JSON.stringify({ name: "代理后的画板", elements: [] }),
      }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("migrates legacy scene databases with a default revision", async () => {
    const root = Bun.env.TEMP || Bun.env.TMP || ".";
    const directory = `${root}/excalidraw-server-test-${crypto.randomUUID()}`;
    const dbPath = path.join(directory, "excalidraw.db");
    await fs.mkdir(directory, { recursive: true });
    const legacyDb = new Database(dbPath, { create: true });
    legacyDb.run(`
      CREATE TABLE scenes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        elements TEXT NOT NULL,
        app_state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    legacyDb.run(
      `INSERT INTO scenes
       (id, name, elements, app_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["legacy_scene", "旧画板", "[]", "{}", 1, 1],
    );
    legacyDb.close();

    const runtime = createRuntime({
      dbPath,
      filesDir: path.join(directory, "files"),
      config: createServerConfig({ NODE_ENV: "test", ALLOW_ANONYMOUS: "true" }),
    });
    runtimes.push(runtime);
    testDirectories.push(directory);

    expect(
      runtime.db
        .query("SELECT revision FROM scenes WHERE id = ?")
        .get("legacy_scene"),
    ).toEqual({ revision: 1 });
  });

  it("uses a session cookie and preserves scene data while renaming", async () => {
    const { handler } = createTestRuntime();
    const unauthorized = await request(handler, "/api/scenes", {
      headers: { Origin: "http://localhost" },
    });
    expect(unauthorized.status).toBe(401);

    const cookie = await authenticate(handler);
    const createdResponse = await jsonRequest(
      handler,
      "/api/scenes",
      {
        id: "scene_test",
        name: "原始名称",
        elements: [{ id: "element-1", type: "rectangle" }],
        appState: { viewBackgroundColor: "#fff" },
      },
      { headers: { Cookie: cookie, Origin: "http://localhost" } },
    );
    expect(createdResponse.status).toBe(201);
    const created = await responseJson<{ revision: number }>(createdResponse);
    expect(created.revision).toBe(1);

    const renamedResponse = await jsonRequest(
      handler,
      "/api/scenes/scene_test",
      { name: "新名称", baseRevision: created.revision },
      { method: "PATCH", headers: { Cookie: cookie } },
    );
    expect(renamedResponse.status).toBe(200);

    const sceneResponse = await request(handler, "/api/scenes/scene_test", {
      headers: { Cookie: cookie },
    });
    const scene = await responseJson<{
      name: string;
      elements: unknown[];
      appState: Record<string, unknown>;
      revision: number;
    }>(sceneResponse);
    expect(scene.name).toBe("新名称");
    expect(scene.elements).toHaveLength(1);
    expect(scene.appState.viewBackgroundColor).toBe("#fff");
    expect(scene.revision).toBe(2);

    const conflict = await jsonRequest(
      handler,
      "/api/scenes/scene_test",
      {
        elements: [],
        appState: {},
        baseRevision: 1,
      },
      { method: "PUT", headers: { Cookie: cookie } },
    );
    expect(conflict.status).toBe(409);
  });

  it("stores files on disk and prevents deleted scenes from being recreated", async () => {
    const { handler, runtime, directory } = createTestRuntime();
    const cookie = await authenticate(handler);
    const bytes = new Uint8Array([1, 2, 3, 4]);

    const upload = await request(handler, "/api/files/file_test", {
      method: "PUT",
      headers: {
        Cookie: cookie,
        "Content-Type": "image/png",
      },
      body: bytes,
    });
    expect(upload.status).toBe(201);
    expect(
      await fs.readFile(path.join(directory, "files", "file_test")),
    ).toEqual(Buffer.from(bytes));
    const metadata = runtime.db
      .query("SELECT storage_path, byte_size FROM files WHERE id = ?")
      .get("file_test") as {
      storage_path: string;
      byte_size: number;
    };
    expect(metadata.storage_path).toBe("file_test");
    expect(metadata.byte_size).toBe(4);
    expect(
      (
        runtime.db.query("PRAGMA table_info(files)").all() as Array<{
          name: string;
        }>
      ).some((column) => column.name === "data_url"),
    ).toBe(false);

    const download = await request(handler, "/api/files/file_test", {
      headers: { Cookie: cookie, Accept: "application/octet-stream" },
    });
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
    expect(download.headers.get("content-type")).toContain("image/png");

    const createScene = await jsonRequest(
      handler,
      "/api/scenes",
      {
        id: "scene_delete",
        elements: [{ id: "image-1", type: "image", fileId: "file_test" }],
        appState: {},
      },
      { headers: { Cookie: cookie } },
    );
    expect(createScene.status).toBe(201);

    const deleted = await request(handler, "/api/scenes/scene_delete", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(deleted.status).toBe(200);

    const resurrected = await jsonRequest(
      handler,
      "/api/scenes/scene_delete",
      { elements: [], appState: {} },
      { method: "PUT", headers: { Cookie: cookie } },
    );
    expect(resurrected.status).toBe(404);
    expect(
      runtime.db.query("SELECT COUNT(*) AS count FROM scene_files").get() as {
        count: number;
      },
    ).toEqual({ count: 0 });
  });

  it("rejects oversized, invalid and traversal file requests", async () => {
    const { handler } = createTestRuntime({ MAX_FILE_BYTES: "3" });
    const cookie = await authenticate(handler);

    const oversized = await request(handler, "/api/files/file_test", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "image/png" },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(oversized.status).toBe(413);

    const missingMime = await request(handler, "/api/files/file_test", {
      method: "PUT",
      headers: { Cookie: cookie },
      body: new Uint8Array([1]),
    });
    expect(missingMime.status).toBe(415);

    const invalidMime = await request(handler, "/api/files/file_test", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "text/html" },
      body: new Uint8Array([1]),
    });
    expect(invalidMime.status).toBe(415);

    const traversal = await request(handler, "/api/files/..%2Fsecret", {
      headers: { Cookie: cookie },
    });
    expect(traversal.status).toBe(400);
  });

  it("restores the previous file when its metadata update fails", async () => {
    const { handler, runtime, directory } = createTestRuntime();
    const cookie = await authenticate(handler);
    const filePath = path.join(directory, "files", "file_rollback");
    const original = new Uint8Array([1, 2, 3]);

    const initialUpload = await request(handler, "/api/files/file_rollback", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "image/png" },
      body: original,
    });
    expect(initialUpload.status).toBe(201);

    runtime.db.run(
      `CREATE TRIGGER fail_file_update
       BEFORE UPDATE ON files
       BEGIN
         SELECT RAISE(ABORT, 'simulated metadata failure');
       END`,
    );
    const failedUpload = await request(handler, "/api/files/file_rollback", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "image/png" },
      body: new Uint8Array([9, 8, 7]),
    });

    expect(failedUpload.status).toBe(500);
    expect(await fs.readFile(filePath)).toEqual(Buffer.from(original));
  });

  it("does not serve the SPA shell for missing static assets", async () => {
    const { handler, runtime, directory } = createTestRuntime({
      ALLOW_ANONYMOUS: "true",
    });
    const staticDir = path.join(directory, "static");
    await fs.mkdir(path.join(staticDir, "assets"), { recursive: true });
    await fs.writeFile(path.join(staticDir, "index.html"), "<html>app</html>");
    await fs.writeFile(
      path.join(staticDir, "assets", "valid.js"),
      "export {};",
    );
    runtime.staticDir = staticDir;

    const page = await request(handler, "/cloud/scene", {
      headers: { Accept: "text/html" },
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<html>app</html>");

    const missingAsset = await request(handler, "/assets/missing.js", {
      headers: { Accept: "*/*" },
    });
    expect(missingAsset.status).toBe(404);

    const asset = await request(handler, "/assets/valid.js", {
      headers: { Accept: "*/*" },
    });
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
  });

  it("reports an unhealthy storage directory", async () => {
    const { handler, runtime, directory } = createTestRuntime({
      ALLOW_ANONYMOUS: "true",
    });
    runtime.filesDir = path.join(directory, "missing-files");

    const health = await request(handler, "/api/health");
    expect(health.status).toBe(503);
    expect(await responseJson<{ code: string }>(health)).toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
  });

  it("includes Content-Security-Policy and security headers", async () => {
    const { handler } = createTestRuntime({ ALLOW_ANONYMOUS: "true" });
    const res = await request(handler, "/api/health");
    expect(res.headers.get("content-security-policy")).toBeTruthy();
    expect(res.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
    expect(res.headers.get("content-security-policy")).toContain(
      "worker-src 'self' blob:",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("provides an authenticated online SQLite backup snapshot", async () => {
    const { handler } = createTestRuntime();
    const unauthorized = await request(handler, "/api/backup/snapshot");
    expect(unauthorized.status).toBe(401);

    const cookie = await authenticate(handler);
    // Create a sample scene
    await jsonRequest(
      handler,
      "/api/scenes",
      {
        id: "scene_backup_test",
        name: "备份画板",
        elements: [{ id: "elem-1", type: "rectangle" }],
        appState: {},
      },
      { headers: { Cookie: cookie } },
    );

    const backupRes = await request(handler, "/api/backup/snapshot", {
      headers: { Cookie: cookie },
    });
    expect(backupRes.status).toBe(200);
    expect(backupRes.headers.get("content-type")).toContain(
      "application/x-sqlite3",
    );
    expect(backupRes.headers.get("content-disposition")).toContain(
      "attachment; filename=",
    );
    const buffer = await backupRes.arrayBuffer();
    expect(buffer.byteLength).toBeGreaterThan(0);
    // Header for sqlite database starts with "SQLite format 3\0"
    const header = new TextDecoder().decode(buffer.slice(0, 15));
    expect(header).toBe("SQLite format 3");
  });
});
