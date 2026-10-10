import { existsSync } from "node:fs";
import fs, { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import {
  createRequestHandler,
  createRuntime,
  createServerConfig,
  cleanupStaleFileArtifacts,
  resolveServerHostname,
  type ServerRuntime,
} from "../../server/server";
import { createDatabaseSnapshot } from "../../server/backup";
import { readJson, releaseJsonBodyMemoryBudget } from "../../server/http";
import {
  cleanupUntrackedFiles,
  withStorageMutationLock,
} from "../../server/files";
import { BodyMemoryBudget } from "../../server/types";
import { cleanupExpiredTrashScenes } from "../../server/scenes";

const runtimes: ServerRuntime[] = [];
const testDirectories: string[] = [];

const createTestRuntime = (env: Record<string, string | undefined> = {}) => {
  const root = os.tmpdir();
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
  it("authorizes workspace statistics and returns an empty workspace", async () => {
    const { handler } = createTestRuntime();
    expect((await request(handler, "/api/workspace/stats")).status).toBe(401);
    const cookie = await authenticate(handler);
    const stats = await request(handler, "/api/workspace/stats", {
      headers: { Cookie: cookie },
    });
    expect(stats.status).toBe(200);
    expect(await responseJson(stats)).toEqual({
      sceneCount: 0,
      favoriteCount: 0,
      trashCount: 0,
      tags: [],
    });
  });

  it("counts the whole workspace and filtered pages independently of pagination", async () => {
    const { runtime, handler } = createTestRuntime();
    const cookie = await authenticate(handler);
    const headers = { Cookie: cookie };
    const folderResponse = await jsonRequest(
      handler,
      "/api/folders",
      { name: "统计文件夹" },
      { headers },
    );
    const folder = await responseJson<{ id: string }>(folderResponse);
    const insertScene = runtime.db.prepare(`
      INSERT INTO scenes
        (id, name, elements, app_state, created_at, updated_at, tags_json,
         is_favorite, folder_id, last_opened_at, deleted_at)
      VALUES (?, ?, '[]', '{}', 1, ?, ?, ?, ?, ?, ?)
    `);
    for (let index = 0; index < 105; index++) {
      const tags = ["共享"];
      if (index === 0) {
        tags.push("精确");
      }
      if (index === 1) {
        tags.push("精确扩展");
      }
      if (index === 104) {
        tags.push("尾页");
      }
      insertScene.run(
        `stats_${index}`,
        index === 2 ? "唯一搜索" : `分页 ${index}`,
        1000 + index,
        JSON.stringify(tags),
        index % 2 === 0 ? 1 : 0,
        index < 3 ? folder.id : null,
        index < 4 ? 100 + index : null,
        null,
      );
    }
    for (let index = 0; index < 3; index++) {
      insertScene.run(
        `stats_deleted_${index}`,
        "回收站画板",
        index,
        '["垃圾专属"]',
        1,
        folder.id,
        null,
        100 + index,
      );
    }
    insertScene.finalize();

    const readStats = async () =>
      responseJson<{
        sceneCount: number;
        favoriteCount: number;
        trashCount: number;
        tags: string[];
      }>(await request(handler, "/api/workspace/stats", { headers }));
    const initialStats = await readStats();
    expect(initialStats).toEqual({
      sceneCount: 105,
      favoriteCount: 53,
      trashCount: 3,
      tags: ["共享", "尾页", "精确", "精确扩展"],
    });
    type Page = {
      items: Array<{ id: string }>;
      nextCursor: string | null;
      totalCount: number;
    };
    const readPage = async (pathname: string) => {
      const response = await request(handler, pathname, { headers });
      expect(response.status).toBe(200);
      return responseJson<Page>(response);
    };
    const firstPage = await readPage("/api/scenes?limit=100");
    expect(firstPage.items).toHaveLength(100);
    expect(firstPage.totalCount).toBe(105);
    expect(firstPage.nextCursor).toBeTruthy();
    const secondPage = await readPage(
      `/api/scenes?limit=100&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    );
    expect(secondPage.items).toHaveLength(5);
    expect(secondPage.totalCount).toBe(105);
    expect(secondPage.nextCursor).toBeNull();

    for (const [query, count] of [
      ["favorite=true", 53],
      [`folder_id=${folder.id}`, 3],
      ["q=唯一搜索", 1],
      ["q=不存在", 0],
      ["opened=true&sort=opened", 4],
      ["opened=false", 101],
      ["tag=精确", 1],
      ["tag=精确&q=分页", 1],
      ["tag=精确&q=唯一搜索", 0],
    ] as const) {
      const filtered = await readPage(`/api/scenes?${query}&limit=1`);
      expect(filtered.totalCount).toBe(count);
      expect(filtered.items).toHaveLength(count > 0 ? 1 : 0);
      if (filtered.nextCursor) {
        const next = await readPage(
          `/api/scenes?${query}&limit=1&cursor=${encodeURIComponent(filtered.nextCursor)}`,
        );
        expect(next.totalCount).toBe(count);
      }
      expect(await readStats()).toEqual(initialStats);
    }
    const tagged = await readPage("/api/scenes?tag=精确");
    expect(tagged.items.map(({ id }) => id)).toEqual(["stats_0"]);
    const trashPage = await readPage("/api/scenes/trash?limit=1");
    expect(trashPage.totalCount).toBe(3);
    const nextTrashPage = await readPage(
      `/api/scenes/trash?limit=1&cursor=${encodeURIComponent(trashPage.nextCursor!)}`,
    );
    expect(nextTrashPage.totalCount).toBe(3);

    const updated = await jsonRequest(
      handler,
      "/api/scenes/stats_1",
      { favorite: true, tags: ["共享", "更新标签"] },
      { method: "PATCH", headers },
    );
    expect(updated.status).toBe(200);
    expect(await readStats()).toEqual({
      sceneCount: 105,
      favoriteCount: 54,
      trashCount: 3,
      tags: ["共享", "尾页", "更新标签", "精确"],
    });
    const deleted = await request(handler, "/api/scenes/stats_0", {
      method: "DELETE",
      headers,
    });
    expect(deleted.status).toBe(200);
    expect(await readStats()).toEqual({
      sceneCount: 104,
      favoriteCount: 53,
      trashCount: 4,
      tags: ["共享", "尾页", "更新标签"],
    });
    const restored = await request(handler, "/api/scenes/stats_0/restore", {
      method: "POST",
      headers,
    });
    expect(restored.status).toBe(200);
    expect(await readStats()).toEqual({
      sceneCount: 105,
      favoriteCount: 54,
      trashCount: 3,
      tags: ["共享", "尾页", "更新标签", "精确"],
    });
    for (const query of ["opened=invalid", `tag=${"长".repeat(121)}`]) {
      const invalid = await request(handler, `/api/scenes?${query}`, { headers });
      expect(invalid.status).toBe(400);
    }
  });

  it("allows the thumbnail version header in CORS preflight", async () => {
    const { handler } = createTestRuntime({
      CORS_ORIGIN: "https://whiteboard.example",
    });
    const response = await handler(
      new Request("http://localhost/api/scenes/scene/thumbnail", {
        method: "OPTIONS",
        headers: {
          Origin: "https://whiteboard.example",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers":
            "x-thumbnail-version, if-none-match",
        },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "X-Thumbnail-Version",
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "If-None-Match",
    );
  });

  it("exposes ETag on allowed cross-origin responses", async () => {
    const { handler } = createTestRuntime({
      CORS_ORIGIN: "https://whiteboard.example",
    });
    const cookie = await authenticate(handler);
    const created = await jsonRequest(
      handler,
      "/api/scenes",
      { id: "scene_cors_etag", name: "跨域缓存", elements: [] },
      { headers: { Cookie: cookie } },
    );
    expect(created.status).toBe(201);

    const headers = {
      Cookie: cookie,
      Origin: "https://whiteboard.example",
    };
    const scene = await request(handler, "/api/scenes/scene_cors_etag", {
      headers,
    });
    const etag = scene.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(scene.headers.get("access-control-expose-headers")).toContain(
      "ETag",
    );

    const notModified = await request(
      handler,
      "/api/scenes/scene_cors_etag",
      { headers: { ...headers, "If-None-Match": etag! } },
    );
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("access-control-expose-headers")).toContain(
      "ETag",
    );
  });

  it("only exposes the development reload stream over GET", async () => {
    const { handler } = createTestRuntime({
      NODE_ENV: "development",
      ALLOW_ANONYMOUS: "true",
    });
    const response = await request(handler, "/__dev_reload", {
      method: "POST",
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("does not expose the development reload stream in production", async () => {
    const { handler } = createTestRuntime({
      NODE_ENV: "production",
      ALLOW_ANONYMOUS: "true",
    });
    const response = await request(handler, "/__dev_reload");
    expect(response.status).toBe(404);
  });

  it("requires explicit production authentication configuration", () => {
    expect(() => createServerConfig({ NODE_ENV: "production" })).toThrow();
    expect(
      createServerConfig({ NODE_ENV: "production", ALLOW_ANONYMOUS: "true" })
        .allowAnonymous,
    ).toBe(true);
  });

  it("binds development servers to all interfaces and preserves explicit host overrides", () => {
    expect(resolveServerHostname(true, "")).toBe("0.0.0.0");
    expect(resolveServerHostname(false, "")).toBe("0.0.0.0");
    expect(resolveServerHostname(true, "192.0.2.10")).toBe("192.0.2.10");
  });

  it("initializes the current SQLite schema without versioned migrations", () => {
    const { runtime } = createTestRuntime();
    expect(runtime.db.query("PRAGMA user_version").get()).toEqual({
      user_version: 0,
    });
    expect(
      (runtime.db.query("PRAGMA table_info(files)").all() as Array<{
        name: string;
      }>).map((column) => column.name),
    ).toEqual([
      "id",
      "storage_path",
      "mime_type",
      "byte_size",
      "sha256",
      "created_at",
      "updated_at",
    ]);
    expect(
      (runtime.db.query("PRAGMA table_info(scenes)").all() as Array<{
        name: string;
      }>).map((column) => column.name),
    ).toContain("content_sha256");
  });

  it("surfaces configuration errors before opening persistent storage", () => {
    const root = os.tmpdir();
    const directory = `${root}/excalidraw-server-config-${crypto.randomUUID()}`;
    const previousEnvironment = {
      NODE_ENV: process.env.NODE_ENV,
      AUTH_PASSWORD: process.env.AUTH_PASSWORD,
      ALLOW_ANONYMOUS: process.env.ALLOW_ANONYMOUS,
    };

    process.env.NODE_ENV = "production";
    delete process.env.AUTH_PASSWORD;
    delete process.env.ALLOW_ANONYMOUS;

    try {
      expect(() =>
        createRuntime({
          dbPath: path.join(directory, "excalidraw.db"),
          filesDir: path.join(directory, "files"),
        }),
      ).toThrow("AUTH_PASSWORD must be configured");
      expect(existsSync(directory)).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
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

  it("uses the rightmost forwarded address for trusted-proxy rate limits", async () => {
    const { handler } = createTestRuntime({
      TRUST_PROXY: "true",
      AUTH_ATTEMPTS_PER_WINDOW: "5",
    });
    const responses: Response[] = [];
    for (let index = 0; index < 6; index += 1) {
      responses.push(
        await handler(
          new Request("http://localhost/api/auth/verify", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Forwarded-For": `attacker-${index}, 198.51.100.42`,
            },
            body: JSON.stringify({ password: "wrong-password" }),
          }),
        ),
      );
    }
    expect(responses.slice(0, 5).map((response) => response.status)).toEqual(
      [401, 401, 401, 401, 401],
    );
    expect(responses[5].status).toBe(429);
  });

  it("decodes unknown-length JSON across split UTF-8 chunks", async () => {
    const encoded = new TextEncoder().encode('{"ok":true,"name":"白板"}');
    const splitAt = encoded.findIndex((byte) => byte >= 0xe0) + 1;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.subarray(0, splitAt));
        controller.enqueue(encoded.subarray(splitAt));
        controller.close();
      },
    });
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(req.headers.has("content-length")).toBe(false);
    const budget = new BodyMemoryBudget(128);

    await expect(readJson(req, 128, budget)).resolves.toEqual({
      ok: true,
      name: "白板",
    });
    expect(budget.getStats().currentBytes).toBe(128);
    expect(budget.getStats().peakBytes).toBe(128);
    releaseJsonBodyMemoryBudget(req);
    expect(budget.getStats().currentBytes).toBe(0);
  });

  it("holds parsed JSON memory while a write waits and releases it on cancel", async () => {
    const { handler, runtime } = createTestRuntime({
      MAX_SCENE_BODY_BYTES: "1024",
      MAX_IN_FLIGHT_BODY_BYTES: "1024",
    });
    const cookie = await authenticate(handler);
    let finishLock!: () => void;
    let notifyLockStarted!: () => void;
    const lockStarted = new Promise<void>((resolve) => {
      notifyLockStarted = resolve;
    });
    const heldLock = new Promise<void>((resolve) => {
      finishLock = resolve;
    });
    const lock = withStorageMutationLock(runtime, async () => {
      notifyLockStarted();
      await heldLock;
    });
    await lockStarted;

    const controller = new AbortController();
    const pendingRequest = request(handler, "/api/scenes", {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "等待取消", elements: [] }),
      signal: controller.signal,
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (runtime.bodyMemoryBudget.getStats().currentBytes > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(runtime.bodyMemoryBudget.getStats().currentBytes).toBe(1024);

    controller.abort();
    const canceled = await pendingRequest;
    expect(canceled.status).toBe(499);
    expect(runtime.bodyMemoryBudget.getStats().currentBytes).toBe(0);

    finishLock();
    await lock;
  });

  it("serializes untracked-file cleanup with attachment uploads", async () => {
    const { runtime } = createTestRuntime();
    const id = "file_cleanup_race";
    const filePath = path.join(runtime.filesDir, id);
    await fs.writeFile(filePath, new Uint8Array([1, 2, 3]));
    const staleTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await fs.utimes(filePath, staleTime, staleTime);

    let releaseLock!: () => void;
    let notifyLockStarted!: () => void;
    const lockStarted = new Promise<void>((resolve) => {
      notifyLockStarted = resolve;
    });
    const heldLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const uploadLock = withStorageMutationLock(runtime, async () => {
      notifyLockStarted();
      await heldLock;
    });
    await lockStarted;

    let cleanupFinished = false;
    const cleanup = cleanupUntrackedFiles(runtime).then(() => {
      cleanupFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cleanupFinished).toBe(false);
    expect(existsSync(filePath)).toBe(true);

    const bytes = new Uint8Array([9, 8, 7]);
    await fs.writeFile(filePath, bytes);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    runtime.db.run(
      `INSERT INTO files
       (id, storage_path, mime_type, byte_size, sha256, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        id,
        "image/png",
        bytes.byteLength,
        hasher.digest("hex"),
        Date.now(),
        Date.now(),
      ],
    );

    releaseLock();
    await Promise.all([uploadLock, cleanup]);
    expect(await fs.readFile(filePath)).toEqual(Buffer.from(bytes));
  });

  it("rejects unknown-length JSON once its byte limit is exceeded", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"too":"large"}'));
        controller.close();
      },
    });
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);

    await expect(readJson(req, 8)).rejects.toMatchObject({ status: 413 });
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

  it("guards concurrent scene saves with an atomic revision check", async () => {
    const { handler } = createTestRuntime();
    const cookie = await authenticate(handler);

    const upload = await request(handler, "/api/files/file_race", {
      method: "PUT",
      headers: {
        Cookie: cookie,
        "Content-Type": "image/png",
      },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(upload.status).toBe(201);

    const createdResponse = await jsonRequest(
      handler,
      "/api/scenes",
      { id: "scene_race", elements: [], appState: {} },
      { headers: { Cookie: cookie } },
    );
    const created = await responseJson<{ revision: number }>(createdResponse);

    const save = (elementId: string) =>
      jsonRequest(
        handler,
        "/api/scenes/scene_race",
        {
          elements: [
            { id: elementId, type: "image", fileId: "file_race" },
          ],
          appState: {},
          baseRevision: created.revision,
        },
        { method: "PUT", headers: { Cookie: cookie } },
      );

    const responses = await Promise.all([save("element-a"), save("element-b")]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200,
      409,
    ]);

    const sceneResponse = await request(handler, "/api/scenes/scene_race", {
      headers: { Cookie: cookie },
    });
    const scene = await responseJson<{
      revision: number;
      elements: Array<{ id: string }>;
    }>(sceneResponse);
    expect(scene.revision).toBe(created.revision + 1);
    expect(["element-a", "element-b"]).toContain(scene.elements[0]?.id);
  });

  it("paginates scene summaries and supports conditional scene reads", async () => {
    const { handler } = createTestRuntime();
    const cookie = await authenticate(handler);
    for (const [id, name] of [
      ["scene_page_a", "分页 A"],
      ["scene_page_b", "分页 B"],
      ["scene_page_c", "分页 C"],
    ]) {
      const created = await jsonRequest(
        handler,
        "/api/scenes",
        { id, name, elements: [], appState: {} },
        { headers: { Cookie: cookie } },
      );
      expect(created.status).toBe(201);
    }

    const firstPage = await request(handler, "/api/scenes?limit=2", {
      headers: { Cookie: cookie },
    });
    expect(firstPage.status).toBe(200);
    const firstPageBody = await responseJson<{
      items: Array<{ id: string }>;
      nextCursor: string | null;
    }>(firstPage);
    expect(firstPageBody.items).toHaveLength(2);
    expect(firstPageBody.nextCursor).toBeTruthy();

    const secondPage = await request(
      handler,
      `/api/scenes?limit=2&cursor=${encodeURIComponent(
        firstPageBody.nextCursor!,
      )}`,
      { headers: { Cookie: cookie } },
    );
    const secondPageBody = await responseJson<{
      items: Array<{ id: string }>;
      nextCursor: string | null;
    }>(secondPage);
    expect(secondPageBody.items).toHaveLength(1);
    expect(
      new Set([
        ...firstPageBody.items.map((item) => item.id),
        ...secondPageBody.items.map((item) => item.id),
      ]),
    ).toEqual(
      new Set(["scene_page_a", "scene_page_b", "scene_page_c"]),
    );

    const filtered = await request(handler, "/api/scenes?q=%E5%88%86%E9%A1%B5%20B", {
      headers: { Cookie: cookie },
    });
    expect(
      (await responseJson<{ items: Array<{ id: string }> }>(filtered)).items,
    ).toEqual([expect.objectContaining({ id: "scene_page_b" })]);

    const sceneResponse = await request(handler, "/api/scenes/scene_page_a", {
      headers: { Cookie: cookie },
    });
    const sceneEtag = sceneResponse.headers.get("etag");
    expect(sceneEtag).toBeTruthy();
    const notModified = await request(handler, "/api/scenes/scene_page_a", {
      headers: { Cookie: cookie, "If-None-Match": sceneEtag! },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("etag")).toBe(sceneEtag);

    const opened = await request(handler, "/api/scenes/scene_page_a/open", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(opened.status).toBe(200);
    const afterOpen = await request(handler, "/api/scenes/scene_page_a", {
      headers: { Cookie: cookie, "If-None-Match": sceneEtag! },
    });
    expect(afterOpen.status).toBe(200);
    expect(
      (await responseJson<{ last_opened_at: number }>(afterOpen))
        .last_opened_at,
    ).toBeGreaterThan(0);

    const openedEtag = afterOpen.headers.get("etag");
    const thumbnail = await request(
      handler,
      "/api/scenes/scene_page_a/thumbnail",
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
    const afterThumbnail = await request(handler, "/api/scenes/scene_page_a", {
      headers: { Cookie: cookie, "If-None-Match": openedEtag! },
    });
    expect(afterThumbnail.status).toBe(200);
    expect(
      (await responseJson<{ thumbnail_file_id: string | null }>(
        afterThumbnail,
      )).thumbnail_file_id,
    ).toMatch(/^thumbnail_/);

    const thumbnailEtag = afterThumbnail.headers.get("etag");
    const thumbnailDeleted = await request(
      handler,
      "/api/scenes/scene_page_a/thumbnail",
      {
        method: "DELETE",
        headers: { Cookie: cookie, "X-Thumbnail-Version": "101" },
      },
    );
    expect(thumbnailDeleted.status).toBe(200);
    const afterThumbnailDelete = await request(
      handler,
      "/api/scenes/scene_page_a",
      { headers: { Cookie: cookie, "If-None-Match": thumbnailEtag! } },
    );
    expect(afterThumbnailDelete.status).toBe(200);
    expect(
      (await responseJson<{ thumbnail_file_id: string | null }>(
        afterThumbnailDelete,
      )).thumbnail_file_id,
    ).toBe(null);

    const summaryResponse = await request(
      handler,
      "/api/scenes/scene_page_a/summary",
      { headers: { Cookie: cookie } },
    );
    expect(summaryResponse.status).toBe(200);
    const summary = await responseJson<{
      id: string;
      name: string;
      element_count: number;
      elements?: unknown;
    }>(summaryResponse);
    expect(summary).toEqual(
      expect.objectContaining({
        id: "scene_page_a",
        name: "分页 A",
        element_count: 0,
      }),
    );
    expect(summary.elements).toBeUndefined();

    const openedPage = await request(
      handler,
      "/api/scenes?limit=2&sort=opened",
      { headers: { Cookie: cookie } },
    );
    expect(openedPage.status).toBe(200);
    expect(
      (await responseJson<{ items: Array<{ id: string }> }>(openedPage)).items,
    ).toHaveLength(2);

    const invalidSort = await request(
      handler,
      "/api/scenes?sort=unsupported",
      { headers: { Cookie: cookie } },
    );
    expect(invalidSort.status).toBe(400);
  });

  it("always returns a bounded page for scene and trash lists", async () => {
    const { handler, runtime } = createTestRuntime();
    const cookie = await authenticate(handler);
    const insert = runtime.db.query(
      `INSERT INTO scenes (id, name, elements, app_state, created_at, updated_at, deleted_at)
       VALUES (?, ?, '[]', '{}', ?, ?, ?)`,
    );
    const seedScenes = runtime.db.transaction(() => {
      for (let index = 0; index < 1_001; index += 1) {
        const timestamp = Date.now() + index;
        insert.run(
          `scene_legacy_active_${index}`,
          `Active ${index}`,
          timestamp,
          timestamp,
          null,
        );
        insert.run(
          `scene_legacy_trash_${index}`,
          `Trash ${index}`,
          timestamp,
          timestamp,
          timestamp,
        );
      }
    });
    seedScenes.immediate();

    const active = await request(handler, "/api/scenes", {
      headers: { Cookie: cookie },
    });
    expect(active.status).toBe(200);
    const activePage = await responseJson<{
      items: Array<{ id: string }>;
      nextCursor: string | null;
    }>(active);
    expect(activePage.items).toHaveLength(50);
    expect(activePage.nextCursor).toBeTruthy();

    const trash = await request(handler, "/api/scenes/trash", {
      headers: { Cookie: cookie },
    });
    expect(trash.status).toBe(200);
    const trashPage = await responseJson<{
      items: Array<{ id: string }>;
      nextCursor: string | null;
    }>(trash);
    expect(trashPage.items).toHaveLength(50);
    expect(trashPage.nextCursor).toBeTruthy();
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

    const download = await request(handler, "/api/files/file_test", {
      headers: { Cookie: cookie, Accept: "application/octet-stream" },
    });
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
    expect(download.headers.get("content-type")).toContain("image/png");
    expect(download.headers.get("cache-control")).toContain("no-cache");
    const fileEtag = download.headers.get("etag");
    expect(fileEtag).toBeTruthy();

    const defaultDownload = await request(handler, "/api/files/file_test", {
      headers: { Cookie: cookie },
    });
    expect(defaultDownload.headers.get("content-type")).toContain("image/png");
    expect(new Uint8Array(await defaultDownload.arrayBuffer())).toEqual(bytes);

    const notModifiedDownload = await request(handler, "/api/files/file_test", {
      headers: {
        Cookie: cookie,
        Accept: "application/octet-stream",
        "If-None-Match": fileEtag!,
      },
    });
    expect(notModifiedDownload.status).toBe(304);
    expect(notModifiedDownload.headers.get("etag")).toBe(fileEtag);

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

  it("revalidates an overwritten file ID and returns its new content", async () => {
    const { handler } = createTestRuntime();
    const cookie = await authenticate(handler);
    const initialBytes = new Uint8Array([1, 2, 3]);
    const replacementBytes = new Uint8Array([9, 8, 7, 6]);
    const upload = (body: Uint8Array) => {
      const payload = new ArrayBuffer(body.byteLength);
      new Uint8Array(payload).set(body);
      return request(handler, "/api/files/file_cache_validation", {
        method: "PUT",
        headers: { Cookie: cookie, "Content-Type": "image/png" },
        body: payload,
      });
    };

    expect((await upload(initialBytes)).status).toBe(201);
    const original = await request(
      handler,
      "/api/files/file_cache_validation",
      { headers: { Cookie: cookie } },
    );
    const originalEtag = original.headers.get("etag");
    expect(original.status).toBe(200);
    expect(original.headers.get("cache-control")).toBe("private, no-cache");
    expect(originalEtag).toBeTruthy();
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(initialBytes);

    expect((await upload(replacementBytes)).status).toBe(201);
    const revalidated = await request(
      handler,
      "/api/files/file_cache_validation",
      {
        headers: { Cookie: cookie, "If-None-Match": originalEtag! },
      },
    );
    expect(revalidated.status).toBe(200);
    expect(revalidated.headers.get("etag")).not.toBe(originalEtag);
    expect(revalidated.headers.get("cache-control")).toBe("private, no-cache");
    expect(new Uint8Array(await revalidated.arrayBuffer())).toEqual(
      replacementBytes,
    );

    const currentEtag = revalidated.headers.get("etag");
    const unchanged = await request(
      handler,
      "/api/files/file_cache_validation",
      { headers: { Cookie: cookie, "If-None-Match": currentEtag! } },
    );
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("etag")).toBe(currentEtag);
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
      await responseJson<{ authRequired: boolean; authenticated: boolean }>(
        initialStatus,
      ),
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
      await responseJson<{ authRequired: boolean; authenticated: boolean }>(
        restoredStatus,
      ),
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
    const softDeleteBody = await responseJson<{
      permanent: boolean;
      deleted_at: number;
    }>(softDelete);
    expect(softDeleteBody.permanent).toBe(false);
    expect(softDeleteBody.deleted_at).toBeGreaterThan(0);

    // 1.1 Repeat soft delete should be idempotent and preserve deleted_at
    const repeatSoftDelete = await request(
      handler,
      "/api/scenes/scene_trash_test",
      {
        method: "DELETE",
        headers: { Cookie: cookie },
      },
    );
    expect(repeatSoftDelete.status).toBe(200);
    const repeatDeleteBody = await responseJson<{
      deleted: boolean;
      deleted_at: number;
    }>(repeatSoftDelete);
    expect(repeatDeleteBody.deleted_at).toBe(softDeleteBody.deleted_at);

    // 2. Normal /api/scenes should not contain it
    const activeList = await request(handler, "/api/scenes?limit=100", {
      headers: { Cookie: cookie },
    });
    expect(
      (await responseJson<{ items: Array<{ id: string }> }>(activeList)).items,
    ).toEqual([]);

    // 3. /api/scenes/trash should contain it
    const trashList = await request(handler, "/api/scenes/trash?limit=100", {
      headers: { Cookie: cookie },
    });
    const trashItems = (
      await responseJson<{
        items: Array<{ id: string; name: string; deleted_at: number | null }>;
      }>(trashList)
    ).items;
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
    expect(await responseJson<{ restored: boolean }>(restoreRes)).toMatchObject({
      restored: true,
    });

    // 4.1 Repeat restore on an active scene should be idempotent and return restored: false
    const repeatRestoreRes = await request(
      handler,
      "/api/scenes/scene_trash_test/restore",
      {
        method: "POST",
        headers: { Cookie: cookie },
      },
    );
    expect(repeatRestoreRes.status).toBe(200);
    expect(
      await responseJson<{
        success: boolean;
        id: string;
        restored: boolean;
      }>(repeatRestoreRes),
    ).toEqual({
      success: true,
      id: "scene_trash_test",
      restored: false,
    });

    // 5. Normal /api/scenes should contain it again
    const activeAfterRestore = await request(
      handler,
      "/api/scenes?limit=100",
      {
        headers: { Cookie: cookie },
      },
    );
    const activeItems = (
      await responseJson<{ items: Array<{ id: string }> }>(activeAfterRestore)
    ).items;
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
    const trashAfterPerm = await request(
      handler,
      "/api/scenes/trash?limit=100",
      {
        headers: { Cookie: cookie },
      },
    );
    expect(
      (await responseJson<{ items: Array<unknown> }>(trashAfterPerm)).items,
    ).toEqual([]);

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
    const trashAfterClear = await request(
      handler,
      "/api/scenes/trash?limit=100",
      {
      headers: { Cookie: cookie },
      },
    );
    expect(
      (await responseJson<{ items: Array<unknown> }>(trashAfterClear)).items,
    ).toEqual([]);
  });

  it("performs revision-checked scene batch trash, restore, and permanent deletion atomically", async () => {
    const { handler } = createTestRuntime();
    const cookie = await authenticate(handler);
    const ids = ["scene_batch_a", "scene_batch_b"];
    for (const id of ids) {
      const created = await jsonRequest(
        handler,
        "/api/scenes",
        { id, name: id, elements: [] },
        { headers: { Cookie: cookie } },
      );
      expect(created.status).toBe(201);
    }
    const entries = ids.map((id) => ({ id, revision: 1 }));

    const staleBatch = await jsonRequest(
      handler,
      "/api/scenes/batch",
      { scenes: [entries[0], { ...entries[1], revision: 2 }] },
      { method: "PATCH", headers: { Cookie: cookie } },
    );
    expect(staleBatch.status).toBe(409);
    const trashAfterStaleAttempt = await request(
      handler,
      "/api/scenes/trash?limit=100",
      { headers: { Cookie: cookie } },
    );
    expect(
      (await responseJson<{ items: Array<{ id: string }> }>(
        trashAfterStaleAttempt,
      )).items,
    ).toEqual([]);

    const trashed = await jsonRequest(
      handler,
      "/api/scenes/batch",
      { scenes: entries },
      { method: "PATCH", headers: { Cookie: cookie } },
    );
    expect(trashed.status).toBe(200);
    expect(
      await responseJson<{ ids: string[]; deleted: boolean }>(trashed),
    ).toMatchObject({ ids, deleted: true });

    const restored = await jsonRequest(
      handler,
      "/api/scenes/batch",
      { scenes: entries, deleted: false },
      { method: "PATCH", headers: { Cookie: cookie } },
    );
    expect(restored.status).toBe(200);
    expect(
      await responseJson<{ ids: string[]; deleted: boolean }>(restored),
    ).toMatchObject({ ids, deleted: false });

    const invalidPermanentDelete = await jsonRequest(
      handler,
      "/api/scenes/batch",
      { scenes: entries },
      { method: "DELETE", headers: { Cookie: cookie } },
    );
    expect(invalidPermanentDelete.status).toBe(409);

    const trashedAgain = await jsonRequest(
      handler,
      "/api/scenes/batch",
      { scenes: entries },
      { method: "PATCH", headers: { Cookie: cookie } },
    );
    expect(trashedAgain.status).toBe(200);
    const permanentlyDeleted = await jsonRequest(
      handler,
      "/api/scenes/batch",
      { scenes: entries },
      { method: "DELETE", headers: { Cookie: cookie } },
    );
    expect(permanentlyDeleted.status).toBe(200);
    expect(
      await responseJson<{ ids: string[]; permanent: boolean }>(
        permanentlyDeleted,
      ),
    ).toMatchObject({ ids, permanent: true });
  });

  it("persists board metadata, folders, recent opens and thumbnails", async () => {
    const { handler, runtime } = createTestRuntime();
    const cookie = await authenticate(handler);

    const folderResponse = await jsonRequest(
      handler,
      "/api/folders",
      { name: "产品设计", icon: "palette", color: "#4E8290" },
      { headers: { Cookie: cookie } },
    );
    expect(folderResponse.status).toBe(201);
    const folder = await responseJson<{
      id: string;
      icon: string;
      color: string;
    }>(folderResponse);
    expect(folder.icon).toBe("palette");
    expect(folder.color).toBe("#4e8290");

    const updatedFolderResponse = await jsonRequest(
      handler,
      `/api/folders/${folder.id}`,
      { name: "产品设计", icon: "book", color: "#BD8054" },
      { method: "PATCH", headers: { Cookie: cookie } },
    );
    expect(updatedFolderResponse.status).toBe(200);
    const updatedFolder = await responseJson<{
      icon: string;
      color: string;
    }>(updatedFolderResponse);
    expect(updatedFolder.icon).toBe("book");
    expect(updatedFolder.color).toBe("#bd8054");

    const folderListResponse = await request(handler, "/api/folders", {
      headers: { Cookie: cookie },
    });
    expect(
      await responseJson<Array<{ id: string; icon: string; color: string }>>(
        folderListResponse,
      ),
    ).toContainEqual(
      expect.objectContaining({ id: folder.id, icon: "book", color: "#bd8054" }),
    );

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
    const thumbnailWithParam = await request(
      handler,
      "/api/scenes/scene_metadata/thumbnail",
      {
        method: "PUT",
        headers: {
          Cookie: cookie,
          "Content-Type": "image/jpeg; charset=utf-8",
          "X-Thumbnail-Version": "101",
        },
        body: new Uint8Array([255, 216, 255, 217]),
      },
    );
    expect(thumbnailWithParam.status).toBe(200);
    const thumbnailResult = await responseJson<{
      thumbnail_file_id: string;
    }>(thumbnailWithParam);
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

    const list = await request(handler, "/api/scenes?limit=100", {
      headers: { Cookie: cookie },
    });
    const scenes = (
      await responseJson<{
        items: Array<{
          tags: string[];
          favorite: boolean;
          folder_id: string;
          last_opened_at: number;
          thumbnail_file_id: string;
        }>;
      }>(list)
    ).items;
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

    // Test DELETE thumbnail with version check
    const staleDelete = await request(
      handler,
      "/api/scenes/scene_metadata/thumbnail",
      {
        method: "DELETE",
        headers: { Cookie: cookie, "X-Thumbnail-Version": "90" },
      },
    );
    expect(staleDelete.status).toBe(200);
    expect(await responseJson<{ stale?: boolean }>(staleDelete)).toMatchObject({
      stale: true,
    });

    const deletedThumbnail = await request(
      handler,
      "/api/scenes/scene_metadata/thumbnail",
      {
        method: "DELETE",
        headers: { Cookie: cookie, "X-Thumbnail-Version": "105" },
      },
    );
    expect(deletedThumbnail.status).toBe(200);
    expect(
      await responseJson<{ thumbnail_file_id: string | null }>(
        deletedThumbnail,
      ),
    ).toMatchObject({ thumbnail_file_id: null });

    const sceneAfterThumbnailDelete = await request(
      handler,
      "/api/scenes/scene_metadata",
      {
        headers: { Cookie: cookie },
      },
    );
    expect(
      (
        await responseJson<{ thumbnail_file_id: string | null }>(
          sceneAfterThumbnailDelete,
        )
      ).thumbnail_file_id,
    ).toBe(null);

    // Test element_count when elements are deleted
    const updateWithDeletedElements = await jsonRequest(
      handler,
      "/api/scenes/scene_metadata",
      {
        elements: [
          { id: "el1", type: "rectangle", isDeleted: true },
          { id: "el2", type: "text", isDeleted: true },
        ],
        baseRevision: 2,
      },
      { method: "PUT", headers: { Cookie: cookie } },
    );
    expect(updateWithDeletedElements.status).toBe(200);

    const listAfterDeleteAll = await request(
      handler,
      "/api/scenes?limit=100",
      {
        headers: { Cookie: cookie },
      },
    );
    const scenesAfterDeleteAll = (
      await responseJson<{
        items: Array<{
          id: string;
          element_count: number;
          thumbnail_file_id: string | null;
        }>;
      }>(listAfterDeleteAll)
    ).items;
    const targetScene = scenesAfterDeleteAll.find(
      (s) => s.id === "scene_metadata",
    );
    expect(targetScene?.element_count).toBe(0);
    expect(targetScene?.thumbnail_file_id).toBe(null);

    const beforeFolderDelete = await request(
      handler,
      "/api/scenes/scene_metadata",
      { headers: { Cookie: cookie } },
    );
    const beforeFolderDeleteScene = await responseJson<{
      revision: number;
      folder_id: string | null;
    }>(beforeFolderDelete);
    expect(beforeFolderDeleteScene.folder_id).toBe(folder.id);
    const publishedSceneEvents: Array<{
      sceneId: string;
      revision: number;
      changeKind: string;
    }> = [];
    runtime.realtime = {
      publishSceneChanged: (event) => publishedSceneEvents.push(event),
      publishWorkspaceChanged: () => {},
    };
    const deletedFolder = await request(handler, `/api/folders/${folder.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(deletedFolder.status).toBe(200);
    const scene = await request(handler, "/api/scenes/scene_metadata", {
      headers: { Cookie: cookie },
    });
    const afterFolderDeleteScene = await responseJson<{
      folder_id: string | null;
      revision: number;
    }>(scene);
    expect(afterFolderDeleteScene.folder_id).toBe(null);
    expect(afterFolderDeleteScene.revision).toBe(
      beforeFolderDeleteScene.revision + 1,
    );
    expect(scene.headers.get("etag")).not.toBe(
      beforeFolderDelete.headers.get("etag"),
    );
    expect(publishedSceneEvents).toContainEqual(
      expect.objectContaining({
        sceneId: "scene_metadata",
        revision: afterFolderDeleteScene.revision,
        changeKind: "metadata",
      }),
    );
  });

  it("stores scene content size as UTF-8 bytes", async () => {
    const { handler, runtime } = createTestRuntime();
    const cookie = await authenticate(handler);
    const elements = [{ id: "element_utf8", type: "text", text: "白板内容" }];
    const created = await jsonRequest(
      handler,
      "/api/scenes",
      { id: "scene_utf8_bytes", elements },
      { headers: { Cookie: cookie } },
    );
    expect(created.status).toBe(201);

    const stored = runtime.db
      .query("SELECT elements, content_bytes FROM scenes WHERE id = ?")
      .get("scene_utf8_bytes") as {
      elements: string;
      content_bytes: number;
    };
    const expectedBytes = Buffer.byteLength(stored.elements, "utf8");
    expect(stored.content_bytes).toBe(expectedBytes);
    expect(expectedBytes).toBeGreaterThan(stored.elements.length);
    expect((await responseJson<{ size: number }>(created)).size).toBe(
      expectedBytes,
    );

    const updated = await jsonRequest(
      handler,
      "/api/scenes/scene_utf8_bytes",
      {
        elements: [...elements, { id: "element_more", type: "text", text: "修改" }],
        baseRevision: 1,
      },
      { method: "PUT", headers: { Cookie: cookie } },
    );
    expect(updated.status).toBe(200);
    const updatedStored = runtime.db
      .query("SELECT elements, content_bytes FROM scenes WHERE id = ?")
      .get("scene_utf8_bytes") as {
      elements: string;
      content_bytes: number;
    };
    expect(updatedStored.content_bytes).toBe(
      Buffer.byteLength(updatedStored.elements, "utf8"),
    );
  });

  it("advances thumbnail versions even when the image bytes are unchanged", async () => {
    const { handler, runtime } = createTestRuntime();
    const cookie = await authenticate(handler);
    const created = await jsonRequest(
      handler,
      "/api/scenes",
      { id: "scene_thumb_order", name: "缩略图顺序", elements: [], appState: {} },
      { headers: { Cookie: cookie } },
    );
    expect(created.status).toBe(201);

    const upload = (version: number, bytes: number[]) =>
      request(handler, "/api/scenes/scene_thumb_order/thumbnail", {
        method: "PUT",
        headers: {
          Cookie: cookie,
          "Content-Type": "image/jpeg",
          "X-Thumbnail-Version": String(version),
        },
        body: new Uint8Array(bytes),
      });
    const farFutureVersion = await request(
      handler,
      "/api/scenes/scene_thumb_order/thumbnail",
      {
        method: "PUT",
        headers: {
          Cookie: cookie,
          "Content-Type": "image/jpeg",
          "X-Thumbnail-Version": "9999999999999",
        },
        body: new Uint8Array([255, 216, 255, 217]),
      },
    );
    expect(farFutureVersion.status).toBe(400);

    const originalBytes = [255, 216, 255, 217];
    expect((await upload(100, originalBytes)).status).toBe(200);
    expect((await upload(200, originalBytes)).status).toBe(200);

    const farFutureDelete = await request(
      handler,
      "/api/scenes/scene_thumb_order/thumbnail",
      {
        method: "DELETE",
        headers: { Cookie: cookie, "X-Thumbnail-Version": "9999999999999" },
      },
    );
    expect(farFutureDelete.status).toBe(400);

    const olderUpload = await upload(150, [255, 216, 1, 217]);
    expect(olderUpload.status).toBe(200);
    expect(await responseJson<{ stale?: boolean }>(olderUpload)).toMatchObject({
      stale: true,
    });

    const thumbnailId = (
      runtime.db
        .query("SELECT thumbnail_file_id FROM scenes WHERE id = ?")
        .get("scene_thumb_order") as { thumbnail_file_id: string }
    ).thumbnail_file_id;
    const file = await request(handler, `/api/files/${thumbnailId}`, {
      headers: { Cookie: cookie },
    });
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(
      new Uint8Array(originalBytes),
    );
  });

  it("returns complete folder summaries and excludes trashed scenes", async () => {
    const { handler } = createTestRuntime();
    const cookie = await authenticate(handler);
    const folderResponse = await jsonRequest(
      handler,
      "/api/folders",
      { name: "计数文件夹" },
      { headers: { Cookie: cookie } },
    );
    const folder = await responseJson<{
      id: string;
      created_at: number;
    }>(folderResponse);

    const sceneResponse = await jsonRequest(
      handler,
      "/api/scenes",
      {
        id: "scene_folder_counts",
        name: "计数画板",
        folder_id: folder.id,
        elements: [],
        appState: {},
      },
      { headers: { Cookie: cookie } },
    );
    expect(sceneResponse.status).toBe(201);

    const renamedResponse = await request(
      handler,
      `/api/folders/${folder.id}`,
      {
        method: "PATCH",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "已重命名计数文件夹" }),
      },
    );
    expect(renamedResponse.status).toBe(200);
    expect(await responseJson(renamedResponse)).toMatchObject({
      id: folder.id,
      name: "已重命名计数文件夹",
      created_at: folder.created_at,
      scene_count: 1,
    });

    const deleted = await request(handler, "/api/scenes/scene_folder_counts", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(deleted.status).toBe(200);
    const afterDelete = await request(handler, "/api/folders", {
      headers: { Cookie: cookie },
    });
    const foldersAfterDelete = await responseJson<
      Array<{ id: string; scene_count: number }>
    >(afterDelete);
    expect(foldersAfterDelete).toHaveLength(1);
    expect(foldersAfterDelete[0]).toMatchObject({
      id: folder.id,
      scene_count: 0,
    });

    const restored = await request(
      handler,
      "/api/scenes/scene_folder_counts/restore",
      { method: "POST", headers: { Cookie: cookie } },
    );
    expect(restored.status).toBe(200);
    const afterRestore = await request(handler, "/api/folders", {
      headers: { Cookie: cookie },
    });
    const foldersAfterRestore = await responseJson<
      Array<{ id: string; scene_count: number }>
    >(afterRestore);
    expect(foldersAfterRestore).toHaveLength(1);
    expect(foldersAfterRestore[0]).toMatchObject({
      id: folder.id,
      scene_count: 1,
    });
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

  it("rejects the removed Base64 batch upload endpoint", async () => {
    const { handler } = createTestRuntime();
    const cookie = await authenticate(handler);
    const response = await jsonRequest(
      handler,
      "/api/files",
      {
        id: "invalid_base64",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,A",
      },
      { headers: { Cookie: cookie } },
    );
    expect(response.status).toBe(404);
  });

  it("rejects SVG uploads and serves stored SVGs as safe downloads", async () => {
    const { handler, runtime, directory } = createTestRuntime();
    const cookie = await authenticate(handler);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script /></svg>';

    const directUpload = await request(handler, "/api/files/svg_direct", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "image/svg+xml" },
      body: svg,
    });
    expect(directUpload.status).toBe(415);
    expect(
      runtime.db.query("SELECT id FROM files WHERE id = ?").get("svg_direct"),
    ).toBeNull();

    const storedPath = path.join(directory, "files", "stored_svg");
    await fs.writeFile(storedPath, svg);
    runtime.db.run(
      `INSERT INTO files
       (id, storage_path, mime_type, byte_size, sha256, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "stored_svg",
        "stored_svg",
        "image/svg+xml",
        Buffer.byteLength(svg),
        "stored-svg-sha256",
        1,
        1,
      ],
    );

    const download = await request(handler, "/api/files/stored_svg", {
      headers: { Cookie: cookie, Accept: "image/svg+xml" },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(download.headers.get("content-disposition")).toContain(
      "attachment",
    );
    expect(download.headers.get("cache-control")).toBe("private, no-store");
    expect(await download.text()).toBe(svg);
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

  it("recovers a stale Windows replacement backup before artifact cleanup", async () => {
    const { runtime } = createTestRuntime();
    const id = "file_interrupted_replace";
    const backupPath = path.join(
      runtime.filesDir,
      `${id}.0123456789abcdef.bak`,
    );
    const filePath = path.join(runtime.filesDir, id);
    const original = new Uint8Array([4, 5, 6]);
    await fs.writeFile(backupPath, original);
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(backupPath, staleTime, staleTime);

    await cleanupStaleFileArtifacts(runtime);

    expect(await fs.readFile(filePath)).toEqual(Buffer.from(original));
    expect(await fs.stat(backupPath).catch(() => null)).toBeNull();
  });

  it("restores the attachment version committed in SQLite after an interrupted replacement", async () => {
    const { handler, runtime } = createTestRuntime();
    const cookie = await authenticate(handler);
    const id = "file_interrupted_committed";
    const original = new Uint8Array([4, 5, 6]);
    const upload = await request(handler, `/api/files/${id}`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "image/png" },
      body: original,
    });
    expect(upload.status).toBe(201);

    const filePath = path.join(runtime.filesDir, id);
    const backupPath = path.join(
      runtime.filesDir,
      `${id}.0123456789abcdef.bak`,
    );
    await fs.writeFile(filePath, new Uint8Array([9, 8, 7]));
    await fs.writeFile(backupPath, original);
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(backupPath, staleTime, staleTime);

    await cleanupStaleFileArtifacts(runtime);

    expect(await fs.readFile(filePath)).toEqual(Buffer.from(original));
    expect(await fs.stat(backupPath).catch(() => null)).toBeNull();
  });

  it("removes an old replacement backup after the new SQLite row committed", async () => {
    const { handler, runtime } = createTestRuntime();
    const cookie = await authenticate(handler);
    const id = "file_replacement_committed";
    const original = new Uint8Array([1, 2, 3]);
    const current = new Uint8Array([9, 8, 7]);
    const upload = (bytes: Uint8Array<ArrayBuffer>) =>
      request(handler, `/api/files/${id}`, {
        method: "PUT",
        headers: { Cookie: cookie, "Content-Type": "image/png" },
        body: bytes,
      });
    expect((await upload(original)).status).toBe(201);
    expect((await upload(current)).status).toBe(201);

    const filePath = path.join(runtime.filesDir, id);
    const backupPath = path.join(
      runtime.filesDir,
      `${id}.0123456789abcdef.bak`,
    );
    await fs.writeFile(backupPath, original);
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(backupPath, staleTime, staleTime);

    await cleanupStaleFileArtifacts(runtime);

    expect(await fs.readFile(filePath)).toEqual(Buffer.from(current));
    expect(await fs.stat(backupPath).catch(() => null)).toBeNull();
  });

  it("keeps unverified replacement backups when the current attachment disagrees with SQLite", async () => {
    const { handler, runtime } = createTestRuntime();
    const cookie = await authenticate(handler);
    const id = "file_keep_unverified";
    const upload = await request(handler, `/api/files/${id}`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "image/png" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(upload.status).toBe(201);

    const filePath = path.join(runtime.filesDir, id);
    const backupPath = path.join(
      runtime.filesDir,
      `${id}.0123456789abcdef.bak`,
    );
    await fs.writeFile(filePath, new Uint8Array([9, 8, 7]));
    await fs.writeFile(backupPath, new Uint8Array([6, 5, 4]));
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(backupPath, staleTime, staleTime);

    await cleanupStaleFileArtifacts(runtime);

    expect(await fs.readFile(filePath)).toEqual(Buffer.from([9, 8, 7]));
    expect(await fs.readFile(backupPath)).toEqual(Buffer.from([6, 5, 4]));
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
    await fs.writeFile(path.join(staticDir, "chunk-a1b2c3d4.js"), "export {};");
    await fs.writeFile(path.join(staticDir, "service-worker.js"), "self;");
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
    const assetEtag = asset.headers.get("etag");
    expect(assetEtag).toMatch(/^"[a-f0-9]{64}"$/);
    const expectedHasher = new Bun.CryptoHasher("sha256");
    expectedHasher.update("export {};");
    expect(assetEtag).toBe(`"${expectedHasher.digest("hex")}"`);
    const revalidatedAsset = await request(handler, "/assets/valid.js", {
      headers: { "If-None-Match": `W/${assetEtag}` },
    });
    expect(revalidatedAsset.status).toBe(304);
    expect(revalidatedAsset.headers.get("etag")).toBe(assetEtag);

    await fs.writeFile(path.join(staticDir, "assets", "valid.js"), "changed;");
    const changedAsset = await request(handler, "/assets/valid.js", {
      headers: { Accept: "*/*" },
    });
    expect(changedAsset.status).toBe(200);
    expect(changedAsset.headers.get("etag")).not.toBe(assetEtag);
    const changedHasher = new Bun.CryptoHasher("sha256");
    changedHasher.update("changed;");
    expect(changedAsset.headers.get("etag")).toBe(
      `"${changedHasher.digest("hex")}"`,
    );

    await fs.mkdir(path.join(staticDir, "locales"), { recursive: true });
    await fs.writeFile(
      path.join(staticDir, "locales", "en.json"),
      '{"language":"English"}',
    );
    const locale = await request(handler, "/locales/en.json");
    expect(locale.status).toBe(200);
    expect(locale.headers.get("content-type")).toContain("application/json");
    expect(locale.headers.get("cache-control")).toBe("no-cache");
    expect(await locale.json()).toEqual({ language: "English" });

    const hashedRootAsset = await request(handler, "/chunk-a1b2c3d4.js");
    expect(hashedRootAsset.headers.get("cache-control")).toContain("immutable");

    const legacyWorker = await request(handler, "/service-worker.js");
    expect(legacyWorker.headers.get("cache-control")).toBe("no-store");
  });

  it("cleans abandoned final backup files while preserving active downloads", async () => {
    const { runtime, directory } = createTestRuntime();
    const staleBackup = path.join(directory, "excalidraw-backup-expired.db");
    const activeBackup = path.join(
      directory,
      "excalidraw-full-backup-active.tar",
    );
    await fs.writeFile(staleBackup, "stale");
    await fs.writeFile(activeBackup, "active");
    runtime.activeBackupArtifacts.add(path.resolve(activeBackup));

    await cleanupStaleFileArtifacts(runtime);

    expect(existsSync(staleBackup)).toBe(false);
    expect(existsSync(activeBackup)).toBe(true);
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
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toMatch(/script-src[^;]*\bblob:/);
    expect(csp).toContain("style-src 'self' https://cdn.jsdelivr.net");
    expect(csp).toContain(
      "style-src-elem 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    );
    expect(csp).toContain("font-src 'self' data: https://cdn.jsdelivr.net");
    expect(csp).not.toMatch(/script-src[^;]*(?:'unsafe-inline'|'unsafe-eval')/);
    expect(csp).toContain("worker-src 'self' blob:");
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

  it("holds the backup lock until the response is consumed or canceled", async () => {
    const { handler, directory } = createTestRuntime();
    const cookie = await authenticate(handler);
    const firstBackup = await request(handler, "/api/backup/full", {
      headers: { Cookie: cookie },
    });
    expect(firstBackup.status).toBe(200);

    const rejectedBackup = await request(handler, "/api/backup/snapshot", {
      headers: { Cookie: cookie },
    });
    expect(rejectedBackup.status).toBe(429);
    expect(await responseJson<{ code: string }>(rejectedBackup)).toMatchObject({
      code: "BACKUP_BUSY",
    });

    await firstBackup.body?.cancel();
    const remainingArtifacts = (await fs.readdir(directory)).filter((name) =>
      /^excalidraw-(?:backup-.*\.db|full-backup-.*\.tar)/.test(name),
    );
    expect(remainingArtifacts).toHaveLength(0);

    const retry = await request(handler, "/api/backup/snapshot", {
      headers: { Cookie: cookie },
    });
    expect(retry.status).toBe(200);
    await retry.body?.cancel();
  });

  it("applies write rate limits to backup downloads before creating artifacts", async () => {
    const { handler, runtime, directory } = createTestRuntime();
    const cookie = await authenticate(handler);
    runtime.writeAttempts.set("unknown", {
      startedAt: Date.now(),
      count: 120,
    });

    const response = await request(handler, "/api/backup/full", {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
    const artifacts = (await fs.readdir(directory)).filter((name) =>
      /^excalidraw-(?:backup-.*\.db|full-backup-.*\.tar)/.test(name),
    );
    expect(artifacts).toHaveLength(0);
  });

  it("rejects an oversized database snapshot and removes its temp file", async () => {
    const { handler, directory } = createTestRuntime({ MAX_BACKUP_BYTES: "1" });
    const cookie = await authenticate(handler);
    const response = await request(handler, "/api/backup/snapshot", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(413);
    expect(await responseJson<{ code: string }>(response)).toMatchObject({
      code: "BACKUP_TOO_LARGE",
    });
    const artifacts = (await fs.readdir(directory)).filter((name) =>
      name.startsWith("excalidraw-backup-"),
    );
    expect(artifacts).toHaveLength(0);
  });

  it("measures the compacted SQLite snapshot instead of rejecting free pages", async () => {
    const { runtime } = createTestRuntime();
    const initialSnapshot = await createDatabaseSnapshot(
      runtime,
      `baseline-${crypto.randomUUID()}`,
    );
    const compactSize = Bun.file(initialSnapshot.tempBackupFile).size;
    await initialSnapshot.cleanup();
    runtime.config.maxBackupBytes = Math.max(compactSize * 2, 64 * 1024);

    const createPadding = runtime.db.transaction(() => {
      runtime.db.run(
        "CREATE TABLE backup_padding (payload TEXT NOT NULL)",
      );
      const insert = runtime.db.query(
        "INSERT INTO backup_padding (payload) VALUES (?)",
      );
      const payload = "x".repeat(8192);
      for (let index = 0; index < 300; index += 1) {
        insert.run(payload);
      }
    });
    createPadding.immediate();
    runtime.db.run("DROP TABLE backup_padding");
    const pageCount = Number(
      (runtime.db.query("PRAGMA page_count").get() as { page_count: number })
        .page_count,
    );
    const pageSize = Number(
      (runtime.db.query("PRAGMA page_size").get() as { page_size: number })
        .page_size,
    );
    expect(pageCount * pageSize).toBeGreaterThan(
      runtime.config.maxBackupBytes,
    );

    const snapshot = await createDatabaseSnapshot(
      runtime,
      `freelist-${crypto.randomUUID()}`,
    );
    expect(Bun.file(snapshot.tempBackupFile).size).toBeLessThanOrEqual(
      runtime.config.maxBackupBytes,
    );
    await snapshot.cleanup();
  });

  it("exports a complete backup containing the database, manifest and attachments", async () => {
    const { handler, runtime, directory } = createTestRuntime();
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
    const archiveBlob = await backup.blob();
    const archive = new Bun.Archive(archiveBlob);
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

    const rawPayloadBytes =
      database.size +
      (await files.get("manifest.json")!.arrayBuffer()).byteLength +
      (await files.get("files/file_full_backup")!.arrayBuffer()).byteLength;
    expect(archiveBlob.size).toBeGreaterThan(rawPayloadBytes);
    runtime.config.maxBackupBytes = rawPayloadBytes;
    runtime.writeAttempts.clear();
    const tooLargeArchive = await request(handler, "/api/backup/full", {
      headers: { Cookie: cookie },
    });
    expect(tooLargeArchive.status).toBe(413);
    const leftovers = (await fs.readdir(directory)).filter((name) =>
      /^excalidraw-(?:backup-.*\.db|full-backup-.*\.tar)/.test(name),
    );
    expect(leftovers).toHaveLength(0);
  });

  it("sanitizes isDeleted elements on creation and update to reduce stored size", async () => {
    const { handler, runtime } = createTestRuntime();
    const cookie = await authenticate(handler);
    const elementsWithDeleted = [
      { id: "el_1", type: "rectangle", x: 10, y: 10, width: 100, height: 100 },
      { id: "el_2", type: "text", x: 20, y: 20, isDeleted: true, text: "deleted element" },
    ];
    const created = await jsonRequest(
      handler,
      "/api/scenes",
      { name: "Sanitized Board", elements: elementsWithDeleted },
      { headers: { Cookie: cookie } },
    );
    expect(created.status).toBe(201);
    const createdData = await responseJson<{ id: string; element_count: number }>(created);
    expect(createdData.element_count).toBe(1);

    const row = runtime.db
      .query("SELECT elements, element_count FROM scenes WHERE id = ?")
      .get(createdData.id) as { elements: string; element_count: number };
    const savedElements = JSON.parse(row.elements);
    expect(savedElements).toHaveLength(1);
    expect(savedElements[0].id).toBe("el_1");
    expect(row.element_count).toBe(1);

    const update = await jsonRequest(
      handler,
      `/api/scenes/${createdData.id}`,
      {
        elements: [
          ...savedElements,
          { id: "el_3", type: "rectangle", isDeleted: true },
          { id: "el_4", type: "ellipse", x: 50, y: 50, width: 50, height: 50 },
        ],
        baseRevision: 1,
      },
      { method: "PUT", headers: { Cookie: cookie } },
    );
    expect(update.status).toBe(200);
    const updatedRow = runtime.db
      .query("SELECT elements, element_count FROM scenes WHERE id = ?")
      .get(createdData.id) as { elements: string; element_count: number };
    const updatedElements = JSON.parse(updatedRow.elements);
    expect(updatedElements).toHaveLength(2);
    expect(updatedElements.map((el: any) => el.id)).toEqual(["el_1", "el_4"]);
    expect(updatedRow.element_count).toBe(2);
  });

  it("automatically cleans up expired trash scenes and publishes workspace update", async () => {
    const { runtime, handler } = createTestRuntime({ TRASH_RETENTION_DAYS: "15" });
    const cookie = await authenticate(handler);
    const created = await jsonRequest(
      handler,
      "/api/scenes",
      { name: "Expired Trash Board" },
      { headers: { Cookie: cookie } },
    );
    const { id } = await responseJson<{ id: string }>(created);

    await request(handler, `/api/scenes/${id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    const expiredTime = Date.now() - 20 * 24 * 60 * 60 * 1000;
    runtime.db.run("UPDATE scenes SET deleted_at = ? WHERE id = ?", [expiredTime, id]);

    let workspaceChanged = false;
    runtime.realtime = {
      publishSceneChanged: () => {},
      publishWorkspaceChanged: () => {
        workspaceChanged = true;
      },
    };

    const cleanedCount = cleanupExpiredTrashScenes(runtime);
    expect(cleanedCount).toBe(1);
    expect(workspaceChanged).toBe(true);
    expect(runtime.db.query("SELECT id FROM scenes WHERE id = ?").get(id)).toBeNull();
  });

});
