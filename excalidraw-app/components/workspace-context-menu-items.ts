import type { CloudSceneSummary } from "../data/cloudStorage";
import type { WorkspaceContextMenuItem } from "./workspace-types";
import type { BoardView } from "./workspace-home-model";

type FolderContextMenuOptions = {
  createPending: boolean;
  folderPending: boolean;
  onOpen: () => void;
  onCreateBoard: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

export const getFolderContextMenuItems = (
  options: FolderContextMenuOptions,
): WorkspaceContextMenuItem[] => [
  {
    label: "打开文件夹",
    icon: "open",
    onSelect: options.onOpen,
  },
  {
    label: "在此文件夹中新建画板",
    icon: "plus",
    disabled: options.createPending,
    onSelect: options.onCreateBoard,
  },
  {
    label: "重命名与自定义外观",
    icon: "settings",
    separatorBefore: true,
    onSelect: options.onEdit,
  },
  {
    label: "删除文件夹",
    icon: "trash",
    danger: true,
    separatorBefore: true,
    disabled: options.folderPending,
    onSelect: options.onDelete,
  },
];

type BoardContextMenuOptions = {
  isTrashView: boolean;
  isSelected: boolean;
  selectedCount: number;
  scenePending: boolean;
  batchPending: boolean;
  onOpen: () => void;
  onToggleSelection: () => void;
  onClearSelection: () => void;
  onRestore: () => void;
  onBatchRestore: () => void;
  onPermanentDelete: () => void;
  onBatchPermanentDelete: () => void;
  onToggleFavorite: () => void;
  onEditMetadata: () => void;
  onMoveToTrash: () => void;
  onBatchMoveToTrash: () => void;
};

export const getBoardContextMenuItems = (
  scene: CloudSceneSummary,
  options: BoardContextMenuOptions,
): WorkspaceContextMenuItem[] => {
  const items: WorkspaceContextMenuItem[] = [];
  if (!options.isTrashView) {
    items.push({
      label: "打开画板",
      icon: "open",
      onSelect: options.onOpen,
    });
  }
  items.push({
    label: options.isSelected ? "从多选中移除" : "加入多选",
    icon: options.isSelected ? "check" : "plus",
    onSelect: options.onToggleSelection,
  });
  if (options.selectedCount) {
    items.push({
      label: "退出多选",
      icon: "close",
      separatorBefore: true,
      onSelect: options.onClearSelection,
    });
  }

  if (options.isTrashView) {
    items.push({
      label: "还原画板",
      icon: "restore",
      separatorBefore: options.selectedCount === 0,
      disabled: options.scenePending,
      onSelect: options.onRestore,
    });
    if (options.isSelected && options.selectedCount > 1) {
      items.push({
        label: `恢复所选 ${options.selectedCount} 个画板`,
        icon: "restore",
        disabled: options.batchPending,
        onSelect: options.onBatchRestore,
      });
    }
    items.push({
      label: "彻底删除",
      icon: "trash",
      danger: true,
      separatorBefore: true,
      disabled: options.scenePending,
      onSelect: options.onPermanentDelete,
    });
    if (options.isSelected && options.selectedCount > 1) {
      items.push({
        label: `彻底删除所选 ${options.selectedCount} 个画板`,
        icon: "trash",
        danger: true,
        disabled: options.batchPending,
        onSelect: options.onBatchPermanentDelete,
      });
    }
  } else {
    items.push({
      label: scene.favorite ? "取消收藏" : "收藏画板",
      icon: "star",
      separatorBefore: options.selectedCount === 0,
      disabled: options.scenePending,
      onSelect: options.onToggleFavorite,
    });
    items.push({
      label: "编辑画板信息",
      icon: "edit",
      separatorBefore: true,
      disabled: options.scenePending,
      onSelect: options.onEditMetadata,
    });
    items.push({
      label: "移至回收站",
      icon: "trash",
      danger: true,
      separatorBefore: true,
      disabled: options.scenePending,
      onSelect: options.onMoveToTrash,
    });
    if (options.isSelected && options.selectedCount > 1) {
      items.push({
        label: `移入回收站所选 ${options.selectedCount} 个画板`,
        icon: "trash",
        danger: true,
        disabled: options.batchPending,
        onSelect: options.onBatchMoveToTrash,
      });
    }
  }
  return items;
};

type BackgroundContextMenuInput = {
  target: Element;
  currentTarget: Element;
  searchInput: HTMLInputElement | null;
  searchQuery: string;
  view: BoardView;
  selectedFolderId: string | null;
  selectedSceneCount: number;
  trashCount: number;
  pageTransitionPending: boolean;
  loading: boolean;
  createPending: boolean;
  trashClearPending: boolean;
  batchPending: boolean;
  onOpenView: (view: BoardView) => void;
  onOpenCommandPalette: () => void;
  onEmptyTrash: () => void;
  onCreateScene: (folderId: string | null) => void;
  onOpenFolderDialog: () => void;
  onFocusSearch: () => void;
  onClearSearch: () => void;
  onClearFilters: () => void;
  onReturnToAll: () => void;
  onClearSelection: () => void;
  onReload: () => void;
};

const VIEW_LABELS: Record<BoardView, string> = {
  all: "所有画板",
  recent: "最近打开",
  favorites: "收藏",
  trash: "回收站",
};

export const getBackgroundContextMenuItems = (
  input: BackgroundContextMenuInput,
): WorkspaceContextMenuItem[] | null => {
  if (input.pageTransitionPending) {
    return null;
  }

  const { target } = input;
  const inputElement = target.closest<HTMLInputElement | HTMLTextAreaElement>(
    "input, textarea",
  );
  if (inputElement) {
    const items: WorkspaceContextMenuItem[] = [
      {
        label: "全选文本",
        icon: "check",
        disabled:
          inputElement.disabled ||
          (!["text", "search", "url", "tel", "password", "email"].includes(
            inputElement.type,
          ) &&
            inputElement.tagName !== "TEXTAREA"),
        onSelect: () => {
          inputElement.focus();
          inputElement.select();
        },
      },
    ];
    if (inputElement === input.searchInput) {
      items.push({
        label: "清空搜索",
        icon: "close",
        disabled: !input.searchQuery,
        onSelect: () => {
          input.onClearSearch();
          inputElement.focus();
        },
      });
    }
    return items;
  }

  // Keep portaled dialogs and the command palette in their own context.
  if (!input.currentTarget.contains(target)) {
    const dialog = target.closest('dialog, [role="dialog"]');
    return [
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
    ];
  }

  const navigation = target.closest<HTMLElement>("[data-workspace-view]");
  if (navigation) {
    const nextView = navigation.dataset.workspaceView as BoardView;
    const items: WorkspaceContextMenuItem[] = [
      {
        label: `打开${VIEW_LABELS[nextView]}`,
        icon:
          nextView === "favorites"
            ? "star"
            : nextView === "trash"
              ? "trash"
              : "open",
        onSelect: () => input.onOpenView(nextView),
      },
      {
        label: "命令菜单",
        icon: "commands",
        onSelect: input.onOpenCommandPalette,
      },
    ];
    if (nextView === "trash") {
      items.push({
        label: "清空回收站",
        icon: "trash",
        separatorBefore: true,
        danger: true,
        disabled:
          !input.trashCount || input.trashClearPending || input.batchPending,
        onSelect: input.onEmptyTrash,
      });
    } else {
      items.push({
        label: "新建画板",
        icon: "plus",
        separatorBefore: true,
        disabled: input.createPending,
        onSelect: () => input.onCreateScene(null),
      });
    }
    return items;
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
    return [
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
        onSelect: input.onOpenCommandPalette,
      },
    ];
  }

  const inSidebar = !!target.closest(".workspace-sidebar");
  const inTrash = input.view === "trash" && !inSidebar;
  const items: WorkspaceContextMenuItem[] = [];
  if (!inTrash) {
    items.push(
      {
        label:
          !inSidebar && input.selectedFolderId
            ? "在此文件夹中新建画板"
            : "新建画板",
        icon: "plus",
        disabled: input.createPending,
        onSelect: () =>
          input.onCreateScene(inSidebar ? null : input.selectedFolderId),
      },
      {
        label: "新建文件夹",
        icon: "folder",
        onSelect: input.onOpenFolderDialog,
      },
    );
  }
  items.push(
    {
      label: "搜索画板",
      icon: "search",
      separatorBefore: items.length > 0,
      onSelect: input.onFocusSearch,
    },
    {
      label: "命令菜单",
      icon: "commands",
      onSelect: input.onOpenCommandPalette,
    },
    {
      label: inTrash ? "刷新回收站" : "刷新画板列表",
      icon: "refresh",
      disabled: input.loading,
      onSelect: input.onReload,
    },
  );
  if (input.searchQuery || input.selectedFolderId) {
    items.push({
      label: "清除筛选",
      icon: "close",
      onSelect: input.onClearFilters,
    });
  }
  if (input.selectedSceneCount) {
    items.push({
      label: "退出多选",
      icon: "check",
      onSelect: input.onClearSelection,
    });
  }
  if (inTrash) {
    items.push(
      {
        label: "返回所有画板",
        icon: "open",
        separatorBefore: true,
        onSelect: input.onReturnToAll,
      },
      {
        label: "清空回收站",
        icon: "trash",
        danger: true,
        disabled:
          !input.trashCount || input.trashClearPending || input.batchPending,
        onSelect: input.onEmptyTrash,
      },
    );
  }
  return items;
};
