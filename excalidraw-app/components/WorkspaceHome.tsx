import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";

import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/element/types";

import {
  checkAuthStatus,
  createCloudFolder,
  createCloudScene,
  deleteCloudFolder,
  deleteCloudScene,
  fetchCloudFolders,
  fetchCloudScenes,
  markCloudSceneOpened,
  renameCloudFolder,
  saveFilesToCloud,
  updateCloudSceneMetadata,
  type CloudFolder,
  type CloudSceneSummary,
} from "../data/cloudStorage";
import { LocalData } from "../data/LocalData";
import { importFromLocalStorage } from "../data/localStorage";

import { AuthDialog } from "./AuthDialog";

import "./WorkspaceHome.scss";

type BoardView = "all" | "recent" | "favorites";
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

const formatCreatedDate = (timestamp: number) => {
  const date = new Date(timestamp);
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
        src={`/api/files/${encodeURIComponent(scene.thumbnail_file_id)}`}
        alt={`${scene.name} 预览`}
        width={640}
        height={400}
        loading={eager ? "eager" : "lazy"}
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
  menuOpen,
  onMenuToggle,
  eager,
}: {
  scene: CloudSceneSummary;
  onOpen: (scene: CloudSceneSummary) => void;
  onToggleFavorite: (scene: CloudSceneSummary) => void;
  onEdit: (scene: CloudSceneSummary) => void;
  onDelete: (scene: CloudSceneSummary) => void;
  menuOpen: boolean;
  onMenuToggle: () => void;
  eager?: boolean;
}) => (
  <article className="board-card">
    <button
      className="board-card-open"
      onClick={() => onOpen(scene)}
      type="button"
    >
      <BoardThumbnail scene={scene} eager={eager} />
      <span className="board-card-title">{scene.name || "未命名白板"}</span>
    </button>
    <div className="board-card-footer">
      <div className="board-card-details">
        <span className="board-card-mobile-title">
          {scene.name || "未命名白板"}
        </span>
        <span className="board-card-updated">
          更新于 {formatDate(scene.updated_at)}
        </span>
        <span className="board-card-created">
          创建于 {formatCreatedDate(scene.created_at)}
        </span>
        {scene.folder_name && (
          <span className="board-card-folder">
            <FolderIcon />
            {scene.folder_name}
          </span>
        )}
        {scene.tags.length > 0 && (
          <div className="board-card-tags">
            {scene.tags.slice(0, 2).map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
        )}
      </div>
      <div className="board-card-actions">
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
            aria-label="更多画板操作"
            aria-expanded={menuOpen}
            onClick={onMenuToggle}
          >
            <MoreIcon />
          </button>
          {menuOpen && (
            <div className="board-card-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => onEdit(scene)}
              >
                编辑信息
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => onOpen(scene)}
              >
                打开画板
              </button>
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => onDelete(scene)}
              >
                删除画板
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  </article>
);

const WorkspaceModal = ({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) => (
  <div
    className="workspace-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="workspace-dialog-title"
    onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }}
  >
    <button
      type="button"
      className="workspace-dialog-backdrop"
      aria-label="关闭弹窗"
      onClick={onClose}
    />
    <div className="workspace-dialog-content-shell">
      <h2 id="workspace-dialog-title" className="workspace-dialog-title">
        {title}
      </h2>
      <div className="workspace-dialog-form-content">{children}</div>
    </div>
  </div>
);

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
          autoFocus
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
          autoFocus
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

export const WorkspaceHome = () => {
  const rootRef = useRef<HTMLDivElement>(null);
  const [scenes, setScenes] = useState<CloudSceneSummary[]>([]);
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
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const auth = await checkAuthStatus();
      if (auth.authRequired && !auth.authenticated) {
        setAuthOpen(true);
        return;
      }
      const [sceneList, folderList] = await Promise.all([
        fetchCloudScenes(),
        fetchCloudFolders(),
      ]);
      let migratedScene: CloudSceneSummary | null = null;
      if (sceneList.length === 0) {
        try {
          migratedScene = await migrateLocalScene();
        } catch (migrationError) {
          console.warn("迁移本地画板失败", migrationError);
        }
      }
      setScenes(migratedScene ? [migratedScene] : sceneList);
      setFolders(folderList);
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
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  const allTags = useMemo(
    () =>
      [...new Set(scenes.flatMap((scene) => scene.tags))].sort((a, b) =>
        a.localeCompare(b, "zh-CN"),
      ),
    [scenes],
  );

  const filteredScenes = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    const filtered = scenes.filter((scene) => {
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
  }, [scenes, searchQuery, selectedFolderId, selectedTag, sort, view]);

  const recentScenes = useMemo(
    () =>
      sortScenes(
        scenes.filter((scene) => scene.last_opened_at),
        "opened",
      ).slice(0, 4),
    [scenes],
  );

  const navigateToScene = (scene: CloudSceneSummary) => {
    void markCloudSceneOpened(scene.id).catch(() => {});
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
      const scene = await createCloudScene({ name: "未命名白板" });
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
    const ownerWindow = getOwnerWindow(rootRef.current);
    if (
      !ownerWindow.confirm(`确定要删除画板“${scene.name}”吗？该操作无法恢复。`)
    ) {
      return;
    }
    setPendingAction(`delete:${scene.id}`);
    try {
      await deleteCloudScene(scene.id);
      setScenes((current) => current.filter((item) => item.id !== scene.id));
      setMenuSceneId(null);
    } catch (requestError: any) {
      setError(requestError?.message || "删除画板失败");
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

  const handleDeleteFolder = async (folder: CloudFolder) => {
    const ownerWindow = getOwnerWindow(rootRef.current);
    if (
      !ownerWindow.confirm(
        `删除文件夹“${folder.name}”？其中的画板会移动到根目录。`,
      )
    ) {
      return;
    }
    setPendingAction(`delete-folder:${folder.id}`);
    try {
      await deleteCloudFolder(folder.id);
      setFolders((current) => current.filter((item) => item.id !== folder.id));
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
        <a className="workspace-brand" href="/" aria-label="返回画板首页">
          <ExcalidrawMark />
          <span>Excalidraw</span>
        </a>
        <div className="workspace-header-divider" />
        <div className="workspace-context">个人工作区</div>
        <div className="workspace-header-actions">
          <label className="workspace-search">
            <SearchIcon />
            <input
              value={searchQuery}
              placeholder="搜索画板"
              aria-label="搜索画板"
              onChange={(event) => setSearchQuery(event.target.value)}
              onClick={(event) => event.stopPropagation()}
            />
            <kbd>⌘K</kbd>
          </label>
          <button
            className="primary-button header-create-button"
            type="button"
            onClick={handleCreateScene}
            disabled={!!pendingAction}
          >
            <span aria-hidden="true">＋</span>
            新建画板
          </button>
          <button
            className="profile-button"
            type="button"
            aria-label="个人设置"
          >
            L
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
                    selectedFolderId === folder.id ? "is-selected" : ""
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
          <div className="workspace-storage">
            <div className="storage-label">
              <span>云端存储</span>
              <span>SQLite</span>
            </div>
            <div className="storage-progress">
              <span />
            </div>
            <span className="storage-caption">数据持续保存中</span>
          </div>
        </aside>

        <main
          className="workspace-main"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="workspace-main-heading">
            <div>
              <h1>我的画板</h1>
              <p>把想法留在画布上，随时继续。</p>
            </div>
            <div className="view-toggle" role="tablist" aria-label="画板筛选">
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
                >
                  {item === "all"
                    ? "全部"
                    : item === "recent"
                    ? "最近打开"
                    : "收藏"}
                </button>
              ))}
            </div>
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
              </section>
            )}

          <section className="all-boards-section">
            <div className="section-heading all-boards-heading">
              <div className="section-heading-title">
                <h2>
                  {selectedFolderId
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
                {allTags.length > 0 && (
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
                  <ExcalidrawMark />
                </div>
                <h3>
                  {searchQuery || selectedTag || selectedFolderId
                    ? "没有找到匹配的画板"
                    : "还没有画板"}
                </h3>
                <p>
                  {searchQuery || selectedTag || selectedFolderId
                    ? "试试更换关键词或筛选条件。"
                    : "创建一个画板，把下一个想法画出来。"}
                </p>
                {!searchQuery && !selectedTag && !selectedFolderId && (
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
                    onOpen={navigateToScene}
                    onToggleFavorite={handleToggleFavorite}
                    onEdit={openMetadataDialog}
                    onDelete={handleDeleteScene}
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
            if (folder) {
              void handleDeleteFolder(folder);
            }
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
