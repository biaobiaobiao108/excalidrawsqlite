import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { isDarwin } from "@excalidraw/common";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/element/types";

import {
  checkAuthStatus,
  clearCloudTrash,
  CLOUD_SCENE_BATCH_SIZE,
  createCloudFolder,
  createCloudScene,
  deleteCloudFolder,
  deleteCloudScene,
  fetchCloudFolders,
  fetchCloudScenePage,
  fetchCloudWorkspaceStats,
  permanentlyDeleteCloudScenes,
  renameCloudFolder,
  restoreCloudScenes,
  restoreCloudScene,
  saveFilesToCloud,
  trashCloudScenes,
  updateCloudSceneMetadata,
  type CloudSceneBatchEntry,
  type CloudFolder,
  type CloudSceneSummary,
  type CloudScenePageOptions,
  type CloudWorkspaceStats,
} from "../data/cloudStorage";
import {
  broadcastWorkspaceChanged,
  subscribeCloudRealtime,
  subscribeCloudTabSync,
} from "../data/cloudSync";

import { AuthDialog } from "./AuthDialog";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { CustomSelect } from "./CustomSelect";
import { WorkspaceCommandPalette } from "./WorkspaceCommandPalette";
import { refreshWorkspacePage } from "./workspace-page-refresh";
import { parseWorkspaceSearchQuery } from "./workspace-search";
import { ThumbnailRepairQueue } from "../data/thumbnailRepairQueue";
import {
  applyBoardSelectionClick,
  isBoardSelectionModifierClick,
  pruneBoardSelection,
  type BoardSelectionClick,
  type BoardSelectionState,
} from "./board-list-selection";

import "./WorkspaceHome.scss";
import { BoardCardBadges } from "./BoardCardBadges";

type BoardView = "all" | "recent" | "favorites" | "trash";
type SortMode = "updated" | "opened" | "created";

const LOCAL_SCENE_MIGRATION_KEY = "excalidraw-cloud-scene-migration-v1";
const DEFAULT_PAGE_QUERY_KEY = "all|updated|||";

type WorkspaceSnapshot = {
  scenes: CloudSceneSummary[];
  trashScenes: CloudSceneSummary[];
  folders: CloudFolder[];
  stats: CloudWorkspaceStats;
  pageQueryKey: string;
  pageTotalCount: number;
};

let workspaceSnapshot: WorkspaceSnapshot | null = null;

type SceneMetadataDialogState = {
  scene: CloudSceneSummary;
  title: string;
  tags: string;
  folderId: string;
};

type FolderDialogState = {
  id: string | null;
  name: string;
  icon: FolderIconName;
  color: string;
};

type FolderIconName = CloudFolder["icon"];

type FolderAppearance = {
  icon: FolderIconName;
  color: string;
};

type WorkspaceContextMenuItem = {
  label: string;
  icon:
    | "open"
    | "plus"
    | "settings"
    | "star"
    | "edit"
    | "restore"
    | "folder"
    | "search"
    | "commands"
    | "refresh"
    | "trash"
    | "check"
    | "close";
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
};

type WorkspaceContextMenuState = {
  x: number;
  y: number;
  items: WorkspaceContextMenuItem[];
  portalTarget: HTMLElement;
};

const FOLDER_ICON_OPTIONS: Array<{ id: FolderIconName; label: string }> = [
  { id: "folder", label: "文件夹" },
  { id: "book", label: "笔记本" },
  { id: "palette", label: "调色盘" },
  { id: "lightbulb", label: "灵感" },
  { id: "layers", label: "图层" },
  { id: "star", label: "星标" },
  { id: "image", label: "图片" },
  { id: "code", label: "代码" },
  { id: "bookmark", label: "书签" },
  { id: "file", label: "文档" },
  { id: "tag", label: "标签" },
  { id: "heart", label: "收藏" },
  { id: "compass", label: "导航" },
  { id: "briefcase", label: "项目" },
];

const FOLDER_COLOR_OPTIONS = [
  { color: "#315f4c", label: "松柏绿" },
  { color: "#668f78", label: "鼠尾草绿" },
  { color: "#4e8290", label: "湖水蓝" },
  { color: "#bd8054", label: "陶土橙" },
  { color: "#a65f65", label: "莓果红" },
  { color: "#9675a6", label: "薰衣草紫" },
  { color: "#aa8b37", label: "麦穗黄" },
  { color: "#66717d", label: "石板灰" },
];

const DEFAULT_FOLDER_APPEARANCE: FolderAppearance = {
  icon: "folder",
  color: FOLDER_COLOR_OPTIONS[0].color,
};

type ConfirmDialogState = {
  title: string;
  message: string;
  confirmLabel?: string;
  confirmVariant?: "danger" | "primary";
  onConfirm: () => Promise<void> | void;
};

const SORT_OPTIONS = [
  { value: "updated", label: "按最近修改" },
  { value: "opened", label: "按最近打开" },
  { value: "created", label: "按创建时间" },
] as const;

const TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const BOARD_GRID_VIRTUALIZATION_THRESHOLD = 40;
const BOARD_GRID_COLUMNS = 3;
const BOARD_GRID_VIRTUAL_OVERSCAN_ROWS = 2;
const BOARD_GRID_ESTIMATED_ROW_HEIGHT = 360;
const BOARD_GRID_INITIAL_GAP = 18.4;
const BOARD_GRID_FOCUSABLE_SELECTOR =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
type SceneBatchResult = {
  scene: CloudSceneSummary;
  ok: boolean;
  error?: unknown;
};

const runCloudSceneBatch = async (
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

type PendingBoardGridFocus = {
  rowIndex: number;
  direction: 1 | -1;
};

const getBoardGridFocusableElements = (row: HTMLElement) =>
  Array.from(
    row.querySelectorAll<HTMLElement>(BOARD_GRID_FOCUSABLE_SELECTOR),
  ).filter((element) => element.getClientRects().length > 0);

const getOwnerWindow = (node: HTMLDivElement | null) =>
  node?.ownerDocument.defaultView || window;

const formatDate = (timestamp: number | null) => {
  if (!timestamp) {
    return "尚未打开";
  }
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();
  const time = TIME_FORMATTER.format(date);
  if (sameDay) {
    return `今天 ${time}`;
  }
  if (isYesterday) {
    return `昨天 ${time}`;
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(date.getDate()).padStart(2, "0")}`;
};

const sortScenes = (scenes: CloudSceneSummary[], sort: SortMode) =>
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

const migrateLocalScene = async (): Promise<CloudSceneSummary | null> => {
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
  const elements = restoreElements(localData.elements, null, {
    repairBindings: true,
    deleteInvisibleElements: true,
  });
  if (!elements.length) {
    try {
      localStorage.setItem(LOCAL_SCENE_MIGRATION_KEY, "empty");
    } catch {
      // Ignore storage errors.
    }
    return null;
  }

  const fileIds = [
    ...new Set(
      elements
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
    await saveFilesToCloud(files);
  }

  const scene = await createCloudScene({
    name: "本地画板",
    elements,
    appState: localData.appState || undefined,
  });
  try {
    localStorage.setItem(LOCAL_SCENE_MIGRATION_KEY, "completed");
  } catch {
    // Ignore storage errors.
  }
  return scene;
};

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </svg>
);

const GridIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="4" y="4" width="6" height="6" rx="1" />
    <rect x="14" y="4" width="6" height="6" rx="1" />
    <rect x="4" y="14" width="6" height="6" rx="1" />
    <rect x="14" y="14" width="6" height="6" rx="1" />
  </svg>
);

const ClockIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="8" />
    <path d="M12 7v5l3 2" />
  </svg>
);

const StarIcon = ({ filled = false }: { filled?: boolean }) => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    className={filled ? "is-filled" : ""}
  >
    <path d="m12 3 2.78 5.63 6.22.9-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.92 1.06-6.2L3 9.53l6.22-.9L12 3Z" />
  </svg>
);

const FolderIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3.5 6.5h6l2 2H20.5v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-11Z" />
  </svg>
);

const FolderAppearanceIcon = ({ icon }: { icon: FolderIconName }) => {
  if (icon === "folder") {
    return <FolderIcon />;
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {icon === "book" && (
        <>
          <path d="M5 4.5h12a2 2 0 0 1 2 2v13H7a2 2 0 0 1-2-2v-13Z" />
          <path d="M5 4.5v13a2 2 0 0 0 2 2M9 8h6M9 11h6" />
        </>
      )}
      {icon === "palette" && (
        <>
          <path d="M12 3.5a8.5 8.5 0 1 0 0 17h1.2a2 2 0 0 0 1.1-3.7 1.2 1.2 0 0 1 .7-2.2h1.4a4.1 4.1 0 0 0 4.1-4.1A8.5 8.5 0 0 0 12 3.5Z" />
          <circle cx="7.8" cy="10" r=".8" />
          <circle cx="11" cy="7.4" r=".8" />
          <circle cx="15" cy="8" r=".8" />
        </>
      )}
      {icon === "lightbulb" && (
        <>
          <path d="M9 18h6M10 21h4M8.6 14.5A6 6 0 1 1 15.4 14.5c-.8.6-1.4 1.4-1.4 2.5h-4c0-1.1-.6-1.9-1.4-2.5Z" />
          <path d="M12 2v1.5M4.9 4.9 6 6M19.1 4.9 18 6" />
        </>
      )}
      {icon === "layers" && (
        <>
          <path d="m12 3 9 5-9 5-9-5 9-5Z" />
          <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
        </>
      )}
      {icon === "star" && (
        <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z" />
      )}
      {icon === "image" && (
        <>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <circle cx="9" cy="10" r="1.5" />
          <path d="m5 17 4.5-4 3.2 2.5 2.3-2 4 3.5" />
        </>
      )}
      {icon === "code" && <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-2-13-4 16" />}
      {icon === "bookmark" && (
        <path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-4-6 4V4.5Z" />
      )}
      {icon === "file" && (
        <>
          <path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3.5Z" />
          <path d="M14 3.5V8h4M9 12h6M9 16h6" />
        </>
      )}
      {icon === "tag" && (
        <>
          <path d="M20 13 13 20 3.5 10.5V4h6.5L20 13Z" />
          <circle cx="7.5" cy="8" r="1" />
        </>
      )}
      {icon === "heart" && (
        <path d="M20.8 8.8c0 5.1-8.8 10.3-8.8 10.3S3.2 13.9 3.2 8.8a4.5 4.5 0 0 1 8.8-1.3 4.5 4.5 0 0 1 8.8 1.3Z" />
      )}
      {icon === "compass" && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m15.8 8.2-2.3 5.3-5.3 2.3 2.3-5.3 5.3-2.3Z" />
        </>
      )}
      {icon === "briefcase" && (
        <>
          <rect x="3.5" y="7" width="17" height="13" rx="2" />
          <path d="M8.5 7V5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2M3.5 12h17M10 12v2h4v-2" />
        </>
      )}
    </svg>
  );
};

const TrashIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
  </svg>
);

const EmptyTrashIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 7h16" />
    <path d="M10 3h4a2 2 0 0 1 2 2v2H8V5a2 2 0 0 1 2-2Z" />
    <path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7" />
    <path d="M10 11v6M14 11v6" />
  </svg>
);

const EditIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

const RestoreIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <polyline points="1 4 1 10 7 10" />
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
  </svg>
);

const BoardSelectionIcon = ({ selected = false }: { selected?: boolean }) => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    className={selected ? "is-selected" : ""}
  >
    <circle cx="12" cy="12" r="9" />
    {selected && <path d="m8 12 2.5 2.5L16.5 9" />}
  </svg>
);

const WorkspaceContextMenuIcon = ({
  icon,
}: {
  icon: WorkspaceContextMenuItem["icon"];
}) => {
  if (icon === "star") {
    return <StarIcon />;
  }
  if (icon === "edit") {
    return <EditIcon />;
  }
  if (icon === "restore") {
    return <RestoreIcon />;
  }
  if (icon === "trash") {
    return <TrashIcon />;
  }
  if (icon === "check") {
    return <BoardSelectionIcon selected />;
  }
  if (icon === "search") {
    return <SearchIcon />;
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {icon === "open" && <path d="M7 17 17 7M8 7h9v9" />}
      {icon === "plus" && <path d="M12 5v14M5 12h14" />}
      {icon === "close" && <path d="m6 6 12 12M18 6 6 18" />}
      {icon === "folder" && (
        <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z" />
      )}
      {icon === "commands" && <path d="m5 7 5 5-5 5M13 17h6" />}
      {icon === "refresh" && (
        <>
          <path d="M20 7v5h-5M4 17v-5h5" />
          <path d="M5.5 7a7.5 7.5 0 0 1 12-1L20 12M4 12l2.5 6a7.5 7.5 0 0 0 12-1" />
        </>
      )}
      {icon === "settings" && (
        <>
          <path d="M4 6h16M4 12h16M4 18h16" />
          <circle cx="8" cy="6" r="2" fill="currentColor" />
          <circle cx="16" cy="12" r="2" fill="currentColor" />
          <circle cx="10" cy="18" r="2" fill="currentColor" />
        </>
      )}
    </svg>
  );
};

const ExcalidrawMark = () => (
  <div className="workspace-mark" aria-hidden="true">
    <img src="/brand-icon.jpg" alt="" width="512" height="512" />
  </div>
);

const thumbnailRepairQueue = new ThumbnailRepairQueue();

const EmptyThumbnail = ({
  label = "空白画板",
  containerRef,
}: {
  label?: string;
  containerRef?: React.Ref<HTMLDivElement>;
}) => (
  <div ref={containerRef} className="board-thumbnail board-thumbnail-empty">
    <div className="empty-thumbnail-mark">
      <span />
      <span />
      <span />
    </div>
    <span>{label}</span>
  </div>
);

const BoardThumbnail = ({
  scene,
  eager = false,
}: {
  scene: CloudSceneSummary;
  eager?: boolean;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [repaired, setRepaired] = useState<{
    revision: number;
    id: string;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const thumbnailId =
    scene.thumbnail_file_id ||
    (repaired?.revision === scene.revision ? repaired.id : null);
  const needsRepair =
    !thumbnailId && (scene.element_count || 0) > 0 && !scene.deleted_at;

  useEffect(() => {
    setFailed(false);
    if (!needsRepair || !containerRef.current) {
      return;
    }
    let cancelled = false;
    let cancelQueued: (() => void) | undefined;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) {
        return;
      }
      observer.disconnect();
      cancelQueued = thumbnailRepairQueue.schedule(async () => {
        if (cancelled) {
          return;
        }
        try {
          const { repairSceneThumbnail } =
            await import("../data/repairSceneThumbnail");
          const id = await repairSceneThumbnail(
            scene.id,
            scene.revision,
            () => cancelled,
          );
          if (!cancelled) {
            if (id) {
              setRepaired({ revision: scene.revision, id });
            } else {
              setFailed(true);
            }
          }
        } catch {
          if (!cancelled) {
            setFailed(true);
          }
        }
      });
    });
    observer.observe(containerRef.current);
    return () => {
      cancelled = true;
      observer.disconnect();
      cancelQueued?.();
    };
  }, [scene.id, scene.revision, needsRepair]);

  if (!thumbnailId) {
    return (
      <EmptyThumbnail
        containerRef={containerRef}
        label={
          (scene.element_count || 0) > 0
            ? failed || scene.deleted_at
              ? "预览暂不可用"
              : "正在生成预览…"
            : "空白画板"
        }
      />
    );
  }
  return (
    <div ref={containerRef} className="board-thumbnail">
      <img
        src={`/api/files/${encodeURIComponent(thumbnailId)}?v=${
          scene.updated_at
        }`}
        alt={`${scene.name} 预览`}
        width={640}
        height={400}
        loading={eager ? "eager" : "lazy"}
        fetchPriority={eager ? "high" : "low"}
      />
    </div>
  );
};

const BoardCard = React.memo(
  ({
    scene,
    onOpen,
    onPreload,
    onToggleFavorite,
    onEdit,
    onDelete,
    onRestore,
    onOpenContextMenu,
    onToggleSelection,
    hasSelectionActive,
    folderAppearance = DEFAULT_FOLDER_APPEARANCE,
    isTrash = false,
    isSelected = false,
    actionPending = false,
    eager,
  }: {
    scene: CloudSceneSummary;
    onOpen: (scene: CloudSceneSummary, newTab?: boolean) => void;
    onPreload?: () => void;
    onToggleFavorite: (scene: CloudSceneSummary) => void;
    onEdit: (scene: CloudSceneSummary) => void;
    onDelete: (scene: CloudSceneSummary) => void;
    onRestore?: (scene: CloudSceneSummary) => void;
    onOpenContextMenu: (
      scene: CloudSceneSummary,
      event: React.MouseEvent<HTMLElement>,
    ) => void;
    onToggleSelection: (
      sceneId: string,
      modifiers?: Omit<BoardSelectionClick, "id">,
    ) => void;
    hasSelectionActive: boolean;
    folderAppearance?: FolderAppearance;
    isTrash?: boolean;
    isSelected?: boolean;
    actionPending?: boolean;
    eager?: boolean;
  }) => {
    const sceneName = scene.name || "未命名白板";
    const hasBadges =
      !isTrash && (Boolean(scene.folder_name) || scene.tags.length > 0);

    const handleOpen = (event: React.MouseEvent) => {
      const isNewTab = event.button === 1 || event.ctrlKey || event.metaKey;
      if (isNewTab) {
        event.preventDefault();
        event.stopPropagation();
        onOpen(scene, true);
        return;
      }
      if (event.button === 0) {
        event.preventDefault();
        onOpen(scene, false);
      }
    };

    return (
      <article
        className={`board-card ${isTrash ? "is-trash-card" : ""} ${
          isSelected ? "is-selected" : ""
        }`.trim()}
        tabIndex={0}
        aria-label={`${sceneName}，${isSelected ? "已选择" : "未选择"}；空格键切换选择，回车打开画板`}
        aria-keyshortcuts="Space Enter"
        onMouseEnter={onPreload}
        onFocusCapture={onPreload}
        onContextMenu={(event) => onOpenContextMenu(scene, event)}
        onClickCapture={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest(
              ".board-card-selection-toggle, .board-card-actions",
            )
          ) {
            return;
          }
          if (!isBoardSelectionModifierClick(event) && !hasSelectionActive) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          onToggleSelection(scene.id, {
            metaKey: event.metaKey,
            ctrlKey:
              event.ctrlKey ||
              (!event.shiftKey && !event.metaKey && hasSelectionActive),
            shiftKey: event.shiftKey,
          });
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || actionPending) {
            return;
          }
          if (event.key === " " || event.key === "Spacebar") {
            event.preventDefault();
            onToggleSelection(scene.id, {
              metaKey: event.metaKey,
              ctrlKey: event.ctrlKey || (!event.shiftKey && !event.metaKey),
              shiftKey: event.shiftKey,
            });
          } else if (event.key === "Enter" && !isTrash) {
            event.preventDefault();
            onOpen(scene, false);
          }
        }}
      >
        <button
          type="button"
          className="board-card-selection-toggle"
          aria-label={`${isSelected ? "取消选择" : "选择"}画板“${sceneName}”`}
          aria-pressed={isSelected}
          title={isSelected ? "取消选择" : "加入多选"}
          onClick={() => onToggleSelection(scene.id, { ctrlKey: true })}
          disabled={actionPending}
        >
          <BoardSelectionIcon selected={isSelected} />
        </button>
        {isTrash ? (
          <div
            className="board-card-open is-disabled"
            title="已在回收站中，还原后可打开"
          >
            <BoardThumbnail scene={scene} eager={eager} />
            <span className="board-card-title" title={sceneName}>
              {sceneName}
            </span>
          </div>
        ) : (
          <div className="board-card-open">
            <button
              className="board-card-thumbnail-button"
              onClick={handleOpen}
              onAuxClick={handleOpen}
              type="button"
              aria-label={`打开画板“${sceneName}”`}
            >
              <BoardThumbnail scene={scene} eager={eager} />
            </button>
            <button
              className="board-card-title"
              onClick={handleOpen}
              onAuxClick={handleOpen}
              type="button"
              aria-label={`打开画板“${sceneName}”`}
              title={sceneName}
            >
              {sceneName}
            </button>
          </div>
        )}
        <div className="board-card-footer">
          <div className="board-card-details">
            {isTrash ? (
              <span className="board-card-mobile-title" title={sceneName}>
                {sceneName}
              </span>
            ) : (
              <button
                type="button"
                className="board-card-mobile-title"
                onClick={handleOpen}
                onAuxClick={handleOpen}
                aria-label={`打开画板“${sceneName}”`}
                title={sceneName}
              >
                {sceneName}
              </button>
            )}
            {hasBadges && (
              <BoardCardBadges
                tags={scene.tags}
                folderName={scene.folder_name}
                folderIcon={
                  <FolderAppearanceIcon icon={folderAppearance.icon} />
                }
                folderColor={folderAppearance.color}
              />
            )}
            <div className="board-card-meta-row">
              <span
                className="board-card-elements-count"
                title={`包含 ${scene.element_count ?? 0} 个图元`}
              >
                {scene.element_count ?? 0} 个图元
              </span>
              <span className="meta-separator" aria-hidden="true">
                •
              </span>
              {isTrash && scene.deleted_at ? (
                <span className="board-card-updated">
                  删除于 {formatDate(scene.deleted_at)}
                </span>
              ) : (
                <span className="board-card-updated">
                  更新于 {formatDate(scene.updated_at)}
                </span>
              )}
            </div>
          </div>
          <div className="board-card-actions">
            {isTrash ? (
              <>
                {onRestore && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`还原画板“${sceneName}”`}
                    title="还原画板"
                    onClick={() => onRestore(scene)}
                    disabled={actionPending}
                  >
                    <RestoreIcon />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-button danger"
                  aria-label={`彻底删除“${sceneName}”`}
                  title="彻底删除"
                  onClick={() => onDelete(scene)}
                  disabled={actionPending}
                >
                  <TrashIcon />
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className={`icon-button favorite-button ${
                    scene.favorite ? "is-favorite" : ""
                  }`}
                  aria-label={scene.favorite ? "取消收藏" : "收藏画板"}
                  aria-pressed={scene.favorite}
                  title={scene.favorite ? "取消收藏" : "收藏画板"}
                  onClick={() => onToggleFavorite(scene)}
                  disabled={actionPending}
                >
                  <StarIcon filled={scene.favorite} />
                </button>
                <button
                  type="button"
                  className="icon-button edit-button"
                  aria-label={`编辑画板信息“${sceneName}”`}
                  title="编辑画板信息"
                  onClick={() => onEdit(scene)}
                  disabled={actionPending}
                >
                  <EditIcon />
                </button>
                <button
                  type="button"
                  className="icon-button danger delete-button"
                  aria-label={`移至回收站“${sceneName}”`}
                  title="移至回收站"
                  onClick={() => onDelete(scene)}
                  disabled={actionPending}
                >
                  <TrashIcon />
                </button>
              </>
            )}
          </div>
        </div>
      </article>
    );
  },
  (previous, next) =>
    previous.scene === next.scene &&
    previous.isTrash === next.isTrash &&
    previous.isSelected === next.isSelected &&
    previous.hasSelectionActive === next.hasSelectionActive &&
    previous.actionPending === next.actionPending &&
    previous.eager === next.eager &&
    previous.folderAppearance === next.folderAppearance &&
    previous.onOpen === next.onOpen &&
    previous.onPreload === next.onPreload &&
    previous.onToggleFavorite === next.onToggleFavorite &&
    previous.onEdit === next.onEdit &&
    previous.onDelete === next.onDelete &&
    previous.onRestore === next.onRestore &&
    previous.onOpenContextMenu === next.onOpenContextMenu &&
    previous.onToggleSelection === next.onToggleSelection,
);

const WorkspaceModal = WorkspaceDialog;

const MetadataDialog = ({
  state,
  folders,
  pending,
  onChange,
  onClose,
  onSave,
}: {
  state: SceneMetadataDialogState;
  folders: CloudFolder[];
  pending: boolean;
  onChange: (next: Partial<SceneMetadataDialogState>) => void;
  onClose: () => void;
  onSave: () => void;
}) => (
  <WorkspaceModal title="编辑画板信息" onClose={onClose}>
    <form
      className="metadata-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <label>
        <span>标题</span>
        <input
          value={state.title}
          maxLength={120}
          onChange={(event) => onChange({ title: event.target.value })}
        />
      </label>
      <label>
        <span>标签</span>
        <input
          value={state.tags}
          placeholder="用逗号分隔多个标签"
          onChange={(event) => onChange({ tags: event.target.value })}
        />
      </label>
      <label>
        <span>文件夹</span>
        <CustomSelect
          value={state.folderId}
          options={[
            { value: "", label: "根目录" },
            ...folders.map((folder) => ({
              value: folder.id,
              label: folder.name,
            })),
          ]}
          onChange={(folderId) => onChange({ folderId })}
          ariaLabel="文件夹"
          size="field"
        />
      </label>
      <div className="dialog-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={onClose}
          disabled={pending}
        >
          取消
        </button>
        <button type="submit" className="primary-button" disabled={pending}>
          {pending ? "保存中..." : "保存信息"}
        </button>
      </div>
    </form>
  </WorkspaceModal>
);

const FolderDialog = ({
  state,
  pending,
  onChange,
  onClose,
  onSave,
  onDelete,
  onChangeAppearance,
}: {
  state: FolderDialogState;
  pending: boolean;
  onChange: (name: string) => void;
  onClose: () => void;
  onSave: () => void;
  onDelete?: () => void;
  onChangeAppearance: (
    next: Partial<Pick<FolderDialogState, "icon" | "color">>,
  ) => void;
}) => (
  <WorkspaceModal
    className="folder-dialog"
    title={state.id ? "编辑文件夹" : "新建文件夹"}
    onClose={onClose}
  >
    <form
      className="metadata-form folder-metadata-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <label>
        <span>名称</span>
        <input
          value={state.name}
          maxLength={80}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <fieldset className="folder-appearance-fieldset folder-icon-fieldset">
        <legend>图标</legend>
        <div className="folder-icon-options">
          {FOLDER_ICON_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={state.icon === option.id ? "is-selected" : ""}
              aria-label={option.label}
              aria-pressed={state.icon === option.id}
              title={option.label}
              onClick={() => onChangeAppearance({ icon: option.id })}
              disabled={pending}
            >
              <FolderAppearanceIcon icon={option.id} />
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="folder-appearance-fieldset folder-color-fieldset">
        <legend>颜色</legend>
        <div className="folder-color-options">
          {FOLDER_COLOR_OPTIONS.map((option) => (
            <button
              key={option.color}
              type="button"
              className={
                state.color.toLowerCase() === option.color ? "is-selected" : ""
              }
              style={{ "--swatch-color": option.color } as React.CSSProperties}
              aria-label={option.label}
              aria-pressed={state.color.toLowerCase() === option.color}
              title={option.label}
              onClick={() => onChangeAppearance({ color: option.color })}
              disabled={pending}
            />
          ))}
        </div>
      </fieldset>
      <div className="dialog-actions folder-dialog-actions">
        {state.id && onDelete && (
          <button
            type="button"
            className="danger-button folder-delete-button"
            onClick={onDelete}
            disabled={pending}
          >
            删除文件夹
          </button>
        )}
        <button type="submit" className="primary-button" disabled={pending}>
          {pending ? "保存中..." : state.id ? "保存修改" : "创建文件夹"}
        </button>
      </div>
    </form>
  </WorkspaceModal>
);

const WorkspaceContextMenu = ({
  state,
  onClose,
}: {
  state: WorkspaceContextMenuState;
  onClose: () => void;
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: state.x, y: state.y });
  const [activeItem, setActiveItem] = useState<string | null>(null);

  useLayoutEffect(() => {
    const bounds = menuRef.current?.getBoundingClientRect();
    if (!bounds) {
      return;
    }
    const padding = 8;
    setPosition({
      x: Math.max(
        padding,
        Math.min(state.x, window.innerWidth - bounds.width - padding),
      ),
      y: Math.max(
        padding,
        Math.min(state.y, window.innerHeight - bounds.height - padding),
      ),
    });
  }, [state.x, state.y, state.items.length]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
        return;
      }
      const buttons = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        ) || [],
      );
      if (!buttons.length) {
        return;
      }
      event.preventDefault();
      const currentIndex = buttons.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      const nextIndex =
        event.key === "ArrowDown"
          ? (currentIndex + 1) % buttons.length
          : (currentIndex <= 0 ? buttons.length : currentIndex) - 1;
      buttons[nextIndex]?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    setActiveItem(null);
    menuRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onClose, state]);

  return createPortal(
    <div
      ref={menuRef}
      className="workspace-context-menu"
      role="menu"
      tabIndex={-1}
      aria-label="操作菜单"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerLeave={() => setActiveItem(null)}
      onPointerMove={(event) => {
        if (
          !(event.target instanceof Element) ||
          !event.target.closest("button:not(:disabled)")
        ) {
          setActiveItem(null);
        }
      }}
      style={{ left: position.x, top: position.y }}
    >
      {state.items.map((item) => (
        <React.Fragment key={item.label}>
          {item.separatorBefore && (
            <div
              className="workspace-context-menu-separator"
              role="separator"
            />
          )}
          <button
            type="button"
            role="menuitem"
            className={`${item.danger ? "is-danger" : ""} ${
              activeItem === item.label ? "is-active" : ""
            }`.trim()}
            disabled={item.disabled}
            onPointerMove={(event) => {
              if (!item.disabled) {
                if (document.activeElement !== event.currentTarget) {
                  event.currentTarget.focus({ preventScroll: true });
                }
                setActiveItem(item.label);
              } else {
                setActiveItem(null);
              }
            }}
            onFocus={() => setActiveItem(item.label)}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            <WorkspaceContextMenuIcon icon={item.icon} />
            {item.label}
          </button>
        </React.Fragment>
      ))}
    </div>,
    state.portalTarget,
  );
};

const ConfirmDialog = ({
  state,
  pending,
  onClose,
  onConfirm,
}: {
  state: ConfirmDialogState;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) => (
  <WorkspaceModal
    title={state.title}
    onClose={onClose}
    className="confirm-dialog"
  >
    <div className="confirm-dialog-content">
      <p className="confirm-dialog-message">{state.message}</p>
      <div className="dialog-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={onClose}
          disabled={pending}
        >
          取消
        </button>
        <button
          type="button"
          className={`primary-button ${
            state.confirmVariant === "danger" ? "danger" : ""
          }`}
          autoFocus
          onClick={onConfirm}
          disabled={pending}
        >
          {pending ? "处理中..." : state.confirmLabel || "确认"}
        </button>
      </div>
    </div>
  </WorkspaceModal>
);

export const WorkspaceHome = ({
  onSelectScene,
  onPreloadScene,
}: {
  onSelectScene?: (sceneId: string) => void;
  onPreloadScene?: () => void;
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const workspaceNavRef = useRef<HTMLElement | null>(null);
  const boardGridRef = useRef<HTMLDivElement>(null);
  const pendingBoardGridFocusRef = useRef<PendingBoardGridFocus | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [boardGridMetrics, setBoardGridMetrics] = useState({
    rowGap: BOARD_GRID_INITIAL_GAP,
    scrollMargin: 0,
    columns: BOARD_GRID_COLUMNS,
  });
  const [workspaceNavOverflow, setWorkspaceNavOverflow] = useState({
    left: false,
    right: false,
  });
  const [scenes, setScenes] = useState<CloudSceneSummary[]>(() =>
    workspaceSnapshot?.pageQueryKey === DEFAULT_PAGE_QUERY_KEY
      ? workspaceSnapshot.scenes
      : [],
  );
  const [trashScenes, setTrashScenes] = useState<CloudSceneSummary[]>(
    () => workspaceSnapshot?.trashScenes || [],
  );
  const [folders, setFolders] = useState<CloudFolder[]>(
    () => workspaceSnapshot?.folders || [],
  );
  const [workspaceStats, setWorkspaceStats] =
    useState<CloudWorkspaceStats | null>(
      () => workspaceSnapshot?.stats || null,
    );
  const [pageTotalCount, setPageTotalCount] = useState(() =>
    workspaceSnapshot?.pageQueryKey === DEFAULT_PAGE_QUERY_KEY
      ? workspaceSnapshot.pageTotalCount
      : 0,
  );
  const loadedPageQueryKeyRef = useRef(workspaceSnapshot?.pageQueryKey || "");
  // Keep the visible page and its filters together until the next request wins.
  const [displayedPageOptions, setDisplayedPageOptions] =
    useState<CloudScenePageOptions>({});
  const [view, setView] = useState<BoardView>("all");
  const [sort, setSort] = useState<SortMode>("updated");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [sceneSelection, setSceneSelection] = useState<BoardSelectionState>(
    () => ({ ids: new Set(), anchorId: null }),
  );
  const sceneSelectionRef = useRef(sceneSelection);
  sceneSelectionRef.current = sceneSelection;
  const selectedSceneIds = sceneSelection.ids;
  const [loading, setLoading] = useState(
    () => workspaceSnapshot?.pageQueryKey !== DEFAULT_PAGE_QUERY_KEY,
  );
  const [error, setError] = useState("");
  const [authOpen, setAuthOpen] = useState(false);
  const [metadataDialog, setMetadataDialog] =
    useState<SceneMetadataDialogState | null>(null);
  const [folderDialog, setFolderDialog] = useState<FolderDialogState | null>(
    null,
  );
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(
    null,
  );
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [contextMenu, setContextMenu] =
    useState<WorkspaceContextMenuState | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [sceneCursor, setSceneCursor] = useState<string | null>(null);
  const [trashSceneCursor, setTrashSceneCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const handleRequestError = useCallback(
    (requestError: any, fallback: string) => {
      if (
        requestError?.status === 401 ||
        requestError?.code === "AUTH_REQUIRED"
      ) {
        setAuthOpen(true);
      } else {
        setError(requestError?.message || fallback);
      }
    },
    [],
  );
  const loadRequestRef = useRef(0);
  const pageRequestRef = useRef(0);
  const loadMoreRequestRef = useRef(0);
  const workspaceLoadedRef = useRef(false);
  const pageQueryKey = [
    view,
    sort,
    searchQuery.trim(),
    selectedFolderId || "",
  ].join("|");
  const pageQueryKeyRef = useRef(pageQueryKey);
  pageQueryKeyRef.current = pageQueryKey;
  const previousPageQueryKeyRef = useRef(pageQueryKey);
  const previousSearchQueryRef = useRef(searchQuery.trim());
  const pageTransitionPending = loadedPageQueryKeyRef.current !== pageQueryKey;
  const hasDisplayedFilters = Boolean(
    displayedPageOptions.query ||
    displayedPageOptions.tag ||
    displayedPageOptions.folderId,
  );
  const currentPageOptions: CloudScenePageOptions = {
    trash: view === "trash",
    ...parseWorkspaceSearchQuery(searchQuery),
    folderId: view === "trash" ? undefined : selectedFolderId,
    favorite: view === "favorites",
    opened: view === "recent",
    sort: view === "recent" ? "opened" : sort,
  };
  const currentPageRef = useRef({
    key: pageQueryKey,
    options: currentPageOptions,
  });
  currentPageRef.current = { key: pageQueryKey, options: currentPageOptions };
  const loadedScenesRef = useRef({ scenes, trashScenes });
  loadedScenesRef.current = { scenes, trashScenes };

  const searchWorkspace = useCallback((query: string) => {
    setView("all");
    setSelectedFolderId(null);
    setSearchQuery(query);
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const updateSceneSelection = useCallback((next: BoardSelectionState) => {
    const normalized = { ids: new Set(next.ids), anchorId: next.anchorId };
    sceneSelectionRef.current = normalized;
    setSceneSelection(normalized);
  }, []);
  const clearSceneSelection = useCallback(() => {
    updateSceneSelection({ ids: new Set(), anchorId: null });
  }, [updateSceneSelection]);
  const removeSceneIdsFromSelection = useCallback(
    (ids: string[]) => {
      const current = sceneSelectionRef.current;
      const nextIds = new Set(current.ids);
      ids.forEach((id) => nextIds.delete(id));
      const anchorId =
        current.anchorId && nextIds.has(current.anchorId)
          ? current.anchorId
          : nextIds.values().next().value || null;
      updateSceneSelection({ ids: nextIds, anchorId });
    },
    [updateSceneSelection],
  );
  const showContextMenu = useCallback(
    (
      event: React.MouseEvent<HTMLElement>,
      items: WorkspaceContextMenuItem[],
    ) => {
      event.preventDefault();
      event.stopPropagation();
      const target =
        event.target instanceof Element ? event.target : event.currentTarget;
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        items,
        portalTarget:
          target.closest<HTMLElement>('dialog, [role="dialog"]') ||
          event.currentTarget.ownerDocument.body,
      });
    },
    [],
  );

  useEffect(() => {
    clearSceneSelection();
    closeContextMenu();
  }, [clearSceneSelection, closeContextMenu, pageQueryKey]);

  const loadWorkspace = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    const { key: queryKey, options } = currentPageRef.current;
    pageRequestRef.current += 1;
    loadMoreRequestRef.current += 1;
    setLoadingMore(false);
    const isCurrent = () =>
      loadRequestRef.current === requestId &&
      currentPageRef.current.key === queryKey;
    const loadedCount =
      loadedPageQueryKeyRef.current === queryKey
        ? (options.trash
            ? loadedScenesRef.current.trashScenes
            : loadedScenesRef.current.scenes
          ).length
        : 0;
    if (!workspaceSnapshot) {
      setLoading(true);
    }
    setError("");
    try {
      const auth = await checkAuthStatus();
      if (!isCurrent()) {
        return;
      }
      if (auth.authRequired && !auth.authenticated) {
        setAuthOpen(true);
        return;
      }
      const [scenePage, folderList, trashPage, stats] = await Promise.all([
        options.trash
          ? fetchCloudScenePage({})
          : refreshWorkspacePage(
              options,
              loadedCount,
              fetchCloudScenePage,
              isCurrent,
            ),
        fetchCloudFolders(),
        options.trash
          ? refreshWorkspacePage(
              options,
              loadedCount,
              fetchCloudScenePage,
              isCurrent,
            )
          : fetchCloudScenePage({ trash: true }),
        fetchCloudWorkspaceStats(),
      ]);
      if (!isCurrent() || !scenePage || !trashPage) {
        return;
      }
      let migratedScene: CloudSceneSummary | null = null;
      if (stats.sceneCount === 0 && stats.trashCount === 0) {
        try {
          migratedScene = await migrateLocalScene();
        } catch (migrationError) {
          console.warn("迁移本地画板失败", migrationError);
        }
      }
      const [nextScenePage, nextTrashPage, nextStats] = migratedScene
        ? await Promise.all([
            fetchCloudScenePage(options.trash ? {} : options),
            fetchCloudScenePage(options.trash ? options : { trash: true }),
            fetchCloudWorkspaceStats(),
          ])
        : [scenePage, trashPage, stats];
      const nextSnapshot = {
        scenes: nextScenePage.items,
        folders: folderList,
        trashScenes: nextTrashPage.items,
        stats: nextStats,
        pageQueryKey: queryKey,
        pageTotalCount: options.trash
          ? nextTrashPage.totalCount
          : nextScenePage.totalCount,
      };
      if (!isCurrent()) {
        return;
      }
      workspaceSnapshot = nextSnapshot;
      setScenes(nextSnapshot.scenes);
      setFolders(nextSnapshot.folders);
      setTrashScenes(nextSnapshot.trashScenes);
      setWorkspaceStats(nextSnapshot.stats);
      setPageTotalCount(nextSnapshot.pageTotalCount);
      loadedPageQueryKeyRef.current = queryKey;
      setDisplayedPageOptions(options);
      setSceneCursor(nextScenePage.nextCursor);
      setTrashSceneCursor(nextTrashPage.nextCursor);
    } catch (requestError: any) {
      if (!isCurrent()) {
        return;
      }
      if (
        requestError?.status === 401 ||
        requestError?.code === "AUTH_REQUIRED"
      ) {
        setAuthOpen(true);
      } else {
        setError(requestError?.message || "加载画板首页失败");
      }
      // The page never committed. Leaving the loaded key pointing at the
      // previous filter keeps the grid permanently inert (no interaction, no
      // "load more", no retry), while rendering the old boards under the new
      // heading would be misleading. Settle the key with an empty list.
      if (loadedPageQueryKeyRef.current !== queryKey) {
        loadedPageQueryKeyRef.current = queryKey;
        if (options.trash) {
          setTrashScenes([]);
          setTrashSceneCursor(null);
        } else {
          setScenes([]);
          setSceneCursor(null);
        }
        setPageTotalCount(0);
        setDisplayedPageOptions(options);
      }
    } finally {
      if (!isCurrent()) {
        return;
      }
      workspaceLoadedRef.current = true;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!workspaceStats) {
      return;
    }
    if (
      selectedFolderId &&
      !folders.some((folder) => folder.id === selectedFolderId)
    ) {
      setSelectedFolderId(null);
    }
  }, [workspaceStats, folders, selectedFolderId]);

  const getCurrentPageOptions = useCallback(
    (cursor: string | null = null) => ({
      ...currentPageRef.current.options,
      cursor,
    }),
    [],
  );

  const reloadCurrentPage = useCallback(async () => {
    if (!workspaceLoadedRef.current) {
      return;
    }
    const requestId = ++loadRequestRef.current;
    const { key: queryKey, options } = currentPageRef.current;
    setError("");
    try {
      // Navigation only changes the list; shared metadata is refreshed on load
      // and after mutations/tab notifications, rather than on every filter.
      const page = await fetchCloudScenePage(options);
      if (
        loadRequestRef.current !== requestId ||
        currentPageRef.current.key !== queryKey
      ) {
        return;
      }
      if (options.trash) {
        setTrashScenes(page.items);
        setTrashSceneCursor(page.nextCursor);
      } else {
        setScenes(page.items);
        setSceneCursor(page.nextCursor);
      }
      setPageTotalCount(page.totalCount);
      loadedPageQueryKeyRef.current = queryKey;
      setDisplayedPageOptions(options);
    } catch (requestError: any) {
      if (
        loadRequestRef.current !== requestId ||
        currentPageRef.current.key !== queryKey
      ) {
        return;
      }
      if (
        requestError?.status === 401 ||
        requestError?.code === "AUTH_REQUIRED"
      ) {
        setAuthOpen(true);
      } else {
        setError(requestError?.message || "加载画板列表失败");
      }
    } finally {
      if (loadRequestRef.current === requestId) {
        setLoading(false);
      }
    }
  }, []);

  const loadMoreScenes = useCallback(async () => {
    const isTrash = view === "trash";
    const cursor = isTrash ? trashSceneCursor : sceneCursor;
    if (
      !cursor ||
      loadingMore ||
      loadedPageQueryKeyRef.current !== pageQueryKey
    ) {
      return;
    }
    const queryKey = pageQueryKey;
    const requestId = ++loadMoreRequestRef.current;
    const pageRequestId = ++pageRequestRef.current;
    setLoadingMore(true);
    try {
      const page = await fetchCloudScenePage(getCurrentPageOptions(cursor));
      if (
        requestId !== loadMoreRequestRef.current ||
        pageRequestId !== pageRequestRef.current ||
        queryKey !== pageQueryKeyRef.current
      ) {
        return;
      }
      const mergeScenes = (current: CloudSceneSummary[]) => {
        const existingIds = new Set(current.map((scene) => scene.id));
        return [
          ...current,
          ...page.items.filter((scene) => !existingIds.has(scene.id)),
        ];
      };
      if (isTrash) {
        setTrashScenes(mergeScenes);
        setTrashSceneCursor(page.nextCursor);
      } else {
        setScenes(mergeScenes);
        setSceneCursor(page.nextCursor);
      }
      setPageTotalCount(page.totalCount);
    } catch (requestError: any) {
      if (
        requestId === loadMoreRequestRef.current &&
        pageRequestId === pageRequestRef.current &&
        queryKey === pageQueryKeyRef.current
      ) {
        handleRequestError(requestError, "加载更多画板失败");
      }
    } finally {
      if (requestId === loadMoreRequestRef.current) {
        setLoadingMore(false);
      }
    }
  }, [
    getCurrentPageOptions,
    handleRequestError,
    loadingMore,
    pageQueryKey,
    sceneCursor,
    trashSceneCursor,
    view,
  ]);

  useEffect(() => {
    void loadWorkspace();
    return () => {
      loadRequestRef.current += 1;
      pageRequestRef.current += 1;
      loadMoreRequestRef.current += 1;
    };
  }, [loadWorkspace]);

  useEffect(() => {
    if (previousPageQueryKeyRef.current === pageQueryKey) {
      return;
    }
    previousPageQueryKeyRef.current = pageQueryKey;
    const searchChanged = previousSearchQueryRef.current !== searchQuery.trim();
    previousSearchQueryRef.current = searchQuery.trim();
    // Invalidate old requests immediately, before the debounce starts.
    loadRequestRef.current += 1;
    pageRequestRef.current += 1;
    loadMoreRequestRef.current += 1;
    setLoadingMore(false);
    const reload = () => {
      if (workspaceLoadedRef.current) {
        void reloadCurrentPage();
      } else {
        void loadWorkspace();
      }
    };
    if (!searchChanged) {
      reload();
      return;
    }
    const timer = setTimeout(reload, 180);
    return () => clearTimeout(timer);
  }, [pageQueryKey, searchQuery, reloadCurrentPage, loadWorkspace]);

  useEffect(() => {
    if (workspaceSnapshot && workspaceStats) {
      workspaceSnapshot = {
        scenes,
        folders,
        trashScenes,
        stats: workspaceStats,
        pageQueryKey: loadedPageQueryKeyRef.current,
        pageTotalCount,
      };
    }
  }, [folders, loading, scenes, trashScenes, workspaceStats, pageTotalCount]);

  useEffect(
    () => subscribeCloudTabSync(() => void loadWorkspace()),
    [loadWorkspace],
  );

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeCloudRealtime(null, (event) => {
      if (
        event.type !== "scene_changed" &&
        event.type !== "workspace_changed"
      ) {
        return;
      }
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void loadWorkspace();
      }, 250);
    });
    return () => {
      unsubscribe();
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
    };
  }, [loadWorkspace]);

  useEffect(() => {
    const ownerWindow = getOwnerWindow(rootRef.current);
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      const isCommandPaletteShortcut =
        event.key === "/" &&
        (isDarwin
          ? event.metaKey && !event.ctrlKey && !event.altKey
          : event.altKey && !event.ctrlKey && !event.metaKey);
      if (isCommandPaletteShortcut) {
        event.preventDefault();
        event.stopPropagation();
        setCommandPaletteOpen((prev) => !prev);
        return;
      }

      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    ownerWindow.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      ownerWindow.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, []);

  const folderSceneCounts = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder.scene_count])),
    [folders],
  );

  const updateWorkspaceNavOverflow = useCallback(() => {
    const nav = workspaceNavRef.current;
    if (!nav) {
      return;
    }
    const next = {
      left: nav.scrollLeft > 1,
      right: nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1,
    };
    setWorkspaceNavOverflow((current) =>
      current.left === next.left && current.right === next.right
        ? current
        : next,
    );
  }, []);

  useLayoutEffect(() => {
    const nav = workspaceNavRef.current;
    if (!nav) {
      return;
    }
    updateWorkspaceNavOverflow();
    const observer = new ResizeObserver(updateWorkspaceNavOverflow);
    observer.observe(nav);
    nav
      .querySelectorAll("button")
      .forEach((button) => observer.observe(button));
    nav.addEventListener("scroll", updateWorkspaceNavOverflow, {
      passive: true,
    });
    const ownerWindow = nav.ownerDocument.defaultView;
    ownerWindow?.addEventListener("resize", updateWorkspaceNavOverflow);
    return () => {
      observer.disconnect();
      nav.removeEventListener("scroll", updateWorkspaceNavOverflow);
      ownerWindow?.removeEventListener("resize", updateWorkspaceNavOverflow);
    };
  }, [updateWorkspaceNavOverflow, workspaceStats]);

  const filteredScenes = useMemo(() => {
    const options = displayedPageOptions;
    const targetScenes = options.trash ? trashScenes : scenes;
    const normalizedQuery = (options.query || "").toLocaleLowerCase();
    const filtered = targetScenes.filter((scene) => {
      if (options.opened && !scene.last_opened_at) {
        return false;
      }
      if (options.favorite && !scene.favorite) {
        return false;
      }
      if (
        !options.trash &&
        options.folderId &&
        scene.folder_id !== options.folderId
      ) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      const searchable = [scene.name, scene.folder_name || "", ...scene.tags]
        .join(" ")
        .toLocaleLowerCase();
      return searchable.includes(normalizedQuery);
    });
    return sortScenes(filtered, options.sort || "updated");
  }, [scenes, trashScenes, displayedPageOptions]);

  const selectedScenes = useMemo(
    () => filteredScenes.filter((scene) => selectedSceneIds.has(scene.id)),
    [filteredScenes, selectedSceneIds],
  );

  const handleToggleSceneSelection = useCallback(
    (id: string, modifiers: Omit<BoardSelectionClick, "id"> = {}) => {
      const next = applyBoardSelectionClick(
        sceneSelectionRef.current,
        filteredScenes.map((scene) => scene.id),
        { ...modifiers, id },
      );
      updateSceneSelection(next);
    },
    [filteredScenes, updateSceneSelection],
  );

  useEffect(() => {
    const current = sceneSelectionRef.current;
    const next = pruneBoardSelection(
      current,
      filteredScenes.map((scene) => scene.id),
    );
    if (
      current.anchorId !== next.anchorId ||
      current.ids.size !== next.ids.size ||
      [...current.ids].some((id) => !next.ids.has(id))
    ) {
      updateSceneSelection(next);
    }
  }, [filteredScenes, updateSceneSelection]);

  const updateBoardGridMetrics = useCallback(() => {
    const root = rootRef.current;
    const grid = boardGridRef.current;
    const ownerWindow = root?.ownerDocument.defaultView;
    if (!root || !grid || !ownerWindow) {
      return;
    }

    const style = ownerWindow.getComputedStyle(grid);
    const rowGap = Number.parseFloat(style.rowGap) || 0;
    const rootRect = root.getBoundingClientRect();
    const gridRect = grid.getBoundingClientRect();
    const scrollMargin = Math.max(
      0,
      gridRect.top - rootRect.top - root.clientTop + root.scrollTop,
    );

    const templateColumns = style.gridTemplateColumns
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const columns = Math.max(
      1,
      templateColumns.length ||
        (gridRect.width <= 640 ? 1 : BOARD_GRID_COLUMNS),
    );

    setBoardGridMetrics((current) => {
      if (
        Math.abs(current.rowGap - rowGap) < 0.1 &&
        Math.abs(current.scrollMargin - scrollMargin) < 0.5 &&
        current.columns === columns
      ) {
        return current;
      }
      return { rowGap, scrollMargin, columns };
    });
  }, []);

  const hasMoreScenes = Boolean(
    !pageTransitionPending &&
    (view === "trash" ? trashSceneCursor : sceneCursor),
  );

  const shouldVirtualizeBoardGrid =
    filteredScenes.length > BOARD_GRID_VIRTUALIZATION_THRESHOLD;
  const boardGridColumns = boardGridMetrics.columns;
  const boardGridRowCount = Math.ceil(filteredScenes.length / boardGridColumns);
  const getBoardGridRowKey = useCallback(
    (index: number) =>
      `${boardGridColumns}:${filteredScenes[index * boardGridColumns]?.id || index}`,
    [boardGridColumns, filteredScenes],
  );
  const boardGridVirtualizer = useVirtualizer({
    count: shouldVirtualizeBoardGrid ? boardGridRowCount : 0,
    getScrollElement: () => rootRef.current,
    estimateSize: () => BOARD_GRID_ESTIMATED_ROW_HEIGHT,
    getItemKey: getBoardGridRowKey,
    overscan: BOARD_GRID_VIRTUAL_OVERSCAN_ROWS,
    gap: boardGridMetrics.rowGap,
    scrollMargin: boardGridMetrics.scrollMargin,
  });

  const handleBoardGridKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!shouldVirtualizeBoardGrid || event.key !== "Tab") {
        return;
      }

      const grid = boardGridRef.current;
      const activeElement = grid?.ownerDocument.activeElement;
      const activeRow =
        activeElement instanceof HTMLElement
          ? activeElement.closest<HTMLElement>(".board-grid-virtual-row")
          : null;
      if (!grid || !activeRow) {
        return;
      }

      const focusableElements = getBoardGridFocusableElements(activeRow);
      const activeIndex = focusableElements.indexOf(
        activeElement as HTMLElement,
      );
      const direction: 1 | -1 = event.shiftKey ? -1 : 1;
      const atRowBoundary =
        direction === 1
          ? activeIndex === focusableElements.length - 1
          : activeIndex === 0;
      const rowIndex = Number(activeRow.dataset.index);
      const targetRowIndex = rowIndex + direction;

      if (
        activeIndex < 0 ||
        !atRowBoundary ||
        targetRowIndex < 0 ||
        targetRowIndex >= boardGridRowCount
      ) {
        return;
      }

      event.preventDefault();
      pendingBoardGridFocusRef.current = {
        rowIndex: targetRowIndex,
        direction,
      };

      const focusTargetRow = () => {
        const targetRow = grid.querySelector<HTMLElement>(
          `[data-index="${targetRowIndex}"]`,
        );
        if (!targetRow) {
          return false;
        }
        const targetElements = getBoardGridFocusableElements(targetRow);
        const targetElement =
          direction === 1 ? targetElements[0] : targetElements.at(-1);
        if (!targetElement) {
          return false;
        }
        pendingBoardGridFocusRef.current = null;
        targetElement.focus();
        return true;
      };

      if (!focusTargetRow()) {
        boardGridVirtualizer.scrollToIndex(targetRowIndex, { align: "auto" });
      }
    },
    [boardGridRowCount, boardGridVirtualizer, shouldVirtualizeBoardGrid],
  );

  useLayoutEffect(() => {
    const root = rootRef.current;
    const grid = boardGridRef.current;
    if (!root || !grid) {
      return;
    }

    updateBoardGridMetrics();
    const resizeObserver = new ResizeObserver(updateBoardGridMetrics);
    resizeObserver.observe(root);
    resizeObserver.observe(grid);
    const ownerWindow = root.ownerDocument.defaultView;
    ownerWindow?.addEventListener("resize", updateBoardGridMetrics, {
      passive: true,
    });

    return () => {
      resizeObserver.disconnect();
      ownerWindow?.removeEventListener("resize", updateBoardGridMetrics);
    };
  }, [
    error,
    filteredScenes.length,
    loading,
    pageQueryKey,
    searchQuery,
    selectedFolderId,
    sort,
    shouldVirtualizeBoardGrid,
    updateBoardGridMetrics,
    view,
  ]);

  useLayoutEffect(() => {
    const pendingFocus = pendingBoardGridFocusRef.current;
    if (!pendingFocus || !shouldVirtualizeBoardGrid) {
      return;
    }

    const grid = boardGridRef.current;
    const targetRow = grid?.querySelector<HTMLElement>(
      `[data-index="${pendingFocus.rowIndex}"]`,
    );
    if (!targetRow) {
      return;
    }

    const focusableElements = getBoardGridFocusableElements(targetRow);
    const targetElement =
      pendingFocus.direction === 1
        ? focusableElements[0]
        : focusableElements.at(-1);
    if (targetElement) {
      pendingBoardGridFocusRef.current = null;
      targetElement.focus();
    }
  });

  const navigateToScene = (scene: CloudSceneSummary, newTab = false) => {
    const ownerWindow = getOwnerWindow(rootRef.current);
    const url = new URL(ownerWindow.location.href);
    url.search = `?id=${encodeURIComponent(scene.id)}`;
    url.hash = "";

    if (newTab) {
      ownerWindow.open(
        `${url.pathname}${url.search}`,
        "_blank",
        "noopener,noreferrer",
      );
      return;
    }

    if (onSelectScene) {
      onSelectScene(scene.id);
      return;
    }
    ownerWindow.location.assign(`${url.pathname}${url.search}`);
  };

  const notifyWorkspaceChanged = () => {
    broadcastWorkspaceChanged();
    void loadWorkspace();
  };

  const handleCreateScene = async (
    targetFolderId?: string | null,
    sceneName?: string,
  ) => {
    if (pendingAction) {
      return;
    }
    const folderId =
      targetFolderId !== undefined ? targetFolderId : selectedFolderId;
    setPendingAction("create-scene");
    setError("");
    try {
      const scene = await createCloudScene({
        name: sceneName?.trim() || "未命名白板",
        folder_id: folderId,
        appState: { viewBackgroundColor: "#fbfaf7" },
      });
      notifyWorkspaceChanged();
      navigateToScene(scene);
    } catch (requestError: any) {
      handleRequestError(requestError, "创建画板失败");
    } finally {
      setPendingAction(null);
    }
  };

  const handleToggleFavorite = async (scene: CloudSceneSummary) => {
    if (pendingAction) {
      return;
    }
    const nextFavorite = !scene.favorite;
    setScenes((current) =>
      current.map((item) =>
        item.id === scene.id ? { ...item, favorite: nextFavorite } : item,
      ),
    );
    setPendingAction(`favorite:${scene.id}`);
    try {
      const updated = await updateCloudSceneMetadata(scene.id, {
        favorite: nextFavorite,
        baseRevision: scene.revision,
      });
      setScenes((current) =>
        current.map((item) => (item.id === scene.id ? updated : item)),
      );
      notifyWorkspaceChanged();
    } catch (requestError: any) {
      setScenes((current) =>
        current.map((item) =>
          item.id === scene.id ? { ...item, favorite: scene.favorite } : item,
        ),
      );
      handleRequestError(requestError, "更新收藏状态失败");
    } finally {
      setPendingAction(null);
    }
  };

  const handleSaveMetadata = async () => {
    if (!metadataDialog || pendingAction) {
      return;
    }
    const tags = metadataDialog.tags
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter(Boolean)
      .filter((tag, index, list) => list.indexOf(tag) === index);
    setPendingAction(`metadata:${metadataDialog.scene.id}`);
    setError("");
    try {
      const updated = await updateCloudSceneMetadata(metadataDialog.scene.id, {
        name: metadataDialog.title.trim() || "未命名白板",
        tags,
        folder_id: metadataDialog.folderId || null,
        baseRevision: metadataDialog.scene.revision,
      });
      setScenes((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setMetadataDialog(null);
      notifyWorkspaceChanged();
    } catch (requestError: any) {
      handleRequestError(requestError, "保存画板信息失败");
    } finally {
      setPendingAction(null);
    }
  };

  const handleDeleteScene = async (scene: CloudSceneSummary) => {
    if (view === "trash") {
      setConfirmDialog({
        title: "彻底删除画板",
        message: `确定要彻底删除画板“${scene.name}”吗？该操作无法恢复。`,
        confirmLabel: "彻底删除",
        confirmVariant: "danger",
        onConfirm: async () => {
          setPendingAction(`delete:${scene.id}`);
          try {
            await deleteCloudScene(scene.id, true, scene.revision);
            setTrashScenes((current) =>
              current.filter((item) => item.id !== scene.id),
            );
            notifyWorkspaceChanged();
          } catch (requestError: any) {
            handleRequestError(requestError, "彻底删除画板失败");
          } finally {
            setPendingAction(null);
          }
        },
      });
      return;
    }

    setPendingAction(`delete:${scene.id}`);
    try {
      await deleteCloudScene(scene.id, false);
      setScenes((current) => current.filter((item) => item.id !== scene.id));
      setTrashScenes((current) => [
        { ...scene, deleted_at: Date.now() },
        ...current,
      ]);
      notifyWorkspaceChanged();
    } catch (requestError: any) {
      handleRequestError(requestError, "删除画板失败");
    } finally {
      setPendingAction(null);
    }
  };

  const handleEmptyTrash = () => {
    if (!workspaceStats?.trashCount || pendingAction) {
      return;
    }
    setConfirmDialog({
      title: "清空回收站",
      message: `确定要清空回收站中的所有画板（共 ${workspaceStats.trashCount} 个）吗？此操作将永久删除这些画板且无法恢复。`,
      confirmLabel: "清空回收站",
      confirmVariant: "danger",
      onConfirm: async () => {
        setPendingAction("clear-trash");
        try {
          await clearCloudTrash();
          setTrashScenes([]);
          notifyWorkspaceChanged();
        } catch (requestError: any) {
          handleRequestError(requestError, "清空回收站失败");
        } finally {
          setPendingAction(null);
        }
      },
    });
  };

  const handleRestoreScene = async (scene: CloudSceneSummary) => {
    setPendingAction(`restore:${scene.id}`);
    setError("");
    try {
      await restoreCloudScene(scene.id);
      setTrashScenes((current) =>
        current.filter((item) => item.id !== scene.id),
      );
      setScenes((current) => [{ ...scene, deleted_at: null }, ...current]);
      notifyWorkspaceChanged();
    } catch (requestError: any) {
      handleRequestError(requestError, "还原画板失败");
    } finally {
      setPendingAction(null);
    }
  };

  const reportSceneBatchFailures = (
    results: SceneBatchResult[],
    action: string,
  ) => {
    const completed = results.filter((result) => result.ok);
    const failed = results.filter((result) => !result.ok);
    if (!failed.length) {
      setError("");
      return completed.map((result) => result.scene);
    }
    const firstError = failed[0]?.error as { message?: string } | undefined;
    if (
      failed.some((result) => {
        const batchError = result.error as
          { status?: number; code?: string } | undefined;
        return (
          batchError?.status === 401 || batchError?.code === "AUTH_REQUIRED"
        );
      })
    ) {
      setAuthOpen(true);
      setError("");
      return completed.map((result) => result.scene);
    }
    setError(
      `${completed.length ? `已${action} ${completed.length} 个画板；` : ""}${
        failed.length
      } 个失败：${firstError?.message || "请刷新列表后重试。"}`,
    );
    return completed.map((result) => result.scene);
  };

  const handleBatchMoveToTrash = async (targets: CloudSceneSummary[]) => {
    if (!targets.length || pendingAction) {
      return;
    }
    setPendingAction("batch-trash");
    setError("");
    try {
      const results = await runCloudSceneBatch(targets, trashCloudScenes);
      const completed = reportSceneBatchFailures(results, "移入回收站");
      if (!completed.length) {
        return;
      }
      const completedIds = new Set(completed.map((scene) => scene.id));
      const deletedAt = Date.now();
      setScenes((current) =>
        current.filter((scene) => !completedIds.has(scene.id)),
      );
      setTrashScenes((current) => [
        ...completed.map((scene) => ({ ...scene, deleted_at: deletedAt })),
        ...current.filter((scene) => !completedIds.has(scene.id)),
      ]);
      removeSceneIdsFromSelection([...completedIds]);
      notifyWorkspaceChanged();
    } finally {
      setPendingAction(null);
    }
  };

  const handleBatchRestore = async (targets: CloudSceneSummary[]) => {
    if (!targets.length || pendingAction) {
      return;
    }
    setPendingAction("batch-restore");
    setError("");
    try {
      const results = await runCloudSceneBatch(targets, restoreCloudScenes);
      const completed = reportSceneBatchFailures(results, "还原");
      if (!completed.length) {
        return;
      }
      const completedIds = new Set(completed.map((scene) => scene.id));
      setTrashScenes((current) =>
        current.filter((scene) => !completedIds.has(scene.id)),
      );
      setScenes((current) => [
        ...completed.map((scene) => ({ ...scene, deleted_at: null })),
        ...current.filter((scene) => !completedIds.has(scene.id)),
      ]);
      removeSceneIdsFromSelection([...completedIds]);
      notifyWorkspaceChanged();
    } finally {
      setPendingAction(null);
    }
  };

  const handleBatchPermanentDelete = (targets: CloudSceneSummary[]) => {
    if (!targets.length || pendingAction) {
      return;
    }
    setConfirmDialog({
      title: "彻底删除所选画板",
      message: `确定要彻底删除所选 ${targets.length} 个画板吗？该操作无法恢复。`,
      confirmLabel: "彻底删除",
      confirmVariant: "danger",
      onConfirm: async () => {
        setPendingAction("batch-permanent-delete");
        setError("");
        try {
          const results = await runCloudSceneBatch(
            targets,
            permanentlyDeleteCloudScenes,
          );
          const completed = reportSceneBatchFailures(results, "彻底删除");
          if (!completed.length) {
            return;
          }
          const completedIds = new Set(completed.map((scene) => scene.id));
          setTrashScenes((current) =>
            current.filter((scene) => !completedIds.has(scene.id)),
          );
          removeSceneIdsFromSelection([...completedIds]);
          notifyWorkspaceChanged();
        } finally {
          setPendingAction(null);
        }
      },
    });
  };

  const handleSaveFolder = async () => {
    if (!folderDialog || pendingAction || !folderDialog.name.trim()) {
      return;
    }
    setPendingAction(`folder:${folderDialog.id || "new"}`);
    try {
      if (folderDialog.id) {
        const updated = await renameCloudFolder(
          folderDialog.id,
          folderDialog.name.trim(),
          { icon: folderDialog.icon, color: folderDialog.color },
        );
        setFolders((current) =>
          current.map((folder) =>
            folder.id === updated.id ? { ...folder, ...updated } : folder,
          ),
        );
        setScenes((current) =>
          current.map((scene) =>
            scene.folder_id === updated.id
              ? { ...scene, folder_name: updated.name }
              : scene,
          ),
        );
        notifyWorkspaceChanged();
      } else {
        const created = await createCloudFolder(folderDialog.name.trim(), {
          icon: folderDialog.icon,
          color: folderDialog.color,
        });
        setFolders((current) => [...current, created]);
        notifyWorkspaceChanged();
      }
      setFolderDialog(null);
    } catch (requestError: any) {
      handleRequestError(requestError, "保存文件夹失败");
    } finally {
      setPendingAction(null);
    }
  };

  const handleDeleteFolder = (folder: CloudFolder) => {
    setConfirmDialog({
      title: "删除文件夹",
      message: `确定要删除文件夹“${folder.name}”吗？其中的画板会被移动到根目录。`,
      confirmLabel: "删除文件夹",
      confirmVariant: "danger",
      onConfirm: async () => {
        setPendingAction(`delete-folder:${folder.id}`);
        try {
          await deleteCloudFolder(folder.id);
          setFolders((current) =>
            current.filter((item) => item.id !== folder.id),
          );
          setScenes((current) =>
            current.map((scene) =>
              scene.folder_id === folder.id
                ? { ...scene, folder_id: null, folder_name: null }
                : scene,
            ),
          );
          notifyWorkspaceChanged();
          if (selectedFolderId === folder.id) {
            setSelectedFolderId(null);
          }
        } catch (requestError: any) {
          handleRequestError(requestError, "删除文件夹失败");
        } finally {
          setPendingAction(null);
        }
      },
    });
  };

  const openMetadataDialog = (scene: CloudSceneSummary) => {
    setMetadataDialog({
      scene,
      title: scene.name,
      tags: scene.tags.join(", "),
      folderId: scene.folder_id || "",
    });
  };

  const openFolderDialog = (folder?: CloudFolder) => {
    setFolderDialog({
      id: folder?.id || null,
      name: folder?.name || "",
      icon: folder?.icon || DEFAULT_FOLDER_APPEARANCE.icon,
      color: folder?.color || DEFAULT_FOLDER_APPEARANCE.color,
    });
  };

  const openFolderContextMenu = (
    folder: CloudFolder,
    event: React.MouseEvent<HTMLElement>,
  ) => {
    showContextMenu(event, [
      {
        label: "打开文件夹",
        icon: "open",
        onSelect: () => {
          setSelectedFolderId(folder.id);
          setView("all");
        },
      },
      {
        label: "在此文件夹中新建画板",
        icon: "plus",
        disabled: !!pendingAction,
        onSelect: () => void handleCreateScene(folder.id),
      },
      {
        label: "重命名与自定义外观",
        icon: "settings",
        separatorBefore: true,
        onSelect: () => openFolderDialog(folder),
      },
      {
        label: "删除文件夹",
        icon: "trash",
        danger: true,
        separatorBefore: true,
        disabled: !!pendingAction,
        onSelect: () => handleDeleteFolder(folder),
      },
    ]);
  };

  const openBoardContextMenu = (
    scene: CloudSceneSummary,
    event: React.MouseEvent<HTMLElement>,
  ) => {
    const isSelected = selectedSceneIds.has(scene.id);
    const selectedCount = selectedScenes.length;
    const items: WorkspaceContextMenuItem[] = [];
    if (view !== "trash") {
      items.push({
        label: "打开画板",
        icon: "open",
        onSelect: () => {
          clearSceneSelection();
          navigateToScene(scene);
        },
      });
    }
    items.push({
      label: isSelected ? "从多选中移除" : "加入多选",
      icon: isSelected ? "check" : "plus",
      disabled: !!pendingAction,
      onSelect: () => handleToggleSceneSelection(scene.id, { ctrlKey: true }),
    });
    if (selectedCount) {
      items.push({
        label: "退出多选",
        icon: "close",
        separatorBefore: true,
        onSelect: clearSceneSelection,
      });
    }

    if (view === "trash") {
      items.push({
        label: "还原画板",
        icon: "restore",
        separatorBefore: selectedCount === 0,
        disabled: !!pendingAction,
        onSelect: () => void handleRestoreScene(scene),
      });
      if (isSelected && selectedCount > 1) {
        items.push({
          label: `恢复所选 ${selectedCount} 个画板`,
          icon: "restore",
          disabled: !!pendingAction,
          onSelect: () => void handleBatchRestore(selectedScenes),
        });
      }
      items.push({
        label: "彻底删除",
        icon: "trash",
        danger: true,
        separatorBefore: true,
        disabled: !!pendingAction,
        onSelect: () => handleDeleteScene(scene),
      });
      if (isSelected && selectedCount > 1) {
        items.push({
          label: `彻底删除所选 ${selectedCount} 个画板`,
          icon: "trash",
          danger: true,
          disabled: !!pendingAction,
          onSelect: () => handleBatchPermanentDelete(selectedScenes),
        });
      }
    } else {
      items.push({
        label: scene.favorite ? "取消收藏" : "收藏画板",
        icon: "star",
        separatorBefore: selectedCount === 0,
        disabled: !!pendingAction,
        onSelect: () => void handleToggleFavorite(scene),
      });
      items.push({
        label: "编辑画板信息",
        icon: "edit",
        separatorBefore: true,
        disabled: !!pendingAction,
        onSelect: () => openMetadataDialog(scene),
      });
      items.push({
        label: "移至回收站",
        icon: "trash",
        danger: true,
        separatorBefore: true,
        disabled: !!pendingAction,
        onSelect: () => handleDeleteScene(scene),
      });
      if (isSelected && selectedCount > 1) {
        items.push({
          label: `移入回收站所选 ${selectedCount} 个画板`,
          icon: "trash",
          danger: true,
          disabled: !!pendingAction,
          onSelect: () => void handleBatchMoveToTrash(selectedScenes),
        });
      }
    }
    showContextMenu(event, items);
  };

  const openBackgroundContextMenu = (
    event: React.MouseEvent<HTMLDivElement>,
  ) => {
    const target = event.target;
    event.preventDefault();
    if (pageTransitionPending) {
      return;
    }
    if (!(target instanceof Element)) {
      return;
    }

    const input = target.closest<HTMLInputElement | HTMLTextAreaElement>(
      "input, textarea",
    );
    if (input) {
      const items: WorkspaceContextMenuItem[] = [
        {
          label: "全选文本",
          icon: "check",
          disabled:
            input.disabled ||
            (!["text", "search", "url", "tel", "password", "email"].includes(
              input.type,
            ) &&
              input.tagName !== "TEXTAREA"),
          onSelect: () => {
            input.focus();
            input.select();
          },
        },
      ];
      if (input === searchInputRef.current) {
        items.push({
          label: "清空搜索",
          icon: "close",
          disabled: !searchQuery,
          onSelect: () => {
            setSearchQuery("");
            input.focus();
          },
        });
      }
      showContextMenu(event, items);
      return;
    }

    // Keep portaled dialogs and the command palette in their own context.
    if (!event.currentTarget.contains(target)) {
      const dialog = target.closest('dialog, [role="dialog"]');
      showContextMenu(event, [
        {
          label: "返回当前窗口",
          icon: "open",
          onSelect: () =>
            dialog
              ?.querySelector<HTMLElement>(
                'input, button:not(:disabled), [tabindex="0"]',
              )
              ?.focus(),
        },
      ]);
      return;
    }

    const navigation = target.closest<HTMLElement>("[data-workspace-view]");
    if (navigation) {
      const nextView = navigation.dataset.workspaceView as BoardView;
      const labels = {
        all: "所有画板",
        recent: "最近打开",
        favorites: "收藏",
        trash: "回收站",
      };
      const items: WorkspaceContextMenuItem[] = [
        {
          label: `打开${labels[nextView]}`,
          icon:
            nextView === "favorites"
              ? "star"
              : nextView === "trash"
                ? "trash"
                : "open",
          onSelect: () => {
            setView(nextView);
            setSelectedFolderId(null);
          },
        },
        {
          label: "命令菜单",
          icon: "commands",
          onSelect: () => setCommandPaletteOpen(true),
        },
      ];
      if (nextView === "trash") {
        items.push({
          label: "清空回收站",
          icon: "trash",
          separatorBefore: true,
          danger: true,
          disabled: !workspaceStats?.trashCount || !!pendingAction,
          onSelect: handleEmptyTrash,
        });
      } else {
        items.push({
          label: "新建画板",
          icon: "plus",
          separatorBefore: true,
          disabled: !!pendingAction,
          onSelect: () => void handleCreateScene(null),
        });
      }
      showContextMenu(event, items);
      return;
    }

    const clickedControl = target.closest<HTMLButtonElement>("button");
    // Dropdown options can unmount when the context menu is clicked; reopen via
    // their persistent trigger instead of invoking a detached option button.
    const control =
      clickedControl
        ?.closest(".custom-select")
        ?.querySelector<HTMLButtonElement>(".custom-select__trigger") ||
      clickedControl;
    if (control) {
      const label =
        control.getAttribute("aria-label") ||
        control.textContent?.trim() ||
        control.title ||
        "打开选项";
      showContextMenu(event, [
        {
          label,
          icon: control.classList.contains("empty-trash-button")
            ? "trash"
            : "open",
          danger: control.classList.contains("empty-trash-button"),
          disabled: control.disabled,
          onSelect: () => control.click(),
        },
        {
          label: "命令菜单",
          icon: "commands",
          separatorBefore: true,
          onSelect: () => setCommandPaletteOpen(true),
        },
      ]);
      return;
    }

    const inSidebar = !!target.closest(".workspace-sidebar");
    const inTrash = view === "trash" && !inSidebar;
    const items: WorkspaceContextMenuItem[] = [];
    if (!inTrash) {
      items.push(
        {
          label:
            !inSidebar && selectedFolderId
              ? "在此文件夹中新建画板"
              : "新建画板",
          icon: "plus",
          disabled: !!pendingAction,
          onSelect: () =>
            void handleCreateScene(inSidebar ? null : selectedFolderId),
        },
        {
          label: "新建文件夹",
          icon: "folder",
          disabled: !!pendingAction,
          onSelect: () => openFolderDialog(),
        },
      );
    }
    items.push(
      {
        label: "搜索画板",
        icon: "search",
        separatorBefore: items.length > 0,
        onSelect: () => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        },
      },
      {
        label: "命令菜单",
        icon: "commands",
        onSelect: () => setCommandPaletteOpen(true),
      },
      {
        label: inTrash ? "刷新回收站" : "刷新画板列表",
        icon: "refresh",
        disabled: loading || !!pendingAction,
        onSelect: () => void loadWorkspace(),
      },
    );
    if (searchQuery || selectedFolderId) {
      items.push({
        label: "清除筛选",
        icon: "close",
        onSelect: () => {
          setSearchQuery("");
          setSelectedFolderId(null);
        },
      });
    }
    if (selectedSceneIds.size) {
      items.push({
        label: "退出多选",
        icon: "check",
        onSelect: clearSceneSelection,
      });
    }
    if (inTrash) {
      items.push(
        {
          label: "返回所有画板",
          icon: "open",
          separatorBefore: true,
          onSelect: () => {
            setView("all");
            setSelectedFolderId(null);
            setSearchQuery("");
          },
        },
        {
          label: "清空回收站",
          icon: "trash",
          danger: true,
          disabled: !workspaceStats?.trashCount || !!pendingAction,
          onSelect: handleEmptyTrash,
        },
      );
    }
    showContextMenu(event, items);
  };

  const renderBoardCard = (scene: CloudSceneSummary) => (
    <BoardCard
      key={scene.id}
      scene={scene}
      isTrash={!!displayedPageOptions.trash}
      onOpen={navigateToScene}
      onPreload={onPreloadScene}
      onToggleFavorite={handleToggleFavorite}
      onEdit={openMetadataDialog}
      onDelete={handleDeleteScene}
      onRestore={handleRestoreScene}
      onOpenContextMenu={openBoardContextMenu}
      onToggleSelection={handleToggleSceneSelection}
      hasSelectionActive={selectedSceneIds.size > 0}
      isSelected={selectedSceneIds.has(scene.id)}
      folderAppearance={
        scene.folder_id
          ? folders.find((folder) => folder.id === scene.folder_id) ||
            DEFAULT_FOLDER_APPEARANCE
          : DEFAULT_FOLDER_APPEARANCE
      }
      actionPending={!!pendingAction}
    />
  );

  return (
    <div
      className="workspace-home"
      ref={rootRef}
      onContextMenu={openBackgroundContextMenu}
      onKeyDownCapture={(event) => {
        if (
          event.key !== "Escape" ||
          !sceneSelectionRef.current.ids.size ||
          !(event.target instanceof Node) ||
          !event.currentTarget.contains(event.target)
        ) {
          return;
        }
        event.preventDefault();
        clearSceneSelection();
      }}
    >
      <div className="workspace-layout">
        <aside
          className="workspace-sidebar"
          onClick={(event) => event.stopPropagation()}
        >
          <header className="workspace-header">
            <a
              className="workspace-brand"
              href="/"
              aria-label="狐涂画板首页"
              onClick={(event) => {
                if (onSelectScene) {
                  event.preventDefault();
                  setView("all");
                  setSelectedFolderId(null);
                  setSearchQuery("");
                }
              }}
            >
              <ExcalidrawMark />
              <span>狐涂画板</span>
            </a>
            <div className="workspace-header-actions">
              <button
                className="primary-button header-create-button"
                type="button"
                onClick={() => void handleCreateScene()}
                disabled={!!pendingAction}
                title={
                  selectedFolderId
                    ? `在${
                        folders.find((folder) => folder.id === selectedFolderId)
                          ?.name || "当前文件夹"
                      }中新建画板`
                    : "在根目录中新建画板"
                }
              >
                <span aria-hidden="true">＋</span>
                新建画板
              </button>
              <label className="workspace-search">
                <SearchIcon />
                <input
                  ref={searchInputRef}
                  value={searchQuery}
                  placeholder="搜索画板"
                  aria-label="搜索画板"
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      searchInputRef.current?.blur();
                    }
                  }}
                />
                <kbd>Ctrl+K</kbd>
              </label>
            </div>
          </header>
          <div
            className={`workspace-nav-shell${
              workspaceNavOverflow.left ? " has-overflow-left" : ""
            }${workspaceNavOverflow.right ? " has-overflow-right" : ""}`}
          >
            <nav
              ref={workspaceNavRef}
              className="workspace-nav"
              aria-label="画板导航"
            >
              <button
                data-workspace-view="all"
                className={
                  view === "all" && !selectedFolderId ? "is-selected" : ""
                }
                onClick={() => {
                  setView("all");
                  setSelectedFolderId(null);
                }}
                type="button"
              >
                <GridIcon />
                所有画板
                <span>{workspaceStats?.sceneCount ?? "…"}</span>
              </button>
              <button
                data-workspace-view="recent"
                className={view === "recent" ? "is-selected" : ""}
                onClick={() => {
                  setView("recent");
                  setSelectedFolderId(null);
                }}
                type="button"
              >
                <ClockIcon />
                最近打开
              </button>
              <button
                data-workspace-view="favorites"
                className={view === "favorites" ? "is-selected" : ""}
                onClick={() => {
                  setView("favorites");
                  setSelectedFolderId(null);
                }}
                type="button"
              >
                <StarIcon />
                收藏
                <span>{workspaceStats?.favoriteCount ?? "…"}</span>
              </button>
              <button
                data-workspace-view="trash"
                className={view === "trash" ? "is-selected" : ""}
                onClick={() => {
                  setView("trash");
                  setSelectedFolderId(null);
                }}
                type="button"
              >
                <TrashIcon />
                回收站
                {!!workspaceStats?.trashCount && (
                  <span>{workspaceStats.trashCount}</span>
                )}
              </button>
            </nav>
          </div>
          <div className="folder-heading">
            <span>文件夹</span>
            <button
              type="button"
              aria-label="新建文件夹"
              onClick={() => openFolderDialog()}
            >
              ＋
            </button>
          </div>
          <div className="folder-list">
            {folders.map((folder) => (
              <div
                className={`folder-row ${
                  selectedFolderId === folder.id && view !== "trash"
                    ? "is-selected"
                    : ""
                }`.trim()}
                key={folder.id}
                style={
                  {
                    "--folder-accent":
                      folder.color || DEFAULT_FOLDER_APPEARANCE.color,
                  } as React.CSSProperties
                }
                onContextMenu={(event) => openFolderContextMenu(folder, event)}
              >
                <button
                  type="button"
                  onClick={() => {
                    setSelectedFolderId(folder.id);
                    setView("all");
                  }}
                >
                  <span className="folder-row-icon" aria-hidden="true">
                    <FolderAppearanceIcon
                      icon={folder.icon || DEFAULT_FOLDER_APPEARANCE.icon}
                    />
                  </span>
                  <span>{folder.name}</span>
                  <small>{folderSceneCounts.get(folder.id) || 0}</small>
                </button>
              </div>
            ))}
          </div>
        </aside>

        <main
          className="workspace-main"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="workspace-main-heading">
            <div>
              <h1>{view === "trash" ? "回收站" : "我的画板"}</h1>
            </div>
            {view === "trash" && (
              <button
                type="button"
                className="empty-trash-button"
                disabled={!workspaceStats?.trashCount || !!pendingAction}
                onClick={handleEmptyTrash}
                aria-label="清空回收站"
                title="清空回收站"
              >
                <TrashIcon />
              </button>
            )}
          </div>

          {error && (
            <div className="workspace-error" role="alert">
              <span>{error}</span>
              <button
                type="button"
                className="workspace-error-retry"
                onClick={() => void loadWorkspace()}
              >
                重试
              </button>
            </div>
          )}

          <section className="all-boards-section">
            <div className="section-heading all-boards-heading">
              <div className="section-heading-title">
                <h2>
                  {view === "trash"
                    ? "已删除画板"
                    : selectedFolderId
                      ? folders.find((folder) => folder.id === selectedFolderId)
                          ?.name
                      : view === "favorites"
                        ? "收藏"
                        : view === "recent"
                          ? "最近打开"
                          : "所有画板"}
                </h2>
                <span>
                  {loadedPageQueryKeyRef.current === pageQueryKey
                    ? pageTotalCount
                    : "…"}
                </span>
              </div>
              <div className="section-tools">
                {folders.length > 0 && view !== "trash" && (
                  <CustomSelect
                    className="workspace-select-folder"
                    value={selectedFolderId || ""}
                    onChange={(folderId) =>
                      setSelectedFolderId(folderId || null)
                    }
                    ariaLabel="按文件夹筛选"
                    options={[
                      {
                        value: "",
                        label: `所有文件夹 (${workspaceStats?.sceneCount ?? "…"})`,
                      },
                      ...folders.map((folder) => ({
                        value: folder.id,
                        label: `${folder.name} (${folderSceneCounts.get(folder.id) || 0})`,
                      })),
                    ]}
                  />
                )}
                <CustomSelect
                  className="workspace-select-sort"
                  value={sort}
                  onChange={(nextSort) => setSort(nextSort as SortMode)}
                  ariaLabel="排序方式"
                  options={SORT_OPTIONS}
                />
              </div>
            </div>

            <div
              aria-busy={pageTransitionPending || loading}
              inert={pageTransitionPending && !loading}
            >
              {loading ? (
                <div className="workspace-empty-state loading-state">
                  正在加载画板...
                </div>
              ) : filteredScenes.length === 0 ? (
                <div className="workspace-empty-state">
                  <div className="empty-state-icon">
                    {displayedPageOptions.trash ? (
                      <EmptyTrashIcon />
                    ) : (
                      <ExcalidrawMark />
                    )}
                  </div>
                  <h3>
                    {displayedPageOptions.trash
                      ? "回收站为空"
                      : hasDisplayedFilters
                        ? "没有找到匹配的画板"
                        : "还没有画板"}
                  </h3>
                  <p>
                    {displayedPageOptions.trash
                      ? "删除的画板会暂存在这里，方便随时还原。"
                      : hasDisplayedFilters
                        ? "试试更换关键词或筛选条件。"
                        : "创建一个画板，把下一个想法画出来。"}
                  </p>
                  {!hasDisplayedFilters && !displayedPageOptions.trash && (
                    <button
                      className="primary-button"
                      type="button"
                      onClick={() => void handleCreateScene()}
                    >
                      新建第一个画板
                    </button>
                  )}
                </div>
              ) : shouldVirtualizeBoardGrid ? (
                <div
                  ref={boardGridRef}
                  className="board-grid board-grid-virtualized"
                  style={{ height: boardGridVirtualizer.getTotalSize() }}
                  onKeyDown={handleBoardGridKeyDown}
                >
                  {boardGridVirtualizer.getVirtualItems().map((virtualRow) => {
                    const startIndex = virtualRow.index * boardGridColumns;
                    return (
                      <div
                        key={virtualRow.key}
                        ref={boardGridVirtualizer.measureElement}
                        data-index={virtualRow.index}
                        className="board-grid-virtual-row"
                        style={
                          {
                            transform: `translateY(${virtualRow.start - boardGridMetrics.scrollMargin}px)`,
                            gridTemplateColumns: `repeat(${boardGridColumns}, minmax(0, 1fr))`,
                          } as React.CSSProperties
                        }
                      >
                        {filteredScenes
                          .slice(startIndex, startIndex + boardGridColumns)
                          .map(renderBoardCard)}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div ref={boardGridRef} className="board-grid">
                  {filteredScenes.map(renderBoardCard)}
                </div>
              )}
              {hasMoreScenes && (
                <div className="workspace-load-more">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void loadMoreScenes()}
                    disabled={loadingMore}
                  >
                    {loadingMore ? "加载中..." : "加载更多画板"}
                  </button>
                </div>
              )}
            </div>
          </section>
        </main>
      </div>

      {metadataDialog && (
        <MetadataDialog
          state={metadataDialog}
          folders={folders}
          pending={pendingAction === `metadata:${metadataDialog.scene.id}`}
          onChange={(next) =>
            setMetadataDialog((current) =>
              current ? { ...current, ...next } : current,
            )
          }
          onClose={() => setMetadataDialog(null)}
          onSave={() => void handleSaveMetadata()}
        />
      )}
      {folderDialog && (
        <FolderDialog
          state={folderDialog}
          pending={pendingAction === `folder:${folderDialog.id || "new"}`}
          onChange={(name) =>
            setFolderDialog((current) =>
              current ? { ...current, name } : current,
            )
          }
          onChangeAppearance={(next) =>
            setFolderDialog((current) =>
              current ? { ...current, ...next } : current,
            )
          }
          onClose={() => setFolderDialog(null)}
          onSave={() => void handleSaveFolder()}
          onDelete={() => {
            const folder = folders.find((item) => item.id === folderDialog.id);
            setFolderDialog(null);
            if (folder) {
              handleDeleteFolder(folder);
            }
          }}
        />
      )}
      {confirmDialog && (
        <ConfirmDialog
          state={confirmDialog}
          pending={!!pendingAction}
          onClose={() => setConfirmDialog(null)}
          onConfirm={() => {
            const action = confirmDialog.onConfirm;
            setConfirmDialog(null);
            void action();
          }}
        />
      )}
      <AuthDialog
        isOpen={authOpen}
        onSuccess={() => {
          setAuthOpen(false);
          void loadWorkspace();
        }}
        onClose={() => setAuthOpen(false)}
      />
      <WorkspaceCommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        scenes={scenes}
        folders={folders}
        trashCount={workspaceStats?.trashCount || 0}
        currentView={view}
        currentSort={sort}
        selectedFolderId={selectedFolderId}
        onSelectScene={navigateToScene}
        onCreateScene={handleCreateScene}
        onCreateFolder={() => openFolderDialog()}
        onChangeView={(nextView) => {
          setView(nextView);
          setSelectedFolderId(null);
        }}
        onSelectFolder={(folderId) => {
          setSelectedFolderId(folderId);
          setView("all");
        }}
        onChangeSort={setSort}
        onSearch={searchWorkspace}
        onEmptyTrash={handleEmptyTrash}
        onReload={loadWorkspace}
      />
      {contextMenu && (
        <WorkspaceContextMenu state={contextMenu} onClose={closeContextMenu} />
      )}
    </div>
  );
};
