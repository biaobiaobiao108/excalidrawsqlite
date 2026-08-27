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
    thumbnail_file_id: null,
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
      vi.fn().mockImplementation((input: RequestInfo) => {
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

  it("focuses search input when pressing Ctrl+K / ⌘K shortcut", async () => {
    render(<WorkspaceHome />);

    const searchInput = screen.getByPlaceholderText("搜索画板");
    expect(document.activeElement).not.toBe(searchInput);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(document.activeElement).toBe(searchInput);
  });

  it("supports switching to trash view and navigates to scene via onSelectScene", async () => {
    const onSelectScene = vi.fn();
    render(<WorkspaceHome onSelectScene={onSelectScene} />);

    await waitFor(() => {
      expect(screen.getAllByText("架构设计图").length).toBeGreaterThan(0);
    });

    // Click scene card to trigger SPA navigation
    const openButton = screen.getAllByText("架构设计图")[0].closest("button");
    if (openButton) {
      fireEvent.click(openButton);
      expect(onSelectScene).toHaveBeenCalledWith("scene-1");
    }

    // Switch to Trash view
    const trashNavButton = screen.getByText("回收站");
    fireEvent.click(trashNavButton);

    await waitFor(() => {
      expect(screen.getAllByText("废弃草稿").length).toBeGreaterThan(0);
      expect(screen.queryByText("架构设计图")).toBeNull();
    });
  });
});
