import type { BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/element/types";

const CLOUD_API_TIMEOUT_MS = 10_000;
const CLOUD_READ_RETRIES = 2;

export interface CloudSceneSummary {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  revision: number;
  size?: number;
  tags: string[];
  favorite: boolean;
  folder_id: string | null;
  folder_name: string | null;
  last_opened_at: number | null;
  thumbnail_file_id: string | null;
  deleted_at?: number | null;
}

export interface CloudSceneData {
  id: string;
  name: string;
  elements: readonly any[];
  appState: Record<string, any>;
  created_at: number;
  updated_at: number;
  revision: number;
  tags: string[];
  favorite: boolean;
  folder_id: string | null;
  last_opened_at: number | null;
  thumbnail_file_id: string | null;
}

export interface CloudFolder {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  scene_count: number;
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

const fetchWithTimeout = async (
  input: RequestInfo | URL,
  init: RequestInit,
  fallback: string,
) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLOUD_API_TIMEOUT_MS);
  try {
    return await fetch(input, {
      // Cloud API calls may pass through a same-origin reverse proxy or a
      // separately hosted development server. Include the session cookie in
      // both cases, while the server still controls cross-origin access.
      credentials: "include",
      cache: "no-store",
      ...init,
      signal: controller.signal,
    });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new CloudApiError(`${fallback}（请求超时）`, 0, "NETWORK_TIMEOUT");
    }
    throw new CloudApiError(fallback, 0, "NETWORK_ERROR");
  } finally {
    clearTimeout(timeout);
  }
};

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
  retries = 0,
) => {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchWithTimeout(input, init, fallback);
      await assertResponse(res, fallback);
      return (await res.json()) as T;
    } catch (error) {
      const canRetry =
        error instanceof CloudApiError &&
        (error.status === 0 || error.status >= 500) &&
        attempt < retries;
      if (!canRetry) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
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
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(
    binary,
  )}`;
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
    CLOUD_READ_RETRIES,
  );
}

export async function verifyAuthPassword(password: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      "/api/auth/verify",
      {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ password }),
      },
      "认证服务不可用",
    );
    if (res.status === 401) {
      return false;
    }
    await assertResponse(res, "认证失败");
    await res.json();
    return true;
  } catch (error) {
    if (error instanceof CloudApiError && error.status === 401) {
      return false;
    }
    throw error;
  }
}

export async function logoutCloudSession(): Promise<void> {
  const res = await fetchWithTimeout(
    "/api/auth/logout",
    {
      method: "POST",
      headers: getHeaders(),
    },
    "退出授权失败",
  );
  await assertResponse(res, "退出授权失败");
}

export async function fetchCloudScenes(): Promise<CloudSceneSummary[]> {
  return fetchJson(
    "/api/scenes",
    { headers: getHeaders() },
    "获取云端画板列表失败",
    CLOUD_READ_RETRIES,
  );
}

export async function fetchCloudScene(id: string): Promise<CloudSceneData> {
  return fetchJson(
    `/api/scenes/${encodeURIComponent(id)}`,
    { headers: getHeaders() },
    "获取云端画板失败",
    CLOUD_READ_RETRIES,
  );
}

export async function createCloudScene(data: {
  id?: string;
  name?: string;
  elements?: readonly any[];
  appState?: any;
  tags?: string[];
  favorite?: boolean;
  folder_id?: string | null;
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

export async function updateCloudSceneMetadata(
  id: string,
  data: {
    name?: string;
    tags?: string[];
    favorite?: boolean;
    folder_id?: string | null;
    baseRevision?: number;
  },
): Promise<CloudSceneSummary> {
  return fetchJson(
    `/api/scenes/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: getHeaders(),
      body: JSON.stringify(data),
    },
    "更新画板信息失败",
  );
}

export async function markCloudSceneOpened(id: string): Promise<{
  success: boolean;
  id: string;
  lastOpenedAt: number;
}> {
  return fetchJson(
    `/api/scenes/${encodeURIComponent(id)}/open`,
    {
      method: "POST",
      headers: getHeaders(),
    },
    "更新最近打开时间失败",
  );
}

export async function saveCloudSceneThumbnail(
  id: string,
  blob: Blob,
): Promise<{ success: boolean; id: string; thumbnail_file_id: string }> {
  const res = await fetchWithTimeout(
    `/api/scenes/${encodeURIComponent(id)}/thumbnail`,
    {
      method: "PUT",
      headers: { "Content-Type": blob.type || "image/jpeg" },
      body: blob,
    },
    "保存画板缩略图失败",
  );
  await assertResponse(res, "保存画板缩略图失败");
  return (await res.json()) as {
    success: boolean;
    id: string;
    thumbnail_file_id: string;
  };
}

export async function fetchCloudFolders(): Promise<CloudFolder[]> {
  return fetchJson(
    "/api/folders",
    { headers: getHeaders() },
    "获取文件夹列表失败",
    CLOUD_READ_RETRIES,
  );
}

export async function createCloudFolder(name: string): Promise<CloudFolder> {
  return fetchJson(
    "/api/folders",
    {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ name }),
    },
    "创建文件夹失败",
  );
}

export async function renameCloudFolder(
  id: string,
  name: string,
): Promise<CloudFolder> {
  return fetchJson(
    `/api/folders/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: getHeaders(),
      body: JSON.stringify({ name }),
    },
    "重命名文件夹失败",
  );
}

export async function deleteCloudFolder(id: string): Promise<boolean> {
  const result = await fetchJson<{ success: boolean }>(
    `/api/folders/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      headers: getHeaders(),
    },
    "删除文件夹失败",
  );
  return result.success;
}

export async function saveCloudScene(
  id: string,
  data: {
    name?: string;
    elements?: readonly any[];
    appState?: any;
    baseRevision?: number;
  },
): Promise<{
  success: boolean;
  id: string;
  updated_at: number;
  revision: number;
}> {
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
): Promise<{
  success: boolean;
  id: string;
  updated_at: number;
  revision: number;
}> {
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

export async function fetchCloudTrashScenes(): Promise<CloudSceneSummary[]> {
  return fetchJson(
    "/api/scenes/trash",
    { headers: getHeaders() },
    "获取回收站画板失败",
    CLOUD_READ_RETRIES,
  );
}

export async function restoreCloudScene(id: string): Promise<boolean> {
  const result = await fetchJson<{ success: boolean; id: string; restored: boolean }>(
    `/api/scenes/${encodeURIComponent(id)}/restore`,
    {
      method: "POST",
      headers: getHeaders(),
    },
    "还原画板失败",
  );
  return result.success;
}

export async function deleteCloudScene(
  id: string,
  permanent = false,
): Promise<boolean> {
  const query = permanent ? "?permanent=true" : "";
  const result = await fetchJson<{ success: boolean }>(
    `/api/scenes/${encodeURIComponent(id)}${query}`,
    {
      method: "DELETE",
      headers: getHeaders(),
    },
    permanent ? "彻底删除画板失败" : "删除画板失败",
  );
  return result.success;
}

export async function saveFilesToCloud(files: BinaryFiles): Promise<void> {
  const entries = Object.values(files || {});
  await runWithConcurrency(entries, async (file) => {
    const res = await fetchWithTimeout(
      `/api/files/${encodeURIComponent(file.id)}`,
      {
        method: "PUT",
        headers: {
          Accept: "application/json",
          "Content-Type": file.mimeType,
        },
        body: dataUrlToBlob(file.dataURL, file.mimeType),
      },
      "保存云端图片失败",
    );
    await assertResponse(res, "保存云端图片失败");
  });
}

export async function fetchCloudFiles(fileIds: readonly FileId[]): Promise<{
  loadedFiles: BinaryFileData[];
  erroredFiles: Map<FileId, true>;
}> {
  const uniqueIds = [...new Set(fileIds)];
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();
  await runWithConcurrency(uniqueIds, async (id) => {
    try {
      const res = await fetchWithTimeout(
        `/api/files/${encodeURIComponent(id)}`,
        { headers: { Accept: "application/octet-stream" } },
        "加载云端图片失败",
      );
      await assertResponse(res, "加载云端图片失败");
      const contentType =
        res.headers.get("content-type")?.split(";")[0].trim() ||
        "application/octet-stream";
      const buffer = await res.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      const chunkSize = 0x8000;
      for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(
          ...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)),
        );
      }
      const dataURL = `data:${contentType};base64,${btoa(binary)}`;
      loadedFiles.push({
        id,
        mimeType: contentType as BinaryFileData["mimeType"],
        dataURL: dataURL as BinaryFileData["dataURL"],
        created: Number(res.headers.get("X-File-Created-At")) || Date.now(),
      });
    } catch (error) {
      if (error instanceof CloudApiError && error.status === 401) {
        throw error;
      }
      erroredFiles.set(id, true);
    }
  });
  return { loadedFiles, erroredFiles };
}

export async function downloadCloudBackup(): Promise<Blob> {
  const res = await fetchWithTimeout(
    "/api/backup/snapshot",
    { headers: { Accept: "application/x-sqlite3" } },
    "下载云端数据库备份失败",
  );
  await assertResponse(res, "下载云端数据库备份失败");
  return res.blob();
}

export async function downloadCloudFullBackup(): Promise<Blob> {
  const res = await fetchWithTimeout(
    "/api/backup/full",
    { headers: { Accept: "application/x-tar" } },
    "下载云端完整备份失败",
  );
  await assertResponse(res, "下载云端完整备份失败");
  return res.blob();
}
