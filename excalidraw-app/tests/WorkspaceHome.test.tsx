import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { WorkspaceHome } from "../components/WorkspaceHome";

import type { CloudFolder, CloudSceneSummary } from "../data/cloudStorage";

const mockScenes: CloudSceneSummary[] = [
  {
    id: "scene-1",
    name: "架构设计图",
    created_at: Date.now() - 10000,
    updated_at: Date.now() - 5000,
    revision: 1,
    tags: ["架构", "设计"],
    favorite: true,
    folder_id: "folder-1",
    folder_name: "工作目录",
    last_opened_at: Date.now() - 1000,
    thumbnail_file_id: "thumbnail-1",
  },
  {
    id: "scene-2",
    name: "产品流程图",
    created_at: Date.now() - 20000,
    updated_at: Date.now() - 15000,
    revision: 1,
    tags: ["产品"],
    favorite: false,
    folder_id: null,
    folder_name: null,
    last_opened_at: null,
    thumbnail_file_id: null,
  },
];

const mockTrashScenes: CloudSceneSummary[] = [
  {
    id: "scene-trash-1",
    name: "废弃草稿",
    created_at: Date.now() - 50000,
    updated_at: Date.now() - 40000,
    deleted_at: Date.now() - 2000,
    revision: 1,
    tags: ["废弃"],
    favorite: false,
    folder_id: null,
    folder_name: null,
    last_opened_at: null,
    thumbnail_file_id: null,
  },
];

const mockFolders: CloudFolder[] = [
  {
    id: "folder-1",
    name: "工作目录",
    created_at: Date.now() - 30000,
    updated_at: Date.now() - 30000,
    scene_count: 1,
  },
];

describe("WorkspaceHome component", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/auth/status")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ authRequired: false, authenticated: true }),
              { status: 200 },
            ),
          );
        }
        if (url.endsWith("/api/scenes")) {
          return Promise.resolve(
            new Response(JSON.stringify(mockScenes), { status: 200 }),
          );
        }
        if (url.endsWith("/api/scenes/trash")) {
          return Promise.resolve(
            new Response(JSON.stringify(mockTrashScenes), { status: 200 }),
          );
        }
        if (url.endsWith("/api/folders")) {
          return Promise.resolve(
            new Response(JSON.stringify(mockFolders), { status: 200 }),
          );
        }
        if (init?.method === "PATCH" && url.includes("/api/scenes/")) {
          const id = decodeURIComponent(url.split("/api/scenes/")[1]);
          const scene = mockScenes.find((item) => item.id === id);
          const body = JSON.parse(String(init.body || "{}")) as {
            name?: string;
            tags?: string[];
            favorite?: boolean;
            folder_id?: string | null;
          };
          return Promise.resolve(
            new Response(
              JSON.stringify({
                ...scene,
                ...body,
                updated_at: Date.now(),
                revision: (scene?.revision || 1) + 1,
                folder_name: body.folder_id === "folder-1" ? "工作目录" : null,
              }),
              { status: 200 },
            ),
          );
        }
        if (url.endsWith("/restore")) {
          return Promise.resolve(
            new Response(JSON.stringify({ success: true, restored: true }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ success: true }), { status: 200 }),
        );
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders scenes, folders, and filters by search query", async () => {
    render(<WorkspaceHome />);

    await waitFor(() => {
      expect(screen.getAllByText("架构设计图").length).toBeGreaterThan(0);
      expect(screen.getAllByText("产品流程图").length).toBeGreaterThan(0);
      expect(screen.getAllByText("工作目录").length).toBeGreaterThan(0);
    });

    const searchInput = screen.getByPlaceholderText("搜索画板");
    fireEvent.change(searchInput, { target: { value: "架构" } });

    expect(screen.getAllByText("架构设计图").length).toBeGreaterThan(0);
    expect(screen.queryByText("产品流程图")).toBeNull();
  });

  it("versions thumbnail URLs with the scene update timestamp", async () => {
    render(<WorkspaceHome />);

    await waitFor(() => {
      expect(screen.getAllByAltText("架构设计图 预览")[0]).toHaveAttribute(
        "src",
        expect.stringContaining(`?v=${mockScenes[0].updated_at}`),
      );
    });
  });

  it("keeps the recent board row inside a safe overflow wrapper", async () => {
    render(<WorkspaceHome />);

    await waitFor(() => {
      expect(document.querySelector(".recent-board-scroller")).not.toBeNull();
    });

    expect(
      document.querySelector(".recent-board-scroller .recent-board-row"),
    ).not.toBeNull();
  });

  it("toggles board favorite state via star button", async () => {
    render(<WorkspaceHome />);

    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: "取消收藏" }).length,
      ).toBeGreaterThan(0);
    });

    const favButton = screen.getAllByRole("button", { name: "取消收藏" })[0];
    fireEvent.click(favButton);

    await waitFor(() => {
      expect(favButton).toHaveAttribute("aria-pressed", "false");
    });
  });

  it("moves a board to trash via direct trash icon button", async () => {
    render(<WorkspaceHome />);

    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: "移至回收站“架构设计图”" })
          .length,
      ).toBeGreaterThan(0);
    });

    const deleteBtn = screen.getAllByRole("button", {
      name: "移至回收站“架构设计图”",
    })[0];
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(screen.queryByText("架构设计图")).toBeNull();
    });
  });

  it("focuses search input when pressing Ctrl+K / ⌘K shortcut", async () => {
    render(<WorkspaceHome />);

    const searchInput = screen.getByPlaceholderText("搜索画板");
    expect(document.activeElement).not.toBe(searchInput);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(document.activeElement).toBe(searchInput);
  });

  it("opens a scene from its title or thumbnail and switches to trash view", async () => {
    const onSelectScene = vi.fn();
    render(<WorkspaceHome onSelectScene={onSelectScene} />);

    await waitFor(() => {
      expect(screen.getAllByText("架构设计图").length).toBeGreaterThan(0);
    });

    // Click the thumbnail to trigger SPA navigation.
    fireEvent.click(screen.getAllByAltText("架构设计图 预览")[0]);
    expect(onSelectScene).toHaveBeenCalledWith("scene-1");

    // Click the board title button to trigger SPA navigation.
    const titleButtons = screen.getAllByRole("button", {
      name: "打开画板“架构设计图”",
    });
    fireEvent.click(titleButtons[0]);
    expect(onSelectScene).toHaveBeenCalledWith("scene-1");

    // Switch to Trash view
    const trashNavButton = screen.getByText("回收站");
    fireEvent.click(trashNavButton);

    await waitFor(() => {
      expect(screen.getAllByText("废弃草稿").length).toBeGreaterThan(0);
      expect(screen.queryByText("架构设计图")).toBeNull();
    });
  });

  it("opens metadata editing directly from the edit icon button", async () => {
    render(<WorkspaceHome />);

    await waitFor(() => {
      expect(
        screen.getAllByRole("button", {
          name: "编辑画板信息“架构设计图”",
        }).length,
      ).toBeGreaterThan(0);
    });

    const editButton = screen.getAllByRole("button", {
      name: "编辑画板信息“架构设计图”",
    })[0];
    fireEvent.click(editButton);

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByDisplayValue("架构设计图")).toBeTruthy();
  });

  it("renders the metadata dialog in the document body after scrolling", async () => {
    render(<WorkspaceHome />);

    await waitFor(() => {
      expect(
        screen.getAllByRole("button", {
          name: "编辑画板信息“架构设计图”",
        }).length,
      ).toBeGreaterThan(0);
    });

    const editButton = screen.getAllByRole("button", {
      name: "编辑画板信息“架构设计图”",
    })[0];
    const workspaceHome = document.querySelector(".workspace-home");
    if (workspaceHome) {
      workspaceHome.scrollTop = 480;
    }
    fireEvent.click(editButton);

    const dialog = screen.getByRole("dialog");
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog).toHaveAttribute("open");
    expect(screen.getByDisplayValue("架构设计图")).toBeVisible();
  });

  it("closes the metadata dialog from the backdrop", async () => {
    render(<WorkspaceHome />);

    await waitFor(() => {
      expect(
        screen.getAllByRole("button", {
          name: "编辑画板信息“架构设计图”",
        }).length,
      ).toBeGreaterThan(0);
    });

    const editButton = screen.getAllByRole("button", {
      name: "编辑画板信息“架构设计图”",
    })[0];
    editButton.focus();
    fireEvent.click(editButton);

    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("updates visible tags after saving board metadata", async () => {
    render(<WorkspaceHome />);

    await waitFor(() => {
      expect(
        screen.getAllByRole("button", {
          name: "编辑画板信息“架构设计图”",
        }).length,
      ).toBeGreaterThan(0);
    });

    const editButton = screen.getAllByRole("button", {
      name: "编辑画板信息“架构设计图”",
    })[0];
    fireEvent.click(editButton);

    fireEvent.change(screen.getByPlaceholderText("用逗号分隔多个标签"), {
      target: { value: "项目, 交付, 复盘, 归档" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存信息" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getAllByText("项目").length).toBeGreaterThan(0);
      expect(screen.getAllByText("+3").length).toBeGreaterThan(0);
    });
  });

  it("supports emptying trash and confirming through custom dialog", async () => {
    render(<WorkspaceHome />);

    // Switch to Trash view
    const trashNavButton = screen.getByText("回收站");
    fireEvent.click(trashNavButton);

    await waitFor(() => {
      expect(screen.getAllByText("废弃草稿").length).toBeGreaterThan(0);
    });

    const emptyTrashButton = screen.getByRole("button", { name: /清空回收站/ });
    expect(emptyTrashButton).not.toBeDisabled();
    fireEvent.click(emptyTrashButton);

    // Confirm dialog is rendered
    await waitFor(() => {
      expect(
        screen.getByText(
          "确定要清空回收站中的所有画板（共 1 个）吗？此操作将永久删除这些画板且无法恢复。",
        ),
      ).toBeTruthy();
    });

    // Click confirm in the dialog
    const confirmButtons = screen.getAllByRole("button", {
      name: "清空回收站",
    });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => {
      expect(screen.queryByText("废弃草稿")).toBeNull();
    });
  });
});
