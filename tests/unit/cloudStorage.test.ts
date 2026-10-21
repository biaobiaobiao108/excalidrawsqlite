import { describe, expect, it, spyOn } from "bun:test";

import type { FileId } from "@excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import {
  downloadCloudBackup,
  downloadCloudFullBackup,
  fetchCloudScenePage,
  fetchWithTimeout,
  fetchCloudFiles,
  saveFilesToCloud,
  saveCloudSceneThumbnail,
} from "../../excalidraw-app/data/cloudStorage";

it("sends the content revision for both thumbnail uploads and empty-board deletions", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<[string, string | undefined, string | undefined]> = [];
  try {
    globalThis.fetch = (async (input, init) => {
      requests.push([String(input), init?.method, new Headers(init?.headers).get("X-Thumbnail-Version") || undefined]);
      return Response.json({ success: true, id: "scene", thumbnail_file_id: null });
    }) as typeof fetch;
    await saveCloudSceneThumbnail("scene", new Blob(["preview"], { type: "image/png" }), 123, 7);
    await saveCloudSceneThumbnail("scene", null, 124, 8);
    expect(requests).toEqual([
      ["/api/scenes/scene/thumbnail?revision=7", "PUT", "123"],
      ["/api/scenes/scene/thumbnail?revision=8", "DELETE", "124"],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

describe("cloud file upload", () => {
  for (const webCrypto of [true, false]) {
    it(`forces a reclaimed attachment upload while retaining normal deduplication (Web Crypto=${webCrypto})`, async () => {
      const originalCrypto = globalThis.crypto;
      const originalFetch = globalThis.fetch;
      const file = {
        id: `gc-upload-${webCrypto}`,
        mimeType: "image/png",
        created: 1,
        dataURL: "data:image/png;base64,aGVsbG8=",
      };
      let requests = 0;
      try {
        const digest = Array.from(new Uint8Array(await originalCrypto.subtle.digest(
          "SHA-256", new TextEncoder().encode("hello"),
        ))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
        if (!webCrypto) {
          globalThis.crypto = { subtle: undefined } as unknown as Crypto;
        }
        globalThis.fetch = (async () => {
          requests++;
          return new Response(null, { status: 204, headers: { etag: `"${digest}"` } });
        }) as unknown as typeof fetch;
        const files = { [file.id]: file } as unknown as BinaryFiles;
        await saveFilesToCloud(files);
        await saveFilesToCloud(files);
        expect(requests).toBe(1);
        if (webCrypto) {
          // Queue snapshots clone files, so this hits the ID/ETag cache.
          await saveFilesToCloud({ [file.id]: { ...file } } as unknown as BinaryFiles);
          expect(requests).toBe(1);
        }
        await saveFilesToCloud(files, { forceUpload: true });
        expect(requests).toBe(2);
        await saveFilesToCloud(files);
        expect(requests).toBe(2);
      } finally {
        globalThis.crypto = originalCrypto;
        globalThis.fetch = originalFetch;
      }
    });
  }

  it("uploads without Web Crypto and skips unchanged files on retry", async () => {
    const originalCrypto = globalThis.crypto;
    const originalFetch = globalThis.fetch;
    const requests: Array<{ input: RequestInfo | URL; method?: string }> = [];
    const file = {
      id: "file-safari-http",
      mimeType: "image/png",
      dataURL: "data:image/png;base64,aGVsbG8=",
    };

    try {
      globalThis.crypto = { subtle: undefined } as unknown as Crypto;
      globalThis.fetch = (async (input, init) => {
        requests.push({ input, method: init?.method });
        return new Response(null, { status: 204 });
      }) as typeof fetch;

      const files = { [file.id]: file } as unknown as BinaryFiles;
      await saveFilesToCloud(files);
      await saveFilesToCloud(files);

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        input: "/api/files/file-safari-http",
        method: "PUT",
      });
    } finally {
      globalThis.crypto = originalCrypto;
      globalThis.fetch = originalFetch;
    }
  });
});

it("limits image downloads across overlapping scene loads", async () => {
  const originalFetch = globalThis.fetch;
  const previousFileReader = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
  let activeRequests = 0;
  let peakRequests = 0;
  let releaseRequests!: () => void;
  let signalStarted!: () => void;
  const requestsStarted = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const requestsCanFinish = new Promise<void>((resolve) => {
    releaseRequests = resolve;
  });

  class TestFileReader {
    static readonly LOADING = 1;
    readyState = 0;
    result: string | ArrayBuffer | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;

    readAsDataURL(blob: Blob) {
      this.readyState = TestFileReader.LOADING;
      void blob.arrayBuffer().then((buffer) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
        this.readyState = 2;
        this.onload?.();
      }).catch(() => this.onerror?.());
    }

    abort() {
      this.readyState = 2;
      this.onabort?.();
    }
  }

  Object.defineProperty(globalThis, "FileReader", {
    configurable: true,
    value: TestFileReader,
  });
  globalThis.fetch = (async () => {
    activeRequests += 1;
    peakRequests = Math.max(peakRequests, activeRequests);
    if (activeRequests >= 2) {
      signalStarted();
    }
    await requestsCanFinish;
    activeRequests -= 1;
    return new Response(new Blob(["image"], { type: "image/png" }), {
      headers: { "X-File-Created-At": "1" },
    });
  }) as unknown as typeof fetch;

  try {
    const firstLoad = fetchCloudFiles(
      ["scene-a-file-1", "scene-a-file-2"] as FileId[],
    );
    const secondLoad = fetchCloudFiles(
      ["scene-b-file-1", "scene-b-file-2"] as FileId[],
    );
    await requestsStarted;
    await Bun.sleep(5);
    releaseRequests();
    const results = await Promise.all([firstLoad, secondLoad]);

    expect(peakRequests).toBe(2);
    expect(results.map(({ loadedFiles }) => loadedFiles.length)).toEqual([2, 2]);
  } finally {
    releaseRequests();
    globalThis.fetch = originalFetch;
    if (previousFileReader) {
      Object.defineProperty(globalThis, "FileReader", previousFileReader);
    } else {
      Reflect.deleteProperty(globalThis, "FileReader");
    }
  }
});

describe("cloud API timeouts", () => {
  for (const download of [downloadCloudBackup, downloadCloudFullBackup]) {
    for (const expires of [false, true]) {
      it(`${download.name} ${expires ? "aborts at its bounded backup deadline" : "finishes after the default API deadline"}`, async () => {
        const originalFetch = globalThis.fetch;
        let elapsed = 0;
        let nextTimerId = 0;
        const timers = new Map<number, { deadline: number; run: () => void }>();
        const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
          ((run: () => void, delay: number) => {
            const id = ++nextTimerId;
            timers.set(id, { deadline: elapsed + delay, run });
            return id;
          }) as typeof setTimeout,
        );
        const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(
          (id) => { timers.delete(Number(id)); },
        );
        const advance = (duration: number) => {
          elapsed += duration;
          for (const [id, timer] of timers) {
            if (timer.deadline <= elapsed) {
              timers.delete(id);
              timer.run();
            }
          }
        };
        let signal!: AbortSignal;
        let body!: ReadableStreamDefaultController<Uint8Array>;
        globalThis.fetch = (async (_input, init) => {
          signal = init!.signal!;
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller;
              signal.addEventListener("abort", () => {
                controller.error(new DOMException("Aborted", "AbortError"));
              });
            },
          }));
        }) as typeof fetch;
        try {
          const pending = download();
          void pending.catch(() => {});
          advance(10_001);
          expect(signal.aborted).toBe(false);
          if (expires) {
            advance(30 * 60_000 - 10_002);
            expect(signal.aborted).toBe(false);
            advance(1);
            expect(signal.aborted).toBe(true);
          } else {
            body.enqueue(new TextEncoder().encode("backup"));
            body.close();
          }
          if (expires) {
            await expect(pending).rejects.toMatchObject({ status: 0, code: "NETWORK_TIMEOUT" });
          } else {
            const backup = await pending;
            expect(await backup.text()).toBe("backup");
          }
          expect(timers.size).toBe(0);
        } finally {
          globalThis.fetch = originalFetch;
          timeoutSpy.mockRestore();
          clearTimeoutSpy.mockRestore();
        }
      });
    }
  }

  it("keeps the timeout active until the response body finishes", async () => {
    const originalFetch = globalThis.fetch;
    const signals: AbortSignal[] = [];
    globalThis.fetch = (async (_input, init) => {
      if (init?.signal) {
        signals.push(init.signal);
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            signals.at(-1)?.addEventListener("abort", () => {
              controller.error(new DOMException("Aborted", "AbortError"));
            });
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const response = await fetchWithTimeout(
        "/api/slow-body",
        {},
        "读取云端响应失败",
        5,
      );
      await expect(response.json()).rejects.toMatchObject({
        code: "NETWORK_TIMEOUT",
        status: 0,
      });
      expect(signals.at(-1)?.aborted).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("cloud scene pagination", () => {
  it("requests only the requested latest-scene page", async () => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      requests.push(String(input));
      return Response.json({
        items: [{ id: "latest", name: "Latest" }],
        nextCursor: "older-scenes",
      });
    }) as typeof fetch;

    try {
      const page = await fetchCloudScenePage({ limit: 1 });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.id).toBe("latest");
      expect(page.nextCursor).toBe("older-scenes");
      expect(requests).toEqual(["/api/scenes?limit=1"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
