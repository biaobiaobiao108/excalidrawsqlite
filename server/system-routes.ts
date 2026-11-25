import fs from "node:fs";
import path from "node:path";

import { handleDevReloadRequest } from "./dev-reload";
import { HttpError } from "./errors";
import { response, jsonResponse } from "./http";
import {
  buildStaticPath,
  getStaticCacheControl,
  getStaticETag,
  getStaticDir,
  staticIfNoneMatchMatches,
} from "./static";

import type { ServerRuntime } from "./types";

type HealthCheck = { get: () => unknown };
type StaticEncoding = "br" | "gzip";

const compressibleStaticExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".mjs",
  ".svg",
  ".txt",
  ".webmanifest",
  ".xml",
]);

const parseEncodingPreferences = (header: string | null) => {
  const preferences = new Map<string, number>();
  for (const part of (header || "").split(",")) {
    const [rawName, ...parameters] = part.trim().toLowerCase().split(";");
    if (!rawName) {
      continue;
    }
    let quality = 1;
    for (const parameter of parameters) {
      const [rawKey, rawValue] = parameter.trim().split("=", 2);
      if (rawKey !== "q") {
        continue;
      }
      const parsed = Number(rawValue);
      quality = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0;
    }
    preferences.set(rawName, quality);
  }
  return preferences;
};

const chooseStaticEncoding = async (
  staticPath: string,
  acceptEncoding: string | null,
) => {
  if (
    !compressibleStaticExtensions.has(path.extname(staticPath).toLowerCase())
  ) {
    return null;
  }

  const preferences = parseEncodingPreferences(acceptEncoding);
  const candidates = [
    { encoding: "br" as const, extension: ".br" },
    { encoding: "gzip" as const, extension: ".gz" },
  ]
    .map((candidate) => ({
      ...candidate,
      quality: preferences.get(candidate.encoding) ?? preferences.get("*") ?? 0,
    }))
    .filter((candidate) => candidate.quality > 0)
    .sort((left, right) => right.quality - left.quality);

  for (const candidate of candidates) {
    const compressedPath = `${staticPath}${candidate.extension}`;
    const compressedFile = Bun.file(compressedPath);
    if (await compressedFile.exists()) {
      return {
        file: compressedFile,
        encoding: candidate.encoding,
        cacheKey: compressedPath,
      };
    }
  }
  return null;
};

const staticFileResponse = async (
  runtime: ServerRuntime,
  req: Request,
  file: ReturnType<typeof Bun.file>,
  pathname: string,
  contentType?: string,
  cacheKey?: string,
) => {
  const compressed = cacheKey
    ? await chooseStaticEncoding(
        path.resolve(cacheKey),
        req.headers.get("accept-encoding"),
      )
    : null;
  const responseFile = compressed?.file || file;
  const resolvedContentType = contentType || file.type;
  const etag = await getStaticETag(
    responseFile,
    compressed?.cacheKey || cacheKey,
  );
  const cacheControl = getStaticCacheControl(pathname);
  const headers = {
    "Cache-Control": cacheControl,
    ETag: etag,
    Vary: "Accept-Encoding, Origin",
    ...(resolvedContentType ? { "Content-Type": resolvedContentType } : {}),
    ...(compressed ? { "Content-Encoding": compressed.encoding } : {}),
  };
  if (staticIfNoneMatchMatches(req.headers.get("if-none-match"), etag)) {
    return response(runtime, req, null, { status: 304, headers });
  }
  return response(runtime, req, req.method === "HEAD" ? null : responseFile, {
    headers,
  });
};

/** Handles process health and development reload endpoints. */
export const handleEarlySystemRequest = (
  runtime: ServerRuntime,
  req: Request,
  pathname: string,
  healthCheck: HealthCheck,
): Response | undefined => {
  if (pathname === "/__dev_reload") {
    if (runtime.config.nodeEnv !== "development") {
      throw new HttpError(404, "NOT_FOUND", "接口不存在");
    }
    if (req.method !== "GET") {
      return response(runtime, req, null, {
        status: 405,
        headers: { Allow: "GET" },
      });
    }
    return handleDevReloadRequest(req);
  }

  if (pathname === "/api/health" && req.method === "GET") {
    try {
      healthCheck.get();
      fs.accessSync(path.dirname(runtime.dbPath), fs.constants.W_OK);
      fs.accessSync(runtime.filesDir, fs.constants.W_OK);
      // Keep health checks O(1). Full attachment consistency scans run in
      // the maintenance loop and are intentionally not exposed publicly.
      return jsonResponse(runtime, req, { status: "ok" });
    } catch {
      throw new HttpError(503, "STORAGE_UNAVAILABLE", "持久化存储不可用");
    }
  }

  return undefined;
};

/** Handles static frontend files and the SPA fallback. */
export const handleStaticRequest = async (
  runtime: ServerRuntime,
  req: Request,
  pathname: string,
): Promise<Response> => {
  const staticDir = getStaticDir(runtime);
  const staticPath = buildStaticPath(staticDir, pathname);
  if (!staticPath) {
    throw new HttpError(400, "INVALID_PATH", "无效的资源路径");
  }
  const staticFile = Bun.file(staticPath);
  if (await staticFile.exists()) {
    return staticFileResponse(
      runtime,
      req,
      staticFile,
      pathname,
      undefined,
      staticPath,
    );
  }
  const acceptsHtml = (req.headers.get("accept") || "")
    .toLowerCase()
    .includes("text/html");
  if (acceptsHtml) {
    const indexPath = path.join(staticDir, "index.html");
    const indexFile = Bun.file(indexPath);
    if (await indexFile.exists()) {
      return staticFileResponse(
        runtime,
        req,
        indexFile,
        "/index.html",
        "text/html; charset=utf-8",
        indexPath,
      );
    }
  }
  if (pathname !== "/") {
    throw new HttpError(404, "STATIC_NOT_FOUND", "资源不存在");
  }
  return response(
    runtime,
    req,
    "Excalidraw Bun Server is running. Please build the frontend first (bun run build).",
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
};
