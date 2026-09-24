import { describe, expect, it } from "bun:test";

import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import { saveFilesToCloud } from "../../excalidraw-app/data/cloudStorage";

describe("cloud file upload", () => {
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
