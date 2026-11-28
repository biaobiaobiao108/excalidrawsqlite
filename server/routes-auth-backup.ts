import { AUTH_RATE_WINDOW_MS } from "./config";
import { HttpError } from "./errors";
import {
  clearSessionCookies,
  consumeRateLimit,
  getClientKey,
  getSessionToken,
  hashSessionToken,
  isAuthorized,
  issueSessionCookie,
  verifyPassword,
} from "./auth";
import {
  acquireBackupLock,
  createDatabaseSnapshot,
  createFullBackup,
} from "./backup";
import { jsonResponse, readJson, response } from "./http";
import { streamBackupArchive } from "./stream-response";
import { requireJsonObject } from "./validation";
import { writeRateLimitResponse, type RouteContext } from "./routes-shared";

export const handleBackupAndAuthRoute = async ({
  runtime,
  req,
  pathname,
  requestAddressResolver,
}: RouteContext): Promise<Response | null> => {
  if (pathname === "/api/backup/full" && req.method === "GET") {
    if (!isAuthorized(runtime, req)) {
      return jsonResponse(
        runtime,
        req,
        { error: "请先完成访问授权", code: "AUTH_REQUIRED" },
        401,
      );
    }
    const rateLimited = writeRateLimitResponse(
      runtime,
      req,
      requestAddressResolver,
    );
    if (rateLimited) {
      return rateLimited;
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const releaseBackupLock = acquireBackupLock(runtime);
    let archive:
      | { archivePath: string; cleanup: () => Promise<void>; size: number }
      | undefined;
    try {
      archive = await createFullBackup(runtime, timestamp);
      return response(
        runtime,
        req,
        streamBackupArchive(archive, releaseBackupLock),
        {
          headers: {
            "Content-Type": "application/x-tar",
            "Content-Disposition": `attachment; filename="excalidraw-full-backup-${timestamp}.tar"`,
            "Content-Length": String(archive.size),
            "Cache-Control": "no-store",
          },
        },
      );
    } catch (error: any) {
      await archive?.cleanup().catch(() => {});
      releaseBackupLock();
      if (error instanceof HttpError) {
        throw error;
      }
      console.error("[Backup] 创建完整备份失败", error);
      throw new HttpError(500, "BACKUP_FAILED", "创建完整备份失败，请稍后重试");
    }
  }

  if (pathname === "/api/backup/snapshot" && req.method === "GET") {
    if (!isAuthorized(runtime, req)) {
      return jsonResponse(
        runtime,
        req,
        { error: "请先完成访问授权", code: "AUTH_REQUIRED" },
        401,
      );
    }
    const rateLimited = writeRateLimitResponse(
      runtime,
      req,
      requestAddressResolver,
    );
    if (rateLimited) {
      return rateLimited;
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const releaseBackupLock = acquireBackupLock(runtime);
    let snapshot:
      | {
          archivePath: string;
          cleanup: () => Promise<void>;
          size: number;
        }
      | undefined;
    try {
      const databaseSnapshot = await createDatabaseSnapshot(runtime, timestamp);
      const backupFile = Bun.file(databaseSnapshot.tempBackupFile);
      snapshot = {
        archivePath: databaseSnapshot.tempBackupFile,
        cleanup: databaseSnapshot.cleanup,
        size: backupFile.size,
      };
      if (backupFile.size > runtime.config.maxBackupBytes) {
        throw new HttpError(413, "BACKUP_TOO_LARGE", "备份内容超过大小限制");
      }
      return response(
        runtime,
        req,
        streamBackupArchive(snapshot, releaseBackupLock),
        {
          headers: {
            "Content-Type": "application/x-sqlite3",
            "Content-Disposition": `attachment; filename="excalidraw-backup-${timestamp}.db"`,
            "Content-Length": String(snapshot.size),
            "Cache-Control": "no-store",
          },
        },
      );
    } catch (error: any) {
      await snapshot?.cleanup().catch(() => {});
      releaseBackupLock();
      if (error instanceof HttpError) {
        throw error;
      }
      console.error("[Backup] 创建数据库热备失败", error);
      throw new HttpError(
        500,
        "BACKUP_FAILED",
        "创建数据库热备失败，请稍后重试",
      );
    }
  }

  if (pathname === "/api/auth/status" && req.method === "GET") {
    return jsonResponse(runtime, req, {
      authRequired:
        Boolean(runtime.config.authPassword) && !runtime.config.allowAnonymous,
      authenticated: isAuthorized(runtime, req),
    });
  }

  if (pathname === "/api/auth/verify" && req.method === "POST") {
    const rate = consumeRateLimit(
      runtime.authAttempts,
      getClientKey(runtime, req, requestAddressResolver),
      runtime.config.authAttemptsPerWindow,
      AUTH_RATE_WINDOW_MS,
    );
    if (!rate.allowed) {
      return jsonResponse(
        runtime,
        req,
        { error: "认证尝试次数过多，请稍后再试", code: "RATE_LIMITED" },
        429,
        { "Retry-After": String(rate.retryAfter) },
      );
    }
    const body = requireJsonObject(
      await readJson(req, 64 * 1024, runtime.bodyMemoryBudget),
    );
    const password = body.password;
    if (
      runtime.config.allowAnonymous ||
      !runtime.config.authPassword ||
      verifyPassword(password, runtime.config.authPassword)
    ) {
      return jsonResponse(runtime, req, { success: true }, 200, {
        "Set-Cookie": issueSessionCookie(runtime, req),
      });
    }
    return jsonResponse(
      runtime,
      req,
      { error: "密码错误，请重新输入", code: "INVALID_PASSWORD" },
      401,
    );
  }

  if (pathname === "/api/auth/logout" && req.method === "POST") {
    const token = getSessionToken(runtime, req);
    if (token) {
      try {
        runtime.db.run("DELETE FROM sessions WHERE token = ?", [
          hashSessionToken(runtime, token),
        ]);
      } catch (error) {
        console.info("[Sessions] logout failed", error);
        return jsonResponse(
          runtime,
          req,
          { error: "退出登录失败，请重试", code: "LOGOUT_FAILED" },
          500,
        );
      }
      runtime.realtime?.revokeSession?.(token);
    }
    const headers = new Headers({
      "Clear-Site-Data": '"cookies"',
    });
    for (const cookie of clearSessionCookies(runtime, req)) {
      headers.append("Set-Cookie", cookie);
    }
    return response(runtime, req, null, {
      status: 204,
      headers,
    });
  }

  return null;
};
