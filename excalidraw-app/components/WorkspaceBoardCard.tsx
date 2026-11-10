import React, { useEffect, useRef, useState } from "react";

import type { CloudSceneSummary } from "../data/cloudStorage";
import { ThumbnailRepairQueue } from "../data/thumbnailRepairQueue";
import { BoardCardBadges } from "./BoardCardBadges";
import {
  isBoardSelectionModifierClick,
  type BoardSelectionClick,
} from "./board-list-selection";
import {
  BoardSelectionIcon,
  EditIcon,
  FolderAppearanceIcon,
  RestoreIcon,
  StarIcon,
  TrashIcon,
} from "./WorkspaceIcons";
import {
  DEFAULT_FOLDER_APPEARANCE,
  type FolderAppearance,
} from "./workspace-types";

const TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

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
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
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
        src={`/api/files/${encodeURIComponent(thumbnailId)}?v=${scene.updated_at}${scene.thumbnailVersion ? `&t=${scene.thumbnailVersion}` : ""}`}
        alt={`${scene.name} 预览`}
        width={640}
        height={400}
        loading={eager ? "eager" : "lazy"}
        fetchPriority={eager ? "high" : "low"}
      />
    </div>
  );
};

export const BoardCard = React.memo(
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
