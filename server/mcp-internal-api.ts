import { HttpError } from "./errors";
import { measureMcpApi } from "./mcp-trace";

export type ApiHandler = (req: Request) => Promise<Response>;

export const createRequestBodyLimiter = (maxConcurrent: number) => {
  let active = 0;
  const waiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
    remove: () => void;
    settled: boolean;
  }> = [];

  const releaseSlot = () => {
    active = Math.max(0, active - 1);
    while (waiters.length) {
      const waiter = waiters.shift()!;
      if (waiter.settled) {
        continue;
      }
      waiter.settled = true;
      waiter.remove();
      active += 1;
      waiter.resolve();
      return;
    }
  };

  return {
    acquire: (signal?: AbortSignal) =>
      new Promise<() => void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("The request was aborted", "AbortError"));
          return;
        }
        if (active < maxConcurrent) {
          active += 1;
          let released = false;
          resolve(() => {
            if (!released) {
              released = true;
              releaseSlot();
            }
          });
          return;
        }

        const waiter = {
          resolve: () => {
            let released = false;
            resolve(() => {
              if (!released) {
                released = true;
                releaseSlot();
              }
            });
          },
          reject: (error: unknown) => {
            if (waiter.settled) {
              return;
            }
            waiter.settled = true;
            waiter.remove();
            reject(error);
          },
          remove: () => {
            signal?.removeEventListener("abort", abort);
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
          },
          settled: false,
        };
        const abort = () =>
          waiter.reject(
            new DOMException("The request was aborted", "AbortError"),
          );
        signal?.addEventListener("abort", abort, { once: true });
        waiters.push(waiter);
      }),
  };
};

export const createInternalApi =
  (apiHandler: ApiHandler, sessionToken: string) =>
  async <T>(
    path: string,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    body?: unknown,
  ) =>
    measureMcpApi(method, async () => {
      const req = new Request(`http://excalidraw-mcp.internal${path}`, {
        method,
        headers: {
          Cookie: `excalidraw_session=${sessionToken}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const res = await apiHandler(req);
      const responseBody = await res.text();
      let parsed: unknown;
      try {
        parsed = responseBody ? JSON.parse(responseBody) : null;
      } catch {
        parsed = responseBody;
      }
      if (!res.ok) {
        const error = parsed as { code?: string; error?: string } | null;
        throw new HttpError(
          res.status,
          error?.code || "MCP_API_ERROR",
          error?.error || `内部画板 API 请求失败（HTTP ${res.status}）`,
        );
      }
      return parsed as T;
    });
