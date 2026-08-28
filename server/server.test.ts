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

  it("isolates authentication rate limits by client address", async () => {
    const { runtime } = createTestRuntime();
    const addressResolver = (req: Request) =>
      req.headers.get("x-test-client") || undefined;
    const isolatedHandler = createRequestHandler(runtime, addressResolver);

    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await jsonRequest(
        isolatedHandler,
        "/api/auth/verify",
        { password: "wrong-password" },
        { headers: { "X-Test-Client": "client-a" } },
      );
      expect(response.status).toBe(401);
    }

    const otherClient = await jsonRequest(
      isolatedHandler,
      "/api/auth/verify",
      { password: "test-password" },
      { headers: { "X-Test-Client": "client-b" } },
    );
    expect(otherClient.status).toBe(200);
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

  it("uses the configured session TTL for the browser cookie", async () => {
    const { handler } = createTestRuntime({ AUTH_SESSION_TTL_MS: "1234" });
    const response = await jsonRequest(handler, "/api/auth/verify", {
      password: "test-password",
    });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=2");
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
    expect(download.headers.get("cache-control")).toContain("immutable");

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

    const deleted = await request(
      handler,
      "/api/scenes/scene_delete?permanent=true",
      {
        method: "DELETE",
        headers: { Cookie: cookie },
      },
    );
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

  it("persists sessions across runtime restarts", async () => {
    const { runtime, directory, handler } = createTestRuntime();
    const cookie = await authenticate(handler);

    // Verify session works on current runtime
    const initialStatus = await request(handler, "/api/auth/status", {
      headers: { Cookie: cookie },
    });
    expect(initialStatus.status).toBe(200);
    expect(
      await responseJson<{ authenticated: boolean }>(initialStatus),
    ).toEqual({
      authRequired: true,
      authenticated: true,
    });

    // Close runtime and create a new runtime with empty in-memory sessions pointing to same db
    runtime.db.close();
    const config = createServerConfig({
      NODE_ENV: "test",
      AUTH_PASSWORD: "test-password",
    });
    const restartedRuntime = createRuntime({
      dbPath: path.join(directory, "excalidraw.db"),
      filesDir: path.join(directory, "files"),
      config,
    });
    runtimes.push(restartedRuntime);
    const restartedHandler = createRequestHandler(restartedRuntime);

    // Verify session is restored from SQLite
    const restoredStatus = await request(restartedHandler, "/api/auth/status", {
      headers: { Cookie: cookie },
    });
    expect(restoredStatus.status).toBe(200);
    expect(
      await responseJson<{ authenticated: boolean }>(restoredStatus),
    ).toEqual({
      authRequired: true,
      authenticated: true,
    });
  });

  it("supports soft deleting scenes, trash viewing, restoring and permanent deletion", async () => {
    const { handler } = createTestRuntime();
    const cookie = await authenticate(handler);

    // Create scene
    await jsonRequest(
      handler,
      "/api/scenes",
      {
        id: "scene_trash_test",
        name: "待删除画板",
        elements: [],
        appState: {},
      },
      { headers: { Cookie: cookie } },
    );

    // 1. Soft delete
    const softDelete = await request(handler, "/api/scenes/scene_trash_test", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(softDelete.status).toBe(200);
    const softDeleteBody = await responseJson<{ permanent: boolean }>(
      softDelete,
    );
    expect(softDeleteBody.permanent).toBe(false);

    // 2. Normal /api/scenes should not contain it
    const activeList = await request(handler, "/api/scenes", {
      headers: { Cookie: cookie },
    });
    expect(await responseJson<Array<{ id: string }>>(activeList)).toEqual([]);

    // 3. /api/scenes/trash should contain it
    const trashList = await request(handler, "/api/scenes/trash", {
      headers: { Cookie: cookie },
    });
    const trashItems = await responseJson<
      Array<{ id: string; name: string; deleted_at: number | null }>
    >(trashList);
    expect(trashItems.length).toBe(1);
    expect(trashItems[0].id).toBe("scene_trash_test");
    expect(trashItems[0].deleted_at).toBeTruthy();

    // 4. Restore scene
    const restoreRes = await request(
      handler,
      "/api/scenes/scene_trash_test/restore",
      {
        method: "POST",
        headers: { Cookie: cookie },
      },
    );
    expect(restoreRes.status).toBe(200);

    // 5. Normal /api/scenes should contain it again
    const activeAfterRestore = await request(handler, "/api/scenes", {
      headers: { Cookie: cookie },
    });
    const activeItems = await responseJson<Array<{ id: string }>>(
      activeAfterRestore,
    );
    expect(activeItems.length).toBe(1);
    expect(activeItems[0].id).toBe("scene_trash_test");

    // 6. Permanent delete
    const permanentDelete = await request(
      handler,
      "/api/scenes/scene_trash_test?permanent=true",
      {
        method: "DELETE",
        headers: { Cookie: cookie },
      },
    );
    expect(permanentDelete.status).toBe(200);
    expect(
      (await responseJson<{ permanent: boolean }>(permanentDelete)).permanent,
    ).toBe(true);

    // 7. Should be absent from both active and trash
    const trashAfterPerm = await request(handler, "/api/scenes/trash", {
      headers: { Cookie: cookie },
    });
    expect(await responseJson<Array<unknown>>(trashAfterPerm)).toEqual([]);

    // 8. Test emptying trash via DELETE /api/scenes/trash
    await jsonRequest(
      handler,
      "/api/scenes",
      { id: "scene_trash_clear1", name: "清空画板1" },
      { headers: { Cookie: cookie } },
    );
    await jsonRequest(
      handler,
      "/api/scenes",
      { id: "scene_trash_clear2", name: "清空画板2" },
      { headers: { Cookie: cookie } },
    );
    await request(handler, "/api/scenes/scene_trash_clear1", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    await request(handler, "/api/scenes/scene_trash_clear2", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    const clearTrashRes = await request(handler, "/api/scenes/trash", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(clearTrashRes.status).toBe(200);
    expect(
      await responseJson<{ success: boolean; deletedCount: number }>(
        clearTrashRes,
      ),
    ).toEqual({
      success: true,
      deletedCount: 2,
    });
    const trashAfterClear = await request(handler, "/api/scenes/trash", {
      headers: { Cookie: cookie },
    });
    expect(await responseJson<Array<unknown>>(trashAfterClear)).toEqual([]);
  });

  it("persists board metadata, folders, recent opens and thumbnails", async () => {
    const { handler, runtime } = createTestRuntime();
    const cookie = await authenticate(handler);

    const folderResponse = await jsonRequest(
      handler,
      "/api/folders",
      { name: "产品设计" },
      { headers: { Cookie: cookie } },
    );
    expect(folderResponse.status).toBe(201);
    const folder = await responseJson<{ id: string }>(folderResponse);

    const createdResponse = await jsonRequest(
      handler,
      "/api/scenes",
      {
        id: "scene_metadata",
        name: "路线图",
        tags: ["产品", " 规划", "产品"],
        favorite: true,
        folder_id: folder.id,
        elements: [],
        appState: {},
      },
      { headers: { Cookie: cookie } },
    );
    expect(createdResponse.status).toBe(201);
    const created = await responseJson<{
      tags: string[];
      favorite: boolean;
      folder_id: string;
    }>(createdResponse);
    expect(created.tags).toEqual(["产品", "规划"]);
    expect(created.favorite).toBe(true);
    expect(created.folder_id).toBe(folder.id);

    const opened = await request(handler, "/api/scenes/scene_metadata/open", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(opened.status).toBe(200);

    const thumbnail = await request(
      handler,
      "/api/scenes/scene_metadata/thumbnail",
      {
        method: "PUT",
        headers: {
          Cookie: cookie,
          "Content-Type": "image/jpeg",
          "X-Thumbnail-Version": "100",
        },
        body: new Uint8Array([255, 216, 255, 217]),
      },
    );
    expect(thumbnail.status).toBe(200);
    const thumbnailResult = await responseJson<{
      thumbnail_file_id: string;
    }>(thumbnail);
    expect(thumbnailResult.thumbnail_file_id).toMatch(
      /^thumbnail_[a-f0-9]{64}$/,
    );
    const thumbnailFile = await request(
      handler,
      `/api/files/${thumbnailResult.thumbnail_file_id}`,
      { headers: { Cookie: cookie, Accept: "image/jpeg" } },
    );
    expect(thumbnailFile.status).toBe(200);
    expect(thumbnailFile.headers.get("cache-control")).toContain("no-cache");
    expect(new Uint8Array(await thumbnailFile.arrayBuffer())).toEqual(
      new Uint8Array([255, 216, 255, 217]),
    );

    const staleThumbnail = await request(
      handler,
      "/api/scenes/scene_metadata/thumbnail",
      {
        method: "PUT",
        headers: {
          Cookie: cookie,
          "Content-Type": "image/jpeg",
          "X-Thumbnail-Version": "99",
        },
        body: new Uint8Array([1, 2, 3, 4]),
      },
    );
    expect(staleThumbnail.status).toBe(200);
    expect(
      await responseJson<{ stale?: boolean }>(staleThumbnail),
    ).toMatchObject({ stale: true });
    const unchangedThumbnail = await request(
      handler,
      `/api/files/${thumbnailResult.thumbnail_file_id}`,
      { headers: { Cookie: cookie, Accept: "image/jpeg" } },
    );
    expect(new Uint8Array(await unchangedThumbnail.arrayBuffer())).toEqual(
      new Uint8Array([255, 216, 255, 217]),
    );

    const updated = await jsonRequest(
      handler,
      "/api/scenes/scene_metadata",
      { tags: ["交付"], favorite: false, baseRevision: 1 },
      { method: "PATCH", headers: { Cookie: cookie } },
    );
    expect(updated.status).toBe(200);

    const list = await request(handler, "/api/scenes", {
      headers: { Cookie: cookie },
    });
    const scenes = await responseJson<
      Array<{
        tags: string[];
        favorite: boolean;
        folder_id: string;
        last_opened_at: number;
        thumbnail_file_id: string;
      }>
    >(list);
    expect(scenes[0]).toMatchObject({
      tags: ["交付"],
      favorite: false,
      folder_id: folder.id,
      thumbnail_file_id: thumbnailResult.thumbnail_file_id,
    });
    expect(scenes[0].last_opened_at).toBeGreaterThan(0);
    expect(
      runtime.db
        .query("SELECT storage_path FROM files WHERE id = ?")
        .get(thumbnailResult.thumbnail_file_id),
    ).toEqual({ storage_path: thumbnailResult.thumbnail_file_id });

    const deletedFolder = await request(handler, `/api/folders/${folder.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(deletedFolder.status).toBe(200);
    const scene = await request(handler, "/api/scenes/scene_metadata", {
      headers: { Cookie: cookie },
    });
    expect(
      (await responseJson<{ folder_id: string | null }>(scene)).folder_id,
    ).toBe(null);
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
    const csp = res.headers.get("content-security-policy");
    expect(csp).toBeTruthy();
    expect(csp).toContain(
      "default-src 'self'",
    );
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' blob:");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-(?:inline|eval)/);
    expect(csp).toContain(
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

  it("exports a complete backup containing the database, manifest and attachments", async () => {
    const { handler } = createTestRuntime();
    const cookie = await authenticate(handler);
    const upload = await request(handler, "/api/files/file_full_backup", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "image/png" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(upload.status).toBe(201);
    const scene = await jsonRequest(
      handler,
      "/api/scenes",
      {
        id: "scene_full_backup",
        name: "完整备份画板",
        elements: [
          { id: "image-1", type: "image", fileId: "file_full_backup" },
        ],
        appState: {},
      },
      { headers: { Cookie: cookie } },
    );
    expect(scene.status).toBe(201);

    const backup = await request(handler, "/api/backup/full", {
      headers: { Cookie: cookie },
    });
    expect(backup.status).toBe(200);
    expect(backup.headers.get("content-type")).toContain("application/x-tar");
    const archive = new Bun.Archive(await backup.blob());
    const files = await archive.files();
    expect([...files.keys()]).toEqual(
      expect.arrayContaining([
        "excalidraw.db",
        "manifest.json",
        "files/file_full_backup",
      ]),
    );
    const manifest = JSON.parse(await files.get("manifest.json")!.text()) as {
      format: string;
      files: Array<{ id: string; path: string }>;
    };
    const database = files.get("excalidraw.db")!;
    expect(database.size).toBeGreaterThan(0);
    expect(
      new TextDecoder().decode((await database.arrayBuffer()).slice(0, 15)),
    ).toBe("SQLite format 3");
    expect(
      new Uint8Array(await files.get("files/file_full_backup")!.arrayBuffer()),
    ).toEqual(new Uint8Array([1, 2, 3]));
    expect(manifest.format).toBe("excalidraw-full-backup");
    expect(manifest.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "file_full_backup",
          path: "files/file_full_backup",
        }),
      ]),
    );
  });

  it("migrates legacy data URLs and rebuilds scene file references", async () => {
    const root = Bun.env.TEMP || Bun.env.TMP || ".";
    const directory = `${root}/excalidraw-server-legacy-${crypto.randomUUID()}`;
    const dbPath = path.join(directory, "excalidraw.db");
    const filesDir = path.join(directory, "files");
    await fs.mkdir(filesDir, { recursive: true });
    const legacyDb = new Database(dbPath);
    legacyDb.run(
      `CREATE TABLE scenes (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, elements TEXT NOT NULL,
        app_state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`,
    );
    legacyDb.run(
      `CREATE TABLE files (
        id TEXT PRIMARY KEY, data_url TEXT NOT NULL, mime_type TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    legacyDb.run(
      `CREATE TABLE scene_files (
        scene_id TEXT NOT NULL, file_id TEXT NOT NULL,
        PRIMARY KEY (scene_id, file_id)
      )`,
    );
    legacyDb.run(
      "INSERT INTO files (id, data_url, mime_type, created_at) VALUES (?, ?, ?, ?)",
      ["legacy_image", "data:image/png;base64,AQID", "image/png", 1],
    );
    legacyDb.run(
      "INSERT INTO files (id, data_url, mime_type, created_at) VALUES (?, ?, ?, ?)",
      ["legacy_invalid", "not-a-data-url", "image/png", 1],
    );
    legacyDb.run(
      "INSERT INTO scenes (id, name, elements, app_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "legacy_scene",
        "旧画板",
        JSON.stringify([
          { id: "image-1", type: "image", fileId: "legacy_image" },
        ]),
        "{}",
        1,
        1,
      ],
    );
    legacyDb.close();

    const config = createServerConfig({
      NODE_ENV: "test",
      AUTH_PASSWORD: "test-password",
      ALLOW_ANONYMOUS: "true",
    });
    const runtime = createRuntime({ dbPath, filesDir, config });
    runtimes.push(runtime);
    testDirectories.push(directory);
    const migrated = runtime.db
      .query("SELECT storage_path, byte_size, data_url FROM files WHERE id = ?")
      .get("legacy_image") as {
      storage_path: string;
      byte_size: number;
      data_url: string;
    };
    expect(migrated).toMatchObject({
      storage_path: "legacy_image",
      byte_size: 3,
      data_url: "",
    });
    expect(await fs.readFile(path.join(filesDir, "legacy_image"))).toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect(
      runtime.db
        .query("SELECT COUNT(*) AS count FROM scene_files WHERE scene_id = ?")
        .get("legacy_scene"),
    ).toEqual({ count: 1 });
    const invalid = runtime.db
      .query("SELECT data_url FROM files WHERE id = ?")
      .get("legacy_invalid") as { data_url: string };
    expect(invalid.data_url).toBe("not-a-data-url");
    expect(
      (
        runtime.db.query("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
    ).toBe(3);
  });
});
