import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  WorkspaceCommandPalette,
  type WorkspaceCommandPaletteProps,
} from "../components/WorkspaceCommandPalette";
import type { CloudFolder, CloudSceneSummary } from "../data/cloudStorage";

const mockScenes: CloudSceneSummary[] = [
  {
    id: "scene-1",
    name: "架构设计图",
    created_at: 1000,
    updated_at: 2000,
    revision: 1,
    tags: ["架构", "后端"],
    favorite: true,
    folder_id: "folder-1",
    folder_name: "工作目录",
    last_opened_at: 3000,
    thumbnail_file_id: null,
  },
  {
    id: "scene-2",
    name: "流程白板",
    created_at: 1200,
    updated_at: 1500,
    revision: 1,
    tags: ["流程"],
    favorite: false,
    folder_id: null,
    folder_name: null,
    last_opened_at: 2500,
    thumbnail_file_id: null,
  },
];

const mockFolders: CloudFolder[] = [
  {
    id: "folder-1",
    name: "工作目录",
    created_at: 1000,
    updated_at: 1000,
    scene_count: 1,
  },
];

const createDefaultProps = (
  overrides: Partial<WorkspaceCommandPaletteProps> = {},
): WorkspaceCommandPaletteProps => ({
  isOpen: true,
  onClose: vi.fn(),
  scenes: mockScenes,
  folders: mockFolders,
  trashCount: 1,
  currentView: "all",
  currentSort: "updated",
  currentLayout: "grid",
  selectedFolderId: null,
  onSelectScene: vi.fn(),
  onCreateScene: vi.fn(),
  onCreateFolder: vi.fn(),
  onChangeView: vi.fn(),
  onSelectFolder: vi.fn(),
  onChangeSort: vi.fn(),
  onToggleLayout: vi.fn(),
  onEmptyTrash: vi.fn(),
  onReload: vi.fn(),
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("WorkspaceCommandPalette component", () => {
  it("does not render anything when isOpen is false", () => {
    const props = createDefaultProps({ isOpen: false });
    render(<WorkspaceCommandPalette {...props} />);
    expect(screen.queryByPlaceholderText("搜索菜单、命令或画板...")).toBeNull();
  });

  it("renders search input, category groups, and default commands when open", () => {
    const props = createDefaultProps();
    render(<WorkspaceCommandPalette {...props} />);

    expect(screen.getByPlaceholderText("搜索菜单、命令或画板...")).toBeDefined();
    expect(screen.getByText("常用操作")).toBeDefined();
    expect(screen.getByText("画板")).toBeDefined();
    expect(screen.getByText("视图与筛选")).toBeDefined();
    expect(screen.getByText("显示设置")).toBeDefined();

    // Verify key action labels
    expect(screen.getByText("新建画板")).toBeDefined();
    expect(screen.getByText("新建文件夹")).toBeDefined();
    expect(screen.getByText("清空回收站 (1)")).toBeDefined();
    expect(screen.getByText("架构设计图")).toBeDefined();
  });

  it("filters items according to search query", () => {
    const props = createDefaultProps();
    render(<WorkspaceCommandPalette {...props} />);

    const input = screen.getByPlaceholderText("搜索菜单、命令或画板...");
    fireEvent.change(input, { target: { value: "架构" } });

    expect(screen.getByText("架构设计图")).toBeDefined();
    expect(screen.queryByText("新建文件夹")).toBeNull();
    expect(screen.queryByText("流程白板")).toBeNull();
  });

  it("shows empty state when no matching commands found", () => {
    const props = createDefaultProps();
    render(<WorkspaceCommandPalette {...props} />);

    const input = screen.getByPlaceholderText("搜索菜单、命令或画板...");
    fireEvent.change(input, { target: { value: "xxxx未知内容" } });

    expect(screen.getByText("没有匹配的命令……")).toBeDefined();
  });

  it("supports keyboard navigation with ArrowDown, ArrowUp, and Enter", () => {
    const onCreateScene = vi.fn();
    const onCreateFolder = vi.fn();
    const props = createDefaultProps({ onCreateScene, onCreateFolder });
    render(<WorkspaceCommandPalette {...props} />);

    const input = screen.getByPlaceholderText("搜索菜单、命令或画板...");

    // First item is "新建画板" by default
    // Press ArrowDown to move to "新建文件夹"
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCreateFolder).toHaveBeenCalledTimes(1);
    expect(onCreateScene).not.toHaveBeenCalled();
  });

  it("calls onSelectScene with newTab=true on Ctrl+Enter", () => {
    const onSelectScene = vi.fn();
    const props = createDefaultProps({ onSelectScene });
    render(<WorkspaceCommandPalette {...props} />);

    const input = screen.getByPlaceholderText("搜索菜单、命令或画板...");
    fireEvent.change(input, { target: { value: "架构" } });

    // Item 0 is "架构设计图"
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

    expect(onSelectScene).toHaveBeenCalledTimes(1);
    expect(onSelectScene).toHaveBeenCalledWith(mockScenes[0], true);
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    const props = createDefaultProps({ onClose });
    render(<WorkspaceCommandPalette {...props} />);

    const input = screen.getByPlaceholderText("搜索菜单、命令或画板...");
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("triggers action upon clicking an action item", () => {
    const onCreateScene = vi.fn();
    const onClose = vi.fn();
    const props = createDefaultProps({ onCreateScene, onClose });
    render(<WorkspaceCommandPalette {...props} />);

    const createBtn = screen.getByText("新建画板");
    fireEvent.click(createBtn);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCreateScene).toHaveBeenCalledTimes(1);
  });

  it("triggers view change and folder selection correctly", () => {
    const onChangeView = vi.fn();
    const onSelectFolder = vi.fn();
    const props = createDefaultProps({ onChangeView, onSelectFolder });
    render(<WorkspaceCommandPalette {...props} />);

    const viewRecentBtn = screen.getByText("查看最近打开");
    fireEvent.click(viewRecentBtn);
    expect(onChangeView).toHaveBeenCalledWith("recent");
    expect(onSelectFolder).toHaveBeenCalledWith(null);

    const folderBtn = screen.getByText("筛选文件夹：工作目录");
    fireEvent.click(folderBtn);
    expect(onChangeView).toHaveBeenCalledWith("all");
    expect(onSelectFolder).toHaveBeenCalledWith("folder-1");
  });

  it("supports recents (最近使用) history tracking across executions", () => {
    // 1. Initial render has no recents
    const { unmount } = render(
      <WorkspaceCommandPalette {...createDefaultProps()} />,
    );
    expect(screen.queryByText("最近使用")).toBeNull();

    // Click "新建画板" to trigger recents recording
    fireEvent.click(screen.getByText("新建画板"));
    unmount();

    // 2. Next render has "最近使用" with "新建画板"
    render(<WorkspaceCommandPalette {...createDefaultProps()} />);
    expect(screen.getByText("最近使用")).toBeDefined();
  });
});
