import React from "react";
import { createPortal } from "react-dom";

import type { CloudFolder, CloudSceneSummary } from "../data/cloudStorage";
import {
  ConfirmDialog,
  FolderDialog,
  MetadataDialog,
  WorkspaceContextMenu,
} from "./WorkspaceDialogs";
import { RestoreIcon, TrashIcon } from "./WorkspaceIcons";
import type {
  ConfirmDialogState,
  FolderDialogState,
  SceneMetadataDialogState,
  WorkspaceContextMenuState,
} from "./workspace-types";
import type { BoardView, SortMode } from "./workspace-home-model";

const LazyAuthDialog = React.lazy(async () => {
  const { AuthDialog } = await import("./AuthDialog");
  return { default: AuthDialog };
});

const LazyWorkspaceCommandPalette = React.lazy(async () => {
  const { WorkspaceCommandPalette } = await import("./WorkspaceCommandPalette");
  return { default: WorkspaceCommandPalette };
});

type WorkspaceHomeOverlaysProps = {
  metadataDialog: SceneMetadataDialogState | null;
  folders: CloudFolder[];
  metadataPending: boolean;
  onMetadataChange: (next: Partial<SceneMetadataDialogState>) => void;
  onMetadataClose: () => void;
  onMetadataSave: () => void;
  folderDialog: FolderDialogState | null;
  folderPending: boolean;
  onFolderNameChange: (name: string) => void;
  onFolderAppearanceChange: (
    next: Partial<Pick<FolderDialogState, "icon" | "color">>,
  ) => void;
  onFolderClose: () => void;
  onFolderSave: () => void;
  onFolderDelete: () => void;
  confirmDialog: ConfirmDialogState | null;
  confirmPending: boolean;
  onConfirmClose: () => void;
  onConfirm: () => void;
  authOpen: boolean;
  onAuthSuccess: () => void;
  onAuthClose: () => void;
  commandPaletteOpen: boolean;
  scenes: CloudSceneSummary[];
  trashCount: number;
  currentView: BoardView;
  currentSort: SortMode;
  selectedFolderId: string | null;
  onSelectScene: (scene: CloudSceneSummary, newTab?: boolean) => void;
  onCreateScene: (folderId?: string | null, name?: string) => void;
  onCreateFolder: () => void;
  onChangeView: (view: BoardView) => void;
  onSelectFolder: (folderId: string | null) => void;
  onChangeSort: (sort: SortMode) => void;
  onSearch: (query: string) => void;
  onEmptyTrash: () => void;
  onReload: () => void;
  onCommandPaletteClose: () => void;
  contextMenu: WorkspaceContextMenuState | null;
  onContextMenuClose: () => void;
  selectedCount: number;
  isTrashView: boolean;
  batchDisabled: boolean;
  onBatchMoveToTrash: () => void;
  onBatchRestore: () => void;
  onBatchPermanentDelete: () => void;
  onClearSelection: () => void;
};

export const WorkspaceHomeOverlays = ({
  metadataDialog,
  folders,
  metadataPending,
  onMetadataChange,
  onMetadataClose,
  onMetadataSave,
  folderDialog,
  folderPending,
  onFolderNameChange,
  onFolderAppearanceChange,
  onFolderClose,
  onFolderSave,
  onFolderDelete,
  confirmDialog,
  confirmPending,
  onConfirmClose,
  onConfirm,
  authOpen,
  onAuthSuccess,
  onAuthClose,
  commandPaletteOpen,
  scenes,
  trashCount,
  currentView,
  currentSort,
  selectedFolderId,
  onSelectScene,
  onCreateScene,
  onCreateFolder,
  onChangeView,
  onSelectFolder,
  onChangeSort,
  onSearch,
  onEmptyTrash,
  onReload,
  onCommandPaletteClose,
  contextMenu,
  onContextMenuClose,
  selectedCount,
  isTrashView,
  batchDisabled,
  onBatchMoveToTrash,
  onBatchRestore,
  onBatchPermanentDelete,
  onClearSelection,
}: WorkspaceHomeOverlaysProps) => (
  <>
    {metadataDialog && (
      <MetadataDialog
        state={metadataDialog}
        folders={folders}
        pending={metadataPending}
        onChange={onMetadataChange}
        onClose={onMetadataClose}
        onSave={onMetadataSave}
      />
    )}
    {folderDialog && (
      <FolderDialog
        state={folderDialog}
        pending={folderPending}
        onChange={onFolderNameChange}
        onChangeAppearance={onFolderAppearanceChange}
        onClose={onFolderClose}
        onSave={onFolderSave}
        onDelete={onFolderDelete}
      />
    )}
    {confirmDialog && (
      <ConfirmDialog
        state={confirmDialog}
        pending={confirmPending}
        onClose={onConfirmClose}
        onConfirm={onConfirm}
      />
    )}
    {authOpen && (
      <React.Suspense fallback={null}>
        <LazyAuthDialog
          isOpen
          onSuccess={onAuthSuccess}
          onClose={onAuthClose}
        />
      </React.Suspense>
    )}
    {commandPaletteOpen && (
      <React.Suspense fallback={null}>
        <LazyWorkspaceCommandPalette
          isOpen
          onClose={onCommandPaletteClose}
          scenes={scenes}
          folders={folders}
          trashCount={trashCount}
          currentView={currentView}
          currentSort={currentSort}
          selectedFolderId={selectedFolderId}
          onSelectScene={onSelectScene}
          onCreateScene={onCreateScene}
          onCreateFolder={onCreateFolder}
          onChangeView={onChangeView}
          onSelectFolder={onSelectFolder}
          onChangeSort={onChangeSort}
          onSearch={onSearch}
          onEmptyTrash={onEmptyTrash}
          onReload={onReload}
        />
      </React.Suspense>
    )}
    {contextMenu && (
      <WorkspaceContextMenu state={contextMenu} onClose={onContextMenuClose} />
    )}
    {selectedCount > 0 &&
      typeof document !== "undefined" &&
      createPortal(
        <div
          className="workspace-batch-bar"
          role="toolbar"
          aria-label="批量操作"
        >
          <div className="workspace-batch-bar-count">
            已选择 <strong>{selectedCount}</strong> 项
          </div>
          <div className="workspace-batch-bar-divider" aria-hidden="true" />
          <div className="workspace-batch-bar-actions">
            {!isTrashView ? (
              <button
                type="button"
                className="batch-bar-button danger"
                onClick={onBatchMoveToTrash}
                disabled={batchDisabled}
                title={`将所选 ${selectedCount} 个画板移入回收站`}
              >
                <TrashIcon />
                <span>移入回收站</span>
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="batch-bar-button"
                  onClick={onBatchRestore}
                  disabled={batchDisabled}
                  title={`还原所选 ${selectedCount} 个画板`}
                >
                  <RestoreIcon />
                  <span>还原</span>
                </button>
                <button
                  type="button"
                  className="batch-bar-button danger"
                  onClick={onBatchPermanentDelete}
                  disabled={batchDisabled}
                  title={`彻底删除所选 ${selectedCount} 个画板`}
                >
                  <TrashIcon />
                  <span>彻底删除</span>
                </button>
              </>
            )}
            <button
              type="button"
              className="batch-bar-button close"
              onClick={onClearSelection}
              aria-label="退出多选"
              title="退出多选 (Esc)"
            >
              取消
            </button>
          </div>
        </div>,
        document.body,
      )}
  </>
);
