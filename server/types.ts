import type { D1DatabasePort } from "./db";

export class BodyMemoryBudget {
  private availableBytes: number;
  private currentBytes = 0;
  private peakBytes = 0;
  private readonly waiters: Array<{
    bytes: number;
    resolve: () => void;
    reject: (error: unknown) => void;
    remove: () => void;
    settled: boolean;
  }> = [];

  constructor(private readonly maxBytes: number) {
    this.availableBytes = maxBytes;
  }

  async acquire(requestedBytes: number, signal?: AbortSignal) {
    const bytes = Math.min(Math.max(1, requestedBytes), this.maxBytes);
    if (signal?.aborted) {
      throw new DOMException("The request was aborted", "AbortError");
    }
    if (this.availableBytes >= bytes) {
      this.availableBytes -= bytes;
      this.currentBytes += bytes;
      this.peakBytes = Math.max(this.peakBytes, this.currentBytes);
      return bytes;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        bytes,
        resolve: () => {
          if (waiter.settled) {
            return;
          }
          waiter.settled = true;
          waiter.remove();
          resolve();
        },
        reject: (error: unknown) => {
          if (waiter.settled) {
            return;
          }
          waiter.settled = true;
          waiter.remove();
          reject(error);
          this.drainWaiters();
        },
        remove: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
        },
        settled: false,
      };
      const removeWaiter = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
      };
      const abort = () =>
        waiter.reject(new DOMException("The request was aborted", "AbortError"));
      waiter.remove = () => {
        signal?.removeEventListener("abort", abort);
        removeWaiter();
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.waiters.push(waiter);
    });
    return bytes;
  }

  release(bytes: number) {
    this.availableBytes = Math.min(this.maxBytes, this.availableBytes + bytes);
    this.currentBytes = Math.max(0, this.currentBytes - bytes);
    this.drainWaiters();
  }

  private drainWaiters() {
    while (this.waiters.length) {
      const waiter = this.waiters[0];
      if (this.availableBytes < waiter.bytes) {
        break;
      }
      this.availableBytes -= waiter.bytes;
      this.currentBytes += waiter.bytes;
      this.peakBytes = Math.max(this.peakBytes, this.currentBytes);
      this.waiters.shift();
      waiter.resolve();
    }
  }

  getStats() {
    return {
      maxBytes: this.maxBytes,
      availableBytes: this.availableBytes,
      currentBytes: this.currentBytes,
      peakBytes: this.peakBytes,
      queuedRequests: this.waiters.length,
    };
  }
}

export type ServerConfig = {
  authPassword: string;
  mcpToken: string;
  mcpTrace: boolean;
  allowAnonymous: boolean;
  nodeEnv: string;
  trustProxy: boolean;
  corsOrigins: Set<string>;
  authAttemptsPerWindow: number;
  maxFileBytes: number;
  maxSceneBodyBytes: number;
  /** SQLite test-only backup utility; never exposed by Worker routes. */
  maxBackupBytes: number;
  maxInFlightBodyBytes: number;
  sessionTtlMs: number;
  trashRetentionDays: number;
};

export type RequestAddressResolver = (req: Request) => string | undefined;
export type SceneRealtimeEvent = {
  type: "scene_changed";
  sceneId: string;
  revision: number;
  updatedAt: number;
  changeKind: "created" | "content" | "metadata" | "thumbnail" | "deleted" | "restored";
};
export type WorkspaceRealtimeEvent = { type: "workspace_changed"; updatedAt: number };
export type RealtimePublisher = {
  publishSceneChanged: (event: SceneRealtimeEvent) => void;
  publishWorkspaceChanged: (updatedAt?: number) => void;
};

export type R2ObjectBody = {
  body: ReadableStream<Uint8Array>;
  size: number;
  httpEtag?: string;
  etag?: string;
  httpMetadata?: { contentType?: string; cacheControl?: string };
};
export type R2BucketBinding = {
  put(key: string, value: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | string | null, options?: { httpMetadata?: { contentType?: string; cacheControl?: string }; onlyIf?: { etagDoesNotMatch?: string } }): Promise<unknown>;
  get(key: string, options?: { onlyIf?: { etagMatches?: string } }): Promise<R2ObjectBody | null>;
  head(key: string): Promise<{ size: number; etag?: string; httpEtag?: string } | null>;
  delete(key: string | string[]): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ objects: Array<{ key: string; uploaded?: Date }>; truncated: boolean; cursor?: string }>;
};
export type RealtimeNamespaceBinding = { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
export type StaticAssetsBinding = { fetch(request: Request): Promise<Response> };
export type WorkerExecutionContext = { waitUntil(promise: Promise<unknown>): void };

export type ServerRuntime = {
  db: D1DatabasePort;
  files?: R2BucketBinding;
  dbPath?: string;
  filesDir?: string;
  activeBackupArtifacts: Set<string>;
  activeFileArtifacts: Set<string>;
  staticAssets?: StaticAssetsBinding;
  staticDir?: string;
  realtime?: RealtimePublisher;
  realtimeNamespace?: RealtimeNamespaceBinding;
  waitUntil?: (promise: Promise<unknown>) => void;
  config: ServerConfig;
  clientAddress?: string;
  bodyMemoryBudget: BodyMemoryBudget;
};
