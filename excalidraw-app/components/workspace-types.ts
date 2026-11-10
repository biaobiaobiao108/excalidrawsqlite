import type { CloudFolder, CloudSceneSummary } from "../data/cloudStorage";

export type SceneMetadataDialogState = {
  scene: CloudSceneSummary;
  title: string;
  tags: string;
  folderId: string;
};

export type FolderDialogState = {
  id: string | null;
  name: string;
  icon: FolderIconName;
  color: string;
};

export type FolderIconName = CloudFolder["icon"];

export type FolderAppearance = {
  icon: FolderIconName;
  color: string;
};

export type WorkspaceContextMenuIconName =
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

export type WorkspaceContextMenuItem = {
  label: string;
  icon: WorkspaceContextMenuIconName;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
};

export type WorkspaceContextMenuState = {
  x: number;
  y: number;
  items: WorkspaceContextMenuItem[];
  portalTarget: HTMLElement;
};

export type ConfirmDialogState = {
  title: string;
  message: string;
  confirmLabel?: string;
  confirmVariant?: "danger" | "primary";
  onConfirm: () => Promise<void> | void;
};

export const FOLDER_ICON_OPTIONS: Array<{
  id: FolderIconName;
  label: string;
}> = [
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

export const FOLDER_COLOR_OPTIONS = [
  { color: "#315f4c", label: "松柏绿" },
  { color: "#668f78", label: "鼠尾草绿" },
  { color: "#4e8290", label: "湖水蓝" },
  { color: "#bd8054", label: "陶土橙" },
  { color: "#a65f65", label: "莓果红" },
  { color: "#9675a6", label: "薰衣草紫" },
  { color: "#aa8b37", label: "麦穗黄" },
  { color: "#66717d", label: "石板灰" },
];

export const DEFAULT_FOLDER_APPEARANCE: FolderAppearance = {
  icon: "folder",
  color: FOLDER_COLOR_OPTIONS[0].color,
};
