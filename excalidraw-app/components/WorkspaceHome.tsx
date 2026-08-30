import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";

import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/element/types";

import {
  checkAuthStatus,
  clearCloudTrash,
  createCloudFolder,
  createCloudScene,
  deleteCloudFolder,
  deleteCloudScene,
  fetchCloudFolders,
  fetchCloudScenes,
  fetchCloudTrashScenes,
  renameCloudFolder,
  restoreCloudScene,
  saveFilesToCloud,
  updateCloudSceneMetadata,
  type CloudFolder,
  type CloudSceneSummary,
} from "../data/cloudStorage";
import { subscribeCloudTabSync } from "../data/cloudSync";
import { LocalData } from "../data/LocalData";
import { importFromLocalStorage } from "../data/localStorage";

import { AuthDialog } from "./AuthDialog";
import { WorkspaceDialog } from "./WorkspaceDialog";

import "./WorkspaceHome.scss";

type BoardView = "all" | "recent" | "favorites" | "trash";
type SortMode = "updated" | "opened" | "created";
type LayoutMode = "grid" | "list";

const LOCAL_SCENE_MIGRATION_KEY = "excalidraw-cloud-scene-migration-v1";

type SceneMetadataDialogState = {
  scene: CloudSceneSummary;
  title: string;
  tags: string;
  folderId: string;
};

type FolderDialogState = {
  id: string | null;
  name: string;
};

type ConfirmDialogState = {
  title: string;
  message: string;
  confirmLabel?: string;
  confirmVariant?: "danger" | "primary";
  onConfirm: () => Promise<void> | void;
};

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
  const time = date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
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
    return rightValue - leftValue;
  });

const migrateLocalScene = async (): Promise<CloudSceneSummary | null> => {
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
    for (const file of loadedFiles) {
      files[file.id] = file;
    }
    try {
      await saveFilesToCloud(files);
    } catch (error) {
      console.warn("迁移本地图片到云端失败，将在后续保存时重试", error);
    }
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

const MoreIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="5" cy="12" r="1.4" />
    <circle cx="12" cy="12" r="1.4" />
    <circle cx="19" cy="12" r="1.4" />
  </svg>
);

const TrashIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
  </svg>
);

const RestoreIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <polyline points="1 4 1 10 7 10" />
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
  </svg>
);

const ExcalidrawMark = () => (
  <div className="workspace-mark" aria-hidden="true">
    <svg viewBox="0 0 32 32">
      <path d="M4 7.5 10 2l8 8-6 5.5-8-8Z" />
      <path d="m22 2 6 5.5-16 16L6 18l16-16Z" />
      <path d="m18 20.5 6-5.5 4 4.5-6 5.5-4-4.5Z" />
    </svg>
  </div>
);

const EmptyThumbnail = () => (
  <div className="board-thumbnail board-thumbnail-empty">
    <div className="empty-thumbnail-mark">
      <span />
      <span />
      <span />
    </div>
    <span>空白画板</span>
  </div>
);

const BoardThumbnail = ({
  scene,
  eager = false,
}: {
  scene: CloudSceneSummary;
  eager?: boolean;
}) => {
  if (!scene.thumbnail_file_id) {
    return <EmptyThumbnail />;
  }
  return (
    <div className="board-thumbnail">
      <img
        src={`/api/files/${encodeURIComponent(scene.thumbnail_file_id)}?v=${
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

const BoardCard = ({
  scene,
  onOpen,
  onToggleFavorite,
  onEdit,
  onDelete,
  onRestore,
  isTrash = false,
  menuOpen,
  onMenuToggle,
  eager,
}: {
  scene: CloudSceneSummary;
  onOpen: (scene: CloudSceneSummary) => void;
  onToggleFavorite: (scene: CloudSceneSummary) => void;
  onEdit: (scene: CloudSceneSummary) => void;
  onDelete: (scene: CloudSceneSummary) => void;
  onRestore?: (scene: CloudSceneSummary) => void;
  isTrash?: boolean;
  menuOpen: boolean;
  onMenuToggle: () => void;
  eager?: boolean;
}) => {
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const sceneName = scene.name || "未命名白板";
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
    placement: "top" | "bottom";
  } | null>(null);

  const updateMenuPosition = useCallback(() => {
    const trigger = menuTriggerRef.current;
    const menu = menuRef.current;
    const ownerWindow = trigger?.ownerDocument.defaultView;
    if (!trigger || !menu || !ownerWindow) {
      return;
    }

    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const viewportPadding = 8;
    const menuWidth = menuRect.width || 160;
    const menuHeight = menuRect.height || 132;
    const canOpenBelow =
      triggerRect.bottom + menuHeight + viewportPadding <=
      ownerWindow.innerHeight;
    const top = canOpenBelow
      ? triggerRect.bottom + 2
      : Math.max(viewportPadding, triggerRect.top - menuHeight - 2);
    const left = Math.min(
      Math.max(viewportPadding, triggerRect.right - menuWidth),
      Math.max(
        viewportPadding,
        ownerWindow.innerWidth - menuWidth - viewportPadding,
      ),
    );

    setMenuPosition({
      top,
      left,
      placement: canOpenBelow ? "bottom" : "top",
    });
  }, []);

  useLayoutEffect(() => {
    if (!menuOpen) {
      return;
    }
    updateMenuPosition();
    const ownerWindow = menuTriggerRef.current?.ownerDocument.defaultView;
    if (!ownerWindow) {
      return;
    }
    const handleViewportChange = () => updateMenuPosition();
    ownerWindow.addEventListener("resize", handleViewportChange);
    ownerWindow.addEventListener("scroll", handleViewportChange, true);
    return () => {
      ownerWindow.removeEventListener("resize", handleViewportChange);
      ownerWindow.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [menuOpen, updateMenuPosition]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const ownerDocument = menuTriggerRef.current?.ownerDocument;
    if (!ownerDocument) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        (menuRef.current?.contains(target) ||
          menuTriggerRef.current?.contains(target))
      ) {
        return;
      }
      onMenuToggle();
    };
    ownerDocument.addEventListener("pointerdown", handlePointerDown);
    return () => {
      ownerDocument.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [menuOpen, onMenuToggle]);

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      ),
    );
    if (event.key === "Escape") {
      event.preventDefault();
      onMenuToggle();
      menuTriggerRef.current?.focus();
      return;
    }
    if (!items.length) {
      return;
    }
    const currentIndex = items.indexOf(
      event.target instanceof HTMLButtonElement ? event.target : items[0],
    );
    const nextIndex =
      event.key === "ArrowDown"
        ? (currentIndex + 1) % items.length
        : event.key === "ArrowUp"
        ? (currentIndex - 1 + items.length) % items.length
        : event.key === "Home"
        ? 0
        : event.key === "End"
        ? items.length - 1
        : -1;
    if (nextIndex >= 0) {
      event.preventDefault();
      items[nextIndex].focus();
    }
  };

  const ownerDocument = menuTriggerRef.current?.ownerDocument;
  const menu =
    menuOpen && ownerDocument
      ? createPortal(
          <div
            ref={menuRef}
            className="board-card-menu"
            role="menu"
            onKeyDown={handleMenuKeyDown}
            style={{
              top: menuPosition?.top ?? 0,
              left: menuPosition?.left ?? 0,
              visibility: menuPosition ? "visible" : "hidden",
              transformOrigin:
                menuPosition?.placement === "top"
                  ? "bottom right"
                  : "top right",
            }}
          >
            <button
              type="button"
              role="menuitem"
              autoFocus
              onClick={() => onEdit(scene)}
            >
              编辑信息
            </button>
            <button type="button" role="menuitem" onClick={() => onOpen(scene)}>
              打开画板
            </button>
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => onDelete(scene)}
            >
              移至回收站
            </button>
          </div>,
          ownerDocument.body,
        )
      : null;

  return (
    <article className={`board-card ${isTrash ? "is-trash-card" : ""}`}>
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
            onClick={() => onOpen(scene)}
            type="button"
            aria-label={`打开画板“${sceneName}”`}
          >
            <BoardThumbnail scene={scene} eager={eager} />
          </button>
          <button
            className="board-card-title"
            onClick={() => onOpen(scene)}
            type="button"
            aria-label={`打开画板“${sceneName}”`}
            title={sceneName}
          >
            {sceneName}
          </button>
        </div>
      )}
      <div className="board-card-footer">
        <div className="board-card-details" data-title={sceneName}>
          {isTrash ? (
            <span className="board-card-mobile-title" title={sceneName}>
              {sceneName}
            </span>
          ) : (
            <button
              type="button"
              className="board-card-mobile-title"
              onClick={() => onOpen(scene)}
              aria-label={`打开画板“${sceneName}”`}
              title={sceneName}
            >
              {sceneName}
            </button>
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
          {scene.folder_name && !isTrash && (
            <span
              className="board-card-folder"
              title={`所属文件夹：${scene.folder_name}`}
            >
              <FolderIcon />
              {scene.folder_name}
            </span>
          )}
          {scene.tags.length > 0 && !isTrash && (
            <div className="board-card-tags">
              {scene.tags.slice(0, 2).map((tag) => (
                <span key={tag} className="board-card-tag" title={tag}>
                  {tag}
                </span>
              ))}
              {scene.tags.length > 2 && (
                <span className="board-card-tag-more">
                  +{scene.tags.length - 2}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="board-card-actions">
          {isTrash ? (
            <>
              {onRestore && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="还原画板"
                  title="还原画板"
                  onClick={() => onRestore(scene)}
                >
                  <RestoreIcon />
                </button>
              )}
              <button
                type="button"
                className="icon-button danger"
                aria-label="彻底删除"
                title="彻底删除"
                onClick={() => onDelete(scene)}
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
                onClick={() => onToggleFavorite(scene)}
              >
                <StarIcon filled={scene.favorite} />
              </button>
              <div className="board-card-menu-wrap">
                <button
                  type="button"
                  className="icon-button"
                  ref={menuTriggerRef}
                  aria-label="更多画板操作"
                  aria-expanded={menuOpen}
                  onClick={onMenuToggle}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown" && !menuOpen) {
                      event.preventDefault();
                      onMenuToggle();
                    }
                  }}
                >
                  <MoreIcon />
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      {menu}
    </article>
  );
};

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
        <select
          value={state.folderId}
          onChange={(event) => onChange({ folderId: event.target.value })}
        >
          <option value="">根目录</option>
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </select>
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
}: {
  state: FolderDialogState;
  pending: boolean;
  onChange: (name: string) => void;
  onClose: () => void;
  onSave: () => void;
  onDelete?: () => void;
}) => (
  <WorkspaceModal
    title={state.id ? "重命名文件夹" : "新建文件夹"}
    onClose={onClose}
  >
    <form
      className="metadata-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <label>
        <span>文件夹名称</span>
        <input
          value={state.name}
          maxLength={80}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <div className="dialog-actions">
        {state.id && onDelete && (
          <button
            type="button"
            className="danger-button"
            onClick={onDelete}
            disabled={pending}
          >
            删除文件夹
          </button>
        )}
        <button
          type="button"
          className="secondary-button"
          onClick={onClose}
          disabled={pending}
        >
          取消
        </button>
        <button type="submit" className="primary-button" disabled={pending}>
          {pending ? "保存中..." : "保存"}
        </button>
      </div>
    </form>
  </WorkspaceModal>
);

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
}: {
  onSelectScene?: (sceneId: string) => void;
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [scenes, setScenes] = useState<CloudSceneSummary[]>([]);
  const [trashScenes, setTrashScenes] = useState<CloudSceneSummary[]>([]);
  const [folders, setFolders] = useState<CloudFolder[]>([]);
  const [view, setView] = useState<BoardView>("all");
  const [sort, setSort] = useState<SortMode>("updated");
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("grid");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [authOpen, setAuthOpen] = useState(false);
  const [menuSceneId, setMenuSceneId] = useState<string | null>(null);
  const [metadataDialog, setMetadataDialog] =
    useState<SceneMetadataDialogState | null>(null);
  const [folderDialog, setFolderDialog] = useState<FolderDialogState | null>(
    null,
  );
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(
    null,
  );
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const loadRequestRef = useRef(0);

  const loadWorkspace = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    const isCurrent = () => loadRequestRef.current === requestId;
    setLoading(true);
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
      const [sceneList, folderList, trashList] = await Promise.all([
        fetchCloudScenes(),
        fetchCloudFolders(),
        fetchCloudTrashScenes().catch(() => []),
      ]);
      if (!isCurrent()) {
        return;
      }
      let migratedScene: CloudSceneSummary | null = null;
      if (sceneList.length === 0 && trashList.length === 0) {
        try {
          migratedScene = await migrateLocalScene();
        } catch (migrationError) {
          console.warn("迁移本地画板失败", migrationError);
        }
      }
      setScenes(migratedScene ? [migratedScene] : sceneList);
      setFolders(folderList);
      setTrashScenes(trashList);
    } catch (requestError: any) {
      if (
        requestError?.status === 401 ||
        requestError?.code === "AUTH_REQUIRED"
      ) {
        setAuthOpen(true);
      } else {
        setError(requestError?.message || "加载画板首页失败");
      }
    } finally {
      if (!isCurrent()) {
        return;
      }
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspace();
    return () => {
      loadRequestRef.current += 1;
    };
  }, [loadWorkspace]);

  useEffect(
    () => subscribeCloudTabSync(() => void loadWorkspace()),
    [loadWorkspace],
  );

  useEffect(() => {
    const ownerWindow = getOwnerWindow(rootRef.current);
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
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

  const allTags = useMemo(
    () =>
      [...new Set(scenes.flatMap((scene) => scene.tags))].sort((a, b) =>
        a.localeCompare(b, "zh-CN"),
      ),
    [scenes],
  );

  const filteredScenes = useMemo(() => {
    const targetScenes = view === "trash" ? trashScenes : scenes;
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    const filtered = targetScenes.filter((scene) => {
      if (view === "recent" && !scene.last_opened_at) {
        return false;
      }
      if (view === "favorites" && !scene.favorite) {
        return false;
      }
      if (selectedFolderId && scene.folder_id !== selectedFolderId) {
        return false;
      }
      if (selectedTag && !scene.tags.includes(selectedTag)) {
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
    return sortScenes(filtered, view === "recent" ? "opened" : sort);
  }, [
    scenes,
    trashScenes,
    searchQuery,
    selectedFolderId,
    selectedTag,
    sort,
    view,
  ]);

  const recentScenes = useMemo(
    () =>
      sortScenes(
        scenes.filter((scene) => scene.last_opened_at),
        "opened",
      ).slice(0, 4),
    [scenes],
  );

  const navigateToScene = (scene: CloudSceneSummary) => {
    if (onSelectScene) {
      onSelectScene(scene.id);
      return;
    }
    const ownerWindow = getOwnerWindow(rootRef.current);
    const url = new URL(ownerWindow.location.href);
    url.search = `?id=${encodeURIComponent(scene.id)}`;
    url.hash = "";
    ownerWindow.location.assign(`${url.pathname}${url.search}`);
  };

  const handleCreateScene = async () => {
    if (pendingAction) {
      return;
    }
    setPendingAction("create-scene");
    setError("");
    try {
      const scene = await createCloudScene({
        name: "未命名白板",
        folder_id: selectedFolderId,
      });
      navigateToScene(scene);
    } catch (requestError: any) {
      if (requestError?.status === 401) {
        setAuthOpen(true);
      } else {
        setError(requestError?.message || "创建画板失败");
      }
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
    } catch (requestError: any) {
      setScenes((current) =>
        current.map((item) =>
          item.id === scene.id ? { ...item, favorite: scene.favorite } : item,
        ),
      );
      setError(requestError?.message || "更新收藏状态失败");
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
    } catch (requestError: any) {
      setError(requestError?.message || "保存画板信息失败");
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
            await deleteCloudScene(scene.id, true);
            setTrashScenes((current) =>
              current.filter((item) => item.id !== scene.id),
            );
            setMenuSceneId(null);
          } catch (requestError: any) {
            setError(requestError?.message || "彻底删除画板失败");
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
      setMenuSceneId(null);
    } catch (requestError: any) {
      setError(requestError?.message || "删除画板失败");
    } finally {
      setPendingAction(null);
    }
  };

  const handleEmptyTrash = () => {
    if (!trashScenes.length || pendingAction) {
      return;
    }
    setConfirmDialog({
      title: "清空回收站",
      message: `确定要清空回收站中的所有画板（共 ${trashScenes.length} 个）吗？此操作将永久删除这些画板且无法恢复。`,
      confirmLabel: "清空回收站",
      confirmVariant: "danger",
      onConfirm: async () => {
        setPendingAction("clear-trash");
        try {
          await clearCloudTrash();
          setTrashScenes([]);
        } catch (requestError: any) {
          setError(requestError?.message || "清空回收站失败");
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
    } catch (requestError: any) {
      setError(requestError?.message || "还原画板失败");
    } finally {
      setPendingAction(null);
    }
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
        );
        setFolders((current) =>
          current.map((folder) =>
            folder.id === updated.id ? updated : folder,
          ),
        );
        setScenes((current) =>
          current.map((scene) =>
            scene.folder_id === updated.id
              ? { ...scene, folder_name: updated.name }
              : scene,
          ),
        );
      } else {
        const created = await createCloudFolder(folderDialog.name.trim());
        setFolders((current) => [...current, created]);
      }
      setFolderDialog(null);
    } catch (requestError: any) {
      setError(requestError?.message || "保存文件夹失败");
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
          if (selectedFolderId === folder.id) {
            setSelectedFolderId(null);
          }
        } catch (requestError: any) {
          setError(requestError?.message || "删除文件夹失败");
        } finally {
          setPendingAction(null);
        }
      },
    });
  };

  const openMetadataDialog = (scene: CloudSceneSummary) => {
    setMenuSceneId(null);
    setMetadataDialog({
      scene,
      title: scene.name,
      tags: scene.tags.join(", "),
      folderId: scene.folder_id || "",
    });
  };

  return (
    <div
      className="workspace-home"
      ref={rootRef}
      onClick={() => setMenuSceneId(null)}
    >
      <header className="workspace-header">
        <a
          className="workspace-brand"
          href="/"
          aria-label="返回画板首页"
          onClick={(event) => {
            if (onSelectScene) {
              event.preventDefault();
              setView("all");
              setSelectedFolderId(null);
              setSelectedTag(null);
              setSearchQuery("");
            }
          }}
        >
          <ExcalidrawMark />
          <span>Excalidraw</span>
        </a>
        <div className="workspace-header-actions">
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
          <button
            className="primary-button header-create-button"
            type="button"
            onClick={handleCreateScene}
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
        </div>
      </header>

      <div className="workspace-layout">
        <aside
          className="workspace-sidebar"
          onClick={(event) => event.stopPropagation()}
        >
          <nav className="workspace-nav" aria-label="画板导航">
            <button
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
              <span>{scenes.length}</span>
            </button>
            <button
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
              className={view === "favorites" ? "is-selected" : ""}
              onClick={() => {
                setView("favorites");
                setSelectedFolderId(null);
              }}
              type="button"
            >
              <StarIcon />
              收藏
              <span>{scenes.filter((scene) => scene.favorite).length}</span>
            </button>
            <button
              className={view === "trash" ? "is-selected" : ""}
              onClick={() => {
                setView("trash");
                setSelectedFolderId(null);
              }}
              type="button"
            >
              <TrashIcon />
              回收站
              {trashScenes.length > 0 && <span>{trashScenes.length}</span>}
            </button>
          </nav>
          <div className="folder-heading">
            <span>文件夹</span>
            <button
              type="button"
              aria-label="新建文件夹"
              onClick={() => setFolderDialog({ id: null, name: "" })}
            >
              ＋
            </button>
          </div>
          <div className="folder-list">
            {folders.map((folder) => (
              <div className="folder-row" key={folder.id}>
                <button
                  type="button"
                  className={
                    selectedFolderId === folder.id && view !== "trash"
                      ? "is-selected"
                      : ""
                  }
                  onClick={() => {
                    setSelectedFolderId(folder.id);
                    setView("all");
                  }}
                >
                  <FolderIcon />
                  <span>{folder.name}</span>
                  <small>{folder.scene_count}</small>
                </button>
                <button
                  type="button"
                  className="folder-more"
                  aria-label={`${folder.name} 文件夹操作`}
                  onClick={() =>
                    setFolderDialog({ id: folder.id, name: folder.name })
                  }
                >
                  <MoreIcon />
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
              <p>
                {view === "trash"
                  ? "管理已删除的画板，支持一键还原或彻底清除。"
                  : "把想法留在画布上，随时继续。"}
              </p>
            </div>
            {view === "trash" ? (
              <button
                type="button"
                className="danger-button empty-trash-button"
                disabled={trashScenes.length === 0 || !!pendingAction}
                onClick={handleEmptyTrash}
              >
                <TrashIcon />
                清空回收站
              </button>
            ) : (
              <div
                className="view-toggle"
                role="tablist"
                aria-label="画板筛选"
                onKeyDown={(event) => {
                  const tabs = Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      '[role="tab"]',
                    ),
                  );
                  const currentIndex = tabs.indexOf(
                    event.target instanceof HTMLButtonElement
                      ? event.target
                      : tabs[0],
                  );
                  const nextIndex =
                    event.key === "ArrowRight"
                      ? (currentIndex + 1) % tabs.length
                      : event.key === "ArrowLeft"
                      ? (currentIndex - 1 + tabs.length) % tabs.length
                      : event.key === "Home"
                      ? 0
                      : event.key === "End"
                      ? tabs.length - 1
                      : -1;
                  if (nextIndex >= 0) {
                    event.preventDefault();
                    tabs[nextIndex].focus();
                    tabs[nextIndex].click();
                  }
                }}
              >
                {(["all", "recent", "favorites"] as BoardView[]).map((item) => (
                  <button
                    key={item}
                    className={
                      view === item && !selectedFolderId ? "is-selected" : ""
                    }
                    onClick={() => {
                      setView(item);
                      setSelectedFolderId(null);
                    }}
                    type="button"
                    role="tab"
                    aria-selected={view === item && !selectedFolderId}
                    tabIndex={view === item && !selectedFolderId ? 0 : -1}
                  >
                    {item === "all"
                      ? "全部"
                      : item === "recent"
                      ? "最近打开"
                      : "收藏"}
                  </button>
                ))}
              </div>
            )}
          </div>

          {error && (
            <div className="workspace-error" role="alert">
              {error}
            </div>
          )}

          {!loading &&
            recentScenes.length > 0 &&
            view === "all" &&
            !searchQuery &&
            !selectedFolderId &&
            !selectedTag && (
              <section className="recent-section">
                <div className="section-heading">
                  <h2>最近打开</h2>
                  <button type="button" onClick={() => setView("recent")}>
                    查看全部 <span aria-hidden="true">→</span>
                  </button>
                </div>
                <div className="recent-board-scroller">
                  <div className="recent-board-row">
                    {recentScenes.map((scene) => (
                      <BoardCard
                        key={scene.id}
                        scene={scene}
                        onOpen={navigateToScene}
                        onToggleFavorite={handleToggleFavorite}
                        onEdit={openMetadataDialog}
                        onDelete={handleDeleteScene}
                        menuOpen={menuSceneId === `recent:${scene.id}`}
                        onMenuToggle={() =>
                          setMenuSceneId(
                            menuSceneId === `recent:${scene.id}`
                              ? null
                              : `recent:${scene.id}`,
                          )
                        }
                        eager
                      />
                    ))}
                  </div>
                </div>
              </section>
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
                <span>{filteredScenes.length}</span>
              </div>
              <div className="section-tools">
                {allTags.length > 0 && view !== "trash" && (
                  <select
                    value={selectedTag || ""}
                    onChange={(event) =>
                      setSelectedTag(event.target.value || null)
                    }
                    aria-label="按标签筛选"
                  >
                    <option value="">所有标签</option>
                    {allTags.map((tag) => (
                      <option key={tag} value={tag}>
                        {tag}
                      </option>
                    ))}
                  </select>
                )}
                <select
                  value={sort}
                  onChange={(event) => setSort(event.target.value as SortMode)}
                  aria-label="排序方式"
                >
                  <option value="updated">按最近修改</option>
                  <option value="opened">按最近打开</option>
                  <option value="created">按创建时间</option>
                </select>
                <button
                  className="list-mode-button"
                  type="button"
                  aria-label={layoutMode === "grid" ? "列表视图" : "网格视图"}
                  title={
                    layoutMode === "grid" ? "切换到列表视图" : "切换到网格视图"
                  }
                  onClick={() =>
                    setLayoutMode((current) =>
                      current === "grid" ? "list" : "grid",
                    )
                  }
                >
                  <GridIcon />
                </button>
              </div>
            </div>

            {loading ? (
              <div className="workspace-empty-state loading-state">
                正在加载画板...
              </div>
            ) : filteredScenes.length === 0 ? (
              <div className="workspace-empty-state">
                <div className="empty-state-icon">
                  {view === "trash" ? <TrashIcon /> : <ExcalidrawMark />}
                </div>
                <h3>
                  {view === "trash"
                    ? "回收站为空"
                    : searchQuery || selectedTag || selectedFolderId
                    ? "没有找到匹配的画板"
                    : "还没有画板"}
                </h3>
                <p>
                  {view === "trash"
                    ? "删除的画板会暂存在这里，方便随时还原。"
                    : searchQuery || selectedTag || selectedFolderId
                    ? "试试更换关键词或筛选条件。"
                    : "创建一个画板，把下一个想法画出来。"}
                </p>
                {!searchQuery &&
                  !selectedTag &&
                  !selectedFolderId &&
                  view !== "trash" && (
                    <button
                      className="primary-button"
                      type="button"
                      onClick={handleCreateScene}
                    >
                      新建第一个画板
                    </button>
                  )}
              </div>
            ) : (
              <div
                className={`board-grid ${
                  layoutMode === "list" ? "is-list" : ""
                }`}
              >
                {filteredScenes.map((scene) => (
                  <BoardCard
                    key={scene.id}
                    scene={scene}
                    isTrash={view === "trash"}
                    onOpen={navigateToScene}
                    onToggleFavorite={handleToggleFavorite}
                    onEdit={openMetadataDialog}
                    onDelete={handleDeleteScene}
                    onRestore={handleRestoreScene}
                    menuOpen={menuSceneId === scene.id}
                    onMenuToggle={() =>
                      setMenuSceneId(menuSceneId === scene.id ? null : scene.id)
                    }
                  />
                ))}
              </div>
            )}
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
    </div>
  );
};
