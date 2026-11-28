import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/element/types";

import {
  CLOUD_SCENE_BATCH_SIZE,
  createCloudScene,
  saveFilesToCloud,
  type CloudSceneBatchEntry,
  type CloudFolder,
  type CloudSceneSummary,
  type CloudWorkspaceStats,
} from "../data/cloudStorage";
import { remapSceneFileIds } from "../data/cloudSync";
import { getLocalSceneMigrationIdentity } from "../data/localSceneMigration";

export type BoardView = "all" | "recent" | "favorites" | "trash";
export type SortMode = "updated" | "opened" | "created";

const LOCAL_SCENE_MIGRATION_KEY = "excalidraw-cloud-scene-migration-v1";
export const DEFAULT_PAGE_QUERY_KEY = "all|updated|||";

export type WorkspaceSnapshot = {
  scenes: CloudSceneSummary[];
  trashScenes: CloudSceneSummary[];
  folders: CloudFolder[];
  stats: CloudWorkspaceStats;
  pageQueryKey: string;
  pageTotalCount: number;
};

export const SORT_OPTIONS = [
  { value: "updated", label: "按最近修改" },
  { value: "opened", label: "按最近打开" },
  { value: "created", label: "按创建时间" },
] as const;

export const BOARD_GRID_VIRTUALIZATION_THRESHOLD = 40;
export const BOARD_GRID_COLUMNS = 3;
export const BOARD_GRID_VIRTUAL_OVERSCAN_ROWS = 2;
export const BOARD_GRID_ESTIMATED_ROW_HEIGHT = 360;
export const BOARD_GRID_INITIAL_GAP = 18.4;
const BOARD_GRID_FOCUSABLE_SELECTOR =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export type SceneBatchResult = {
  scene: CloudSceneSummary;
  ok: boolean;
  error?: unknown;
};

export const runCloudSceneBatch = async (
  scenes: CloudSceneSummary[],
  operation: (entries: CloudSceneBatchEntry[]) => Promise<unknown>,
): Promise<SceneBatchResult[]> => {
  const results: SceneBatchResult[] = [];
  for (
    let offset = 0;
    offset < scenes.length;
    offset += CLOUD_SCENE_BATCH_SIZE
  ) {
    const batch = scenes.slice(offset, offset + CLOUD_SCENE_BATCH_SIZE);
    try {
      await operation(batch.map(({ id, revision }) => ({ id, revision })));
      results.push(...batch.map((scene) => ({ scene, ok: true })));
    } catch (error) {
      results.push(...batch.map((scene) => ({ scene, ok: false, error })));
    }
  }
  return results;
};

export type PendingBoardGridFocus = {
  rowIndex: number;
  direction: 1 | -1;
};

export const getBoardGridFocusableElements = (row: HTMLElement) =>
  Array.from(
    row.querySelectorAll<HTMLElement>(BOARD_GRID_FOCUSABLE_SELECTOR),
  ).filter((element) => element.getClientRects().length > 0);

export const getOwnerWindow = (node: HTMLDivElement | null) =>
  node?.ownerDocument.defaultView || window;

export const sortScenes = (scenes: CloudSceneSummary[], sort: SortMode) =>
  [...scenes].sort((left, right) => {
    const leftValue =
      sort === "opened"
        ? left.last_opened_at || 0
        : sort === "created"
          ? left.created_at
          : left.updated_at;
    const rightValue =
      sort === "opened"
        ? right.last_opened_at || 0
        : sort === "created"
          ? right.created_at
          : right.updated_at;
    if (rightValue !== leftValue) {
      return rightValue - leftValue;
    }
    return right.id.localeCompare(left.id);
  });

export const migrateLocalScene =
  async (): Promise<CloudSceneSummary | null> => {
    const [{ restoreElements }, { LocalData }, { importFromLocalStorage }] =
      await Promise.all([
        import("@excalidraw/excalidraw/data/restore"),
        import("../data/LocalData"),
        import("../data/localStorage"),
      ]);
    try {
      if (localStorage.getItem(LOCAL_SCENE_MIGRATION_KEY)) {
        return null;
      }
    } catch {
      // Continue when localStorage is unavailable; the cloud workspace still works.
    }

    const localData = importFromLocalStorage();
    const elements = localData.elements;
    const restoredElements = restoreElements(elements, null, {
      repairBindings: true,
      deleteInvisibleElements: true,
    });
    if (!restoredElements.length) {
      try {
        localStorage.setItem(LOCAL_SCENE_MIGRATION_KEY, "empty");
      } catch {
        // Ignore storage errors.
      }
      return null;
    }

    const appState = localData.appState || {};
    const migrationIdentity = getLocalSceneMigrationIdentity({
      name: "本地画板",
      elements,
      appState,
    });

    const fileIds = [
      ...new Set(
        restoredElements
          .filter(
            (element) =>
              element.type === "image" &&
              !element.isDeleted &&
              typeof (element as any).fileId === "string",
          )
          .map((element) => (element as any).fileId as FileId),
      ),
    ];
    const files: BinaryFiles = {};
    if (fileIds.length) {
      const { loadedFiles } = await LocalData.fileStorage.getFiles(fileIds);
      const loadedFileIds = new Set(loadedFiles.map((file) => file.id));
      const missingFileIds = fileIds.filter(
        (fileId) => !loadedFileIds.has(fileId),
      );
      if (missingFileIds.length) {
        throw new Error(
          `本地画板迁移失败：${missingFileIds.length} 张图片无法从本地存储读取`,
        );
      }
      for (const file of loadedFiles) {
        files[file.id] = file;
      }
      // Do not create or mark the scene as migrated unless every referenced file
      // has been accepted by the cloud. A later workspace load can retry safely.
    }
    const replacements = await saveFilesToCloud(files, {
      preserveExisting: true,
    });

    const scene = await createCloudScene({
      ...migrationIdentity,
      name: "本地画板",
      elements: remapSceneFileIds(elements, replacements),
      appState,
    });
    try {
      localStorage.setItem(LOCAL_SCENE_MIGRATION_KEY, "completed");
    } catch {
      // Ignore storage errors.
    }
    return scene;
  };
