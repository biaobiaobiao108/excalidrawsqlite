import { HttpError } from "./errors";
import { isAuthorized } from "./auth";
import {
  errorResponse,
  isAllowedOrigin,
  jsonResponse,
  releaseJsonBodyMemoryBudget,
  response,
} from "./http";
import { handleEarlySystemRequest, handleStaticRequest } from "./system-routes";
import { handleBackupAndAuthRoute } from "./routes-auth-backup";
import { handleFileRoute } from "./routes-files";
import { handleFolderRoute } from "./routes-folders";
import { handleSceneThumbnailRoute } from "./routes-scene-thumbnails";
import { handleSceneListRoute } from "./routes-scene-list";
import { handleSceneRoute } from "./routes-scenes";
import {
  getPreparedStatements,
  writeRateLimitResponse,
  type RouteContext,
} from "./routes-shared";

import type { RequestAddressResolver, ServerRuntime } from "./types";

export const createRequestHandler = (
  runtime: ServerRuntime,
  requestAddressResolver?: RequestAddressResolver,
) => {
  const stmts = getPreparedStatements(runtime);
  const routeHandlers = [
    handleSceneListRoute,
    handleSceneThumbnailRoute,
    handleSceneRoute,
    handleFolderRoute,
    handleFileRoute,
  ];

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const corsAllowed = isAllowedOrigin(runtime, req);

    if (req.method === "OPTIONS") {
      if (!corsAllowed) {
        return errorResponse(
          runtime,
          req,
          new HttpError(403, "CORS_FORBIDDEN", "不允许的跨域来源"),
        );
      }
      const headers = new Headers({
        "Access-Control-Allow-Methods":
          "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Accept, X-Thumbnail-Version, If-None-Match",
        "Access-Control-Max-Age": "600",
      });
      const origin = req.headers.get("origin");
      if (origin && runtime.config.corsOrigins.has(origin)) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Access-Control-Allow-Credentials", "true");
        headers.set("Vary", "Origin");
      }
      return response(runtime, req, null, { status: 204, headers });
    }

    if (!corsAllowed) {
      return errorResponse(
        runtime,
        req,
        new HttpError(403, "CORS_FORBIDDEN", "不允许的跨域来源"),
      );
    }

    try {
      const systemResponse = handleEarlySystemRequest(
        runtime,
        req,
        pathname,
        stmts.healthCheck,
      );
      if (systemResponse) {
        return systemResponse;
      }

      const ctx: RouteContext = {
        runtime,
        req,
        url,
        pathname,
        stmts,
        requestAddressResolver,
      };

      const backupOrAuthResponse = await handleBackupAndAuthRoute(ctx);
      if (backupOrAuthResponse) {
        return backupOrAuthResponse;
      }

      if (pathname.startsWith("/api/") && !isAuthorized(runtime, req)) {
        return jsonResponse(
          runtime,
          req,
          { error: "请先完成访问授权", code: "AUTH_REQUIRED" },
          401,
        );
      }

      if (
        pathname.startsWith("/api/") &&
        ["POST", "PUT", "PATCH", "DELETE"].includes(req.method)
      ) {
        const rateLimited = writeRateLimitResponse(
          runtime,
          req,
          requestAddressResolver,
        );
        if (rateLimited) {
          return rateLimited;
        }
      }

      for (const routeHandler of routeHandlers) {
        const res = await routeHandler(ctx);
        if (res) {
          return res;
        }
      }

      if (pathname.startsWith("/api/")) {
        throw new HttpError(404, "NOT_FOUND", "接口不存在");
      }

      return await handleStaticRequest(runtime, req, pathname);
    } catch (error) {
      return errorResponse(runtime, req, error);
    } finally {
      releaseJsonBodyMemoryBudget(req);
    }
  };

  return handler;
};
