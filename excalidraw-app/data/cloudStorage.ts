import type { BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/element/types";

export interface CloudSceneSummary {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  revision: number;
  size?: number;
}

export interface CloudSceneData {
  id: string;
  name: string;
  elements: readonly any[];
  appState: Record<string, any>;
  created_at: number;
  updated_at: number;
  revision: number;
}

export class CloudApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "CloudApiError";
  }
}

const getHeaders = (extraHeaders: Record<string, string> = {}) => ({
  "Content-Type": "application/json",
  ...extraHeaders,
});

const parseError = async (res: Response, fallback: string) => {
  try {
    const body = (await res.json()) as { error?: string; code?: string };
    return new CloudApiError(
      body.error || fallback,
      res.status,
      body.code || "HTTP_ERROR",
    );
  } catch {
    return new CloudApiError(fallback, res.status, "HTTP_ERROR");
  }
};

const assertResponse = async (res: Response, fallback: string) => {
  if (!res.ok) {
    throw await parseError(res, fallback);
  }
};

const fetchJson = async <T>(
  input: RequestInfo | URL,
  init: RequestInit,
  fallback: string,
) => {
  const res = await fetch(input, {
    credentials: "same-origin",
    ...init,
  });
  await assertResponse(res, fallback);
  return (await res.json()) as T;
};

const dataUrlToBlob = (dataURL: string, mimeType: string) => {
  const commaIndex = dataURL.indexOf(",");
  if (!dataURL.startsWith("data:") || commaIndex < 0) {
    throw new CloudApiError("图片数据格式无效", 0, "INVALID_FILE_DATA");
  }
  const encoded = dataURL.slice(commaIndex + 1);
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
};

const blobToDataUrl = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)),
    );
  }
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
};

const runWithConcurrency = async <T>(
  items: readonly T[],
  worker: (item: T) => Promise<void>,
  concurrency = 4,
) => {
  let nextIndex = 0;
  const run = async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      await worker(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, run),
  );
};

export async function checkAuthStatus(): Promise<{
  authRequired: boolean;
  authenticated: boolean;
}> {
  return fetchJson(
    "/api/auth/status",
    { headers: getHeaders() },
    "无法检查访问授权状态",
  );
}

export async function verifyAuthPassword(password: string): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/verify", {
      method: "POST",
      credentials: "same-origin",
      headers: getHeaders(),
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      return false;
    }
    await res.json();
    return true;
  } catch {
    return false;
  }
}

export async function logoutCloudSession(): Promise<void> {
  const res = await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: getHeaders(),
  });
  await assertResponse(res, "退出授权失败");
}

export async function fetchCloudScenes(): Promise<CloudSceneSummary[]> {
  return fetchJson(
    "/api/scenes",
    { headers: getHeaders() },
    "获取云端画板列表失败",
  );
}

export async function fetchCloudScene(id: string): Promise<CloudSceneData> {
  return fetchJson(
    `/api/scenes/${encodeURIComponent(id)}`,
    { headers: getHeaders() },
    "获取云端画板失败",
  );
}

export async function createCloudScene(data: {
  id?: string;
  name?: string;
  elements?: readonly any[];
  appState?: any;
}): Promise<CloudSceneSummary> {
  return fetchJson(
    "/api/scenes",
    {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(data),
    },
    "创建云端画板失败",
  );
}

export async function saveCloudScene(
  id: string,
  data: {
    name?: string;
    elements?: readonly any[];
    appState?: any;
    baseRevision?: number;
  },
): Promise<{ success: boolean; id: string; updated_at: number; revision: number }> {
  return fetchJson(
    `/api/scenes/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      headers: getHeaders(),
      body: JSON.stringify(data),
    },
    "保存云端画板失败",
  );
}

export async function renameCloudScene(
  id: string,
  name: string,
  baseRevision?: number,
): Promise<{ success: boolean; id: string; updated_at: number; revision: number }> {
  return fetchJson(
    `/api/scenes/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: getHeaders(),
      body: JSON.stringify({ name, baseRevision }),
    },
    "重命名云端画板失败",
  );
}

export async function deleteCloudScene(id: string): Promise<boolean> {
  const result = await fetchJson<{ success: boolean }>(
    `/api/scenes/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      headers: getHeaders(),
    },
    "删除云端画板失败",
  );
  return result.success;
}

export async function saveFilesToCloud(files: BinaryFiles): Promise<void> {
  const entries = Object.values(files || {});
  await runWithConcurrency(entries, async (file) => {
    const res = await fetch(`/api/files/${encodeURIComponent(file.id)}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": file.mimeType,
      },
      body: dataUrlToBlob(file.dataURL, file.mimeType),
    });
    await assertResponse(res, "保存云端图片失败");
  });
}

export async function fetchCloudFiles(
  fileIds: readonly FileId[],
): Promise<BinaryFileData[]> {
  const uniqueIds = [...new Set(fileIds)];
  const loadedFiles: BinaryFileData[] = [];
  await runWithConcurrency(uniqueIds, async (id) => {
    const res = await fetch(`/api/files/${encodeURIComponent(id)}`, {
      credentials: "same-origin",
      headers: { Accept: "application/octet-stream" },
    });
    await assertResponse(res, "加载云端图片失败");
    const blob = await res.blob();
    loadedFiles.push({
      id,
      mimeType: (blob.type || "application/octet-stream") as BinaryFileData["mimeType"],
      dataURL: (await blobToDataUrl(blob)) as BinaryFileData["dataURL"],
      created: Number(res.headers.get("X-File-Created-At")) || Date.now(),
    });
  });
  return loadedFiles;
}
