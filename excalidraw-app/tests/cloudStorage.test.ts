import { afterEach, describe, expect, it, vi } from "vitest";

import type { FileId } from "@excalidraw/element/types";
import type { BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";

import {
  fetchCloudFiles,
  fetchCloudScenes,
  saveFilesToCloud,
  verifyAuthPassword,
} from "../data/cloudStorage";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cloud storage", () => {
  it("authenticates with a session cookie without sending or storing the password", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyAuthPassword("secret-password")).resolves.toBe(true);

    const [, init] = fetchMock.mock.calls[0] as [RequestInfo, RequestInit];
    expect(init.credentials).toBe("include");
    expect(init.cache).toBe("no-store");
    expect(init.headers).not.toHaveProperty("Authorization");
    expect(init.headers).not.toHaveProperty("x-auth-password");
    expect(JSON.parse(String(init.body))).toEqual({
      password: "secret-password",
    });
    expect(localStorage.getItem("authPassword")).toBeNull();
  });

  it("rebuilds BinaryFileData from downloaded binary attachments", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo) => {
      if (String(input).endsWith("file-ok")) {
        return Promise.resolve(
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: {
              "Content-Type": "image/png",
              "X-File-Created-At": "123",
            },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCloudFiles([
      "file-ok",
      "file-missing",
    ] as FileId[]);

    expect(result.loadedFiles).toEqual([
      expect.objectContaining<Partial<BinaryFileData>>({
        id: "file-ok" as FileId,
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AQID" as BinaryFileData["dataURL"],
        created: 123,
      }),
    ]);
    expect(result.erroredFiles.has("file-missing" as FileId)).toBe(true);
  });

  it("rejects failed attachment uploads instead of treating them as successful", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: "STORAGE_ERROR" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const file = {
      id: "file-1",
      mimeType: "image/png",
      dataURL: "data:image/png;base64,AQ==",
      created: 1,
    } as BinaryFileData;

    await expect(
      saveFilesToCloud({ "file-1": file } as BinaryFiles),
    ).rejects.toMatchObject({ status: 500, code: "STORAGE_ERROR" });
  });

  it("retries transient read failures and returns the successful response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "暂时不可用" }), { status: 503 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "暂时不可用" }), { status: 502 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCloudScenes()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
