import type { Database } from "bun:sqlite";

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
        },
        remove: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
        },
        settled: false,
      };
      if (signal) {
        const abort = () =>
          waiter.reject(new DOMException("The request was aborted", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        waiter.remove = () => {
          signal.removeEventListener("abort", abort);
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
        };
      }
      this.waiters.push(waiter);
    });
    return bytes;
  }

  release(bytes: number) {
    this.availableBytes = Math.min(this.maxBytes, this.availableBytes + bytes);
    this.currentBytes = Math.max(0, this.currentBytes - bytes);
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
  allowAnonymous: boolean;
  nodeEnv: string;
  trustProxy: boolean;
  corsOrigins: Set<string>;
  authAttemptsPerWindow: number;
  maxFileBytes: number;
  maxSceneBodyBytes: number;
  maxFilesBodyBytes: number;
  maxInFlightBodyBytes: number;
  maxBackupBytes: number;
  sessionTtlMs: number;
};
export type RequestAddressResolver = (req: Request) => string | undefined;

export type SceneRealtimeEvent = {
  type: "scene_changed";
  sceneId: string;
  revision: number;
  updatedAt: number;
  changeKind:
    | "created"
    | "content"
    | "metadata"
    | "thumbnail"
    | "deleted"
    | "restored";
};

export type WorkspaceRealtimeEvent = {
  type: "workspace_changed";
  updatedAt: number;
};

export type RealtimePublisher = {
  publishSceneChanged: (event: SceneRealtimeEvent) => void;
  publishWorkspaceChanged: (updatedAt?: number) => void;
};

export type ServerRuntime = {
  db: Database;
  dbPath: string;
  filesDir: string;
  staticDir?: string;
  config: ServerConfig;
  sessions: Map<string, number>;
  authAttempts: Map<string, { startedAt: number; count: number }>;
  writeAttempts: Map<string, { startedAt: number; count: number }>;
  bodyMemoryBudget: BodyMemoryBudget;
  realtime?: RealtimePublisher;
};
