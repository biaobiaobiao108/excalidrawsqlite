import { describe, expect, it } from "bun:test";

import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import {
  fetchCloudScenePage,
  fetchWithTimeout,
  saveFilesToCloud,
} from "../../excalidraw-app/data/cloudStorage";

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

describe("cloud API timeouts", () => {
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
