import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { NonDeletedExcalidrawElement } from "@excalidraw/element/types";

const AUTH_STORAGE_KEY = "excalidraw_sqlite_auth_password";

export interface CloudSceneSummary {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  size?: number;
}

export interface CloudSceneData {
  id: string;
  name: string;
  elements: readonly NonDeletedExcalidrawElement[];
  appState: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export function getAuthPassword(): string {
  try {
    return localStorage.getItem(AUTH_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function setAuthPassword(password: string): void {
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, password);
  } catch {
    // ignore
  }
}

export function clearAuthPassword(): void {
  try {
    localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function getHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
  const password = getAuthPassword();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };
  if (password) {
    headers["Authorization"] = `Bearer ${password}`;
    headers["x-auth-password"] = password;
  }
  return headers;
}

export async function checkAuthStatus(): Promise<{ authRequired: boolean }> {
  try {
    const res = await fetch("/api/auth/status");
    if (!res.ok) {
      return { authRequired: false };
    }
    const data = await res.json();
    return { authRequired: Boolean(data.authRequired) };
  } catch {
    return { authRequired: false };
  }
}

export async function verifyAuthPassword(password: string): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      setAuthPassword(password);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function fetchCloudScenes(): Promise<CloudSceneSummary[]> {
  const res = await fetch("/api/scenes", {
    headers: getHeaders(),
  });
  if (res.status === 401) {
    throw new Error("AUTH_REQUIRED");
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch scenes: ${res.statusText}`);
  }
  return (await res.json()) as CloudSceneSummary[];
}

export async function fetchCloudScene(id: string): Promise<CloudSceneData> {
  const res = await fetch(`/api/scenes/${encodeURIComponent(id)}`, {
    headers: getHeaders(),
  });
  if (res.status === 401) {
    throw new Error("AUTH_REQUIRED");
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch scene: ${res.statusText}`);
  }
  return (await res.json()) as CloudSceneData;
}

export async function createCloudScene(data: {
  id?: string;
  name?: string;
  elements?: readonly any[];
  appState?: any;
}): Promise<CloudSceneSummary> {
  const res = await fetch("/api/scenes", {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(data),
  });
  if (res.status === 401) {
    throw new Error("AUTH_REQUIRED");
  }
  if (!res.ok) {
    throw new Error(`Failed to create scene: ${res.statusText}`);
  }
  return (await res.json()) as CloudSceneSummary;
}

export async function saveCloudScene(
  id: string,
  data: {
    name?: string;
    elements?: readonly any[];
    appState?: any;
  },
): Promise<{ success: boolean; id: string; updated_at: number }> {
  const res = await fetch(`/api/scenes/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: getHeaders(),
    body: JSON.stringify(data),
  });
  if (res.status === 401) {
    throw new Error("AUTH_REQUIRED");
  }
  if (!res.ok) {
    throw new Error(`Failed to save scene: ${res.statusText}`);
  }
  return (await res.json()) as {
    success: boolean;
    id: string;
    updated_at: number;
  };
}

export async function deleteCloudScene(id: string): Promise<boolean> {
  const res = await fetch(`/api/scenes/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: getHeaders(),
  });
  if (res.status === 401) {
    throw new Error("AUTH_REQUIRED");
  }
  return res.ok;
}

export async function saveFilesToCloud(files: BinaryFiles): Promise<void> {
  if (!files || Object.keys(files).length === 0) {
    return;
  }
  try {
    await fetch("/api/files", {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(files),
    });
  } catch (err) {
    console.error("Failed to save files to cloud:", err);
  }
}
