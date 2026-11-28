import type { CSSProperties, MouseEvent, RefObject } from "react";
import { isDarwin } from "@excalidraw/common";

import type { CloudFolder, CloudWorkspaceStats } from "../data/cloudStorage";
import {
  ClockIcon,
  ExcalidrawMark,
  FolderAppearanceIcon,
  FolderIcon,
  GridIcon,
  MoreIcon,
  SearchIcon,
  StarIcon,
  TrashIcon,
} from "./WorkspaceIcons";
import { DEFAULT_FOLDER_APPEARANCE } from "./workspace-types";
import type { BoardView } from "./workspace-home-model";

type WorkspaceSidebarProps = {
  view: BoardView;
  selectedFolderId: string | null;
  searchQuery: string;
  searchInputRef: RefObject<HTMLInputElement | null>;
  workspaceNavRef: RefObject<HTMLElement | null>;
  workspaceNavOverflow: { left: boolean; right: boolean };
  folders: CloudFolder[];
  folderSceneCounts: ReadonlyMap<string, number>;
  workspaceStats: CloudWorkspaceStats | null;
  mobileFoldersOpen: boolean;
  createPending: boolean;
  onBrandNavigate?: () => void;
  onCreateScene: () => void;
  onSearchChange: (value: string) => void;
  onChangeView: (view: BoardView) => void;
  onSelectFolder: (folderId: string) => void;
  onToggleMobileFolders: () => void;
  onOpenFolderDialog: () => void;
  onOpenFolderContextMenu: (
    folder: CloudFolder,
    event: MouseEvent<HTMLElement>,
  ) => void;
};

export const WorkspaceSidebar = ({
  view,
  selectedFolderId,
  searchQuery,
  searchInputRef,
  workspaceNavRef,
  workspaceNavOverflow,
  folders,
  folderSceneCounts,
  workspaceStats,
  mobileFoldersOpen,
  createPending,
  onBrandNavigate,
  onCreateScene,
  onSearchChange,
  onChangeView,
  onSelectFolder,
  onToggleMobileFolders,
  onOpenFolderDialog,
  onOpenFolderContextMenu,
}: WorkspaceSidebarProps) => (
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
          if (onBrandNavigate) {
            event.preventDefault();
            onBrandNavigate();
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
          onClick={onCreateScene}
          disabled={createPending}
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
            onChange={(event) => onSearchChange(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                searchInputRef.current?.blur();
              }
            }}
          />
          <kbd>{isDarwin ? "⌘K" : "Ctrl+K"}</kbd>
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
          className={view === "all" && !selectedFolderId ? "is-selected" : ""}
          onClick={() => onChangeView("all")}
          type="button"
        >
          <GridIcon />
          所有画板
          <span>{workspaceStats?.sceneCount ?? "…"}</span>
        </button>
        <button
          data-workspace-view="recent"
          className={view === "recent" ? "is-selected" : ""}
          onClick={() => onChangeView("recent")}
          type="button"
        >
          <ClockIcon />
          最近打开
        </button>
        <button
          data-workspace-view="favorites"
          className={view === "favorites" ? "is-selected" : ""}
          onClick={() => onChangeView("favorites")}
          type="button"
        >
          <StarIcon />
          收藏
          <span>{workspaceStats?.favoriteCount ?? "…"}</span>
        </button>
        <button
          data-workspace-view="trash"
          className={view === "trash" ? "is-selected" : ""}
          onClick={() => onChangeView("trash")}
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
    <button
      type="button"
      className="mobile-folder-toggle"
      aria-expanded={mobileFoldersOpen}
      aria-controls="workspace-folder-panel"
      onClick={onToggleMobileFolders}
    >
      <FolderIcon />
      <span>文件夹</span>
      <small>{folders.length}</small>
      <span className="mobile-folder-chevron" aria-hidden="true" />
    </button>
    <div
      id="workspace-folder-panel"
      className={`folder-panel${mobileFoldersOpen ? " is-open" : ""}`}
    >
      <div className="folder-panel-content">
        <div className="folder-heading">
          <span>文件夹</span>
          <button
            type="button"
            aria-label="新建文件夹"
            onClick={onOpenFolderDialog}
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
                } as CSSProperties
              }
              onContextMenu={(event) => onOpenFolderContextMenu(folder, event)}
            >
              <button
                type="button"
                className="folder-row-select"
                onClick={() => onSelectFolder(folder.id)}
              >
                <span className="folder-row-icon" aria-hidden="true">
                  <FolderAppearanceIcon
                    icon={folder.icon || DEFAULT_FOLDER_APPEARANCE.icon}
                  />
                </span>
                <span>{folder.name}</span>
                <small>{folderSceneCounts.get(folder.id) || 0}</small>
              </button>
              <button
                type="button"
                className="folder-row-menu"
                aria-label={`管理文件夹“${folder.name}”`}
                title="文件夹操作"
                onClick={(event) => onOpenFolderContextMenu(folder, event)}
              >
                <MoreIcon />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  </aside>
);
