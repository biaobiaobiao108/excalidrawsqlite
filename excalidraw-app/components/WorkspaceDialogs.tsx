import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { CustomSelect } from "./CustomSelect";
import { WorkspaceDialog } from "./WorkspaceDialog";
import {
  FolderAppearanceIcon,
  WorkspaceContextMenuIcon,
} from "./WorkspaceIcons";
import type { CloudFolder } from "../data/cloudStorage";
import {
  FOLDER_COLOR_OPTIONS,
  FOLDER_ICON_OPTIONS,
  type ConfirmDialogState,
  type FolderDialogState,
  type SceneMetadataDialogState,
  type WorkspaceContextMenuState,
} from "./workspace-types";

const WorkspaceModal = WorkspaceDialog;

export const MetadataDialog = ({
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

export const FolderDialog = ({
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

export const WorkspaceContextMenu = ({
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

export const ConfirmDialog = ({
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
