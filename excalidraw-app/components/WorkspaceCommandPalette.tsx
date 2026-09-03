import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { CloudFolder, CloudSceneSummary } from "../data/cloudStorage";
import { WorkspaceDialog } from "./WorkspaceDialog";

import "./WorkspaceCommandPalette.scss";

export type BoardView = "all" | "recent" | "favorites" | "trash";
export type SortMode = "updated" | "opened" | "created";
export type LayoutMode = "grid" | "list";

export interface WorkspaceCommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  scenes: CloudSceneSummary[];
  folders: CloudFolder[];
  trashCount: number;
  currentView: BoardView;
  currentSort: SortMode;
  currentLayout: LayoutMode;
  selectedFolderId: string | null;
  onSelectScene: (scene: CloudSceneSummary, newTab?: boolean) => void;
  onCreateScene: (folderId?: string | null) => void;
  onCreateFolder: () => void;
  onChangeView: (view: BoardView) => void;
  onSelectFolder: (folderId: string | null) => void;
  onChangeSort: (sort: SortMode) => void;
  onToggleLayout: () => void;
  onEmptyTrash: () => void;
  onReload: () => void;
}

interface PaletteCommand {
  id: string;
  category: "常用操作" | "画板" | "视图与筛选" | "显示设置";
  label: string;
  keywords?: string[];
  icon: React.ReactNode;
  shortcut?: string;
  activeBadge?: string;
  meta?: {
    folderName?: string | null;
    tags?: string[];
    timeText?: string;
  };
  perform: (options?: { newTab?: boolean }) => void;
}

type CommandGroup = {
  category: string;
  icon?: React.ReactNode;
  items: PaletteCommand[];
};

const RECENTS_STORAGE_KEY = "excalidraw-workspace-palette-recents";

const loadStoredRecents = (): string[] => {
  try {
    const raw = localStorage.getItem(RECENTS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((id) => typeof id === "string");
      }
    }
  } catch {
    // Ignore storage errors
  }
  return [];
};

const saveStoredRecents = (recents: string[]) => {
  try {
    localStorage.setItem(
      RECENTS_STORAGE_KEY,
      JSON.stringify(recents.slice(0, 5)),
    );
  } catch {
    // Ignore storage errors
  }
};

const normalizeText = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

const formatSceneTime = (timestamp: number | null) => {
  if (!timestamp) {
    return "";
  }
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (sameDay) {
    return `今天 ${time}`;
  }
  return `${date.getMonth() + 1}月${date.getDate()}日`;
};

// SVG Icons matching Excalidraw's look
const historyCommandIcon = (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    stroke="currentColor"
    strokeWidth={1.5}
    fill="none"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M20.984 12.53a9 9 0 1 0 -7.552 8.355" />
    <path d="M12 7v5l3 3" />
    <path d="M19 16l-2 3h4l-2 3" />
  </svg>
);

const searchIcon = (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    stroke="currentColor"
    strokeWidth={2}
    fill="none"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.5" y2="16.5" />
  </svg>
);

const PlusIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const FolderPlusIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3.5 6.5h6l2 2H20.5v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-11Z" />
    <path d="M12 11v6M9 14h6" />
  </svg>
);

const SceneIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
    <path d="M8 2v4M16 2v4M2 10h20" />
  </svg>
);

const RefreshIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M21 2v6h-6" />
    <path d="M3 12a9 9 0 0 1 15.3-6.4L21 8" />
    <path d="M3 22v-6h6" />
    <path d="M21 12a9 9 0 0 1-15.3 6.4L3 16" />
  </svg>
);

const TrashIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
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

const ListIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <line x1="8" y1="6" x2="21" y2="6" />
    <line x1="8" y1="12" x2="21" y2="12" />
    <line x1="8" y1="18" x2="21" y2="18" />
    <line x1="3" y1="6" x2="3.01" y2="6" />
    <line x1="3" y1="12" x2="3.01" y2="12" />
    <line x1="3" y1="18" x2="3.01" y2="18" />
  </svg>
);

const ClockIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="8" />
    <path d="M12 7v5l3 2" />
  </svg>
);

const StarIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="m12 3 2.78 5.63 6.22.9-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.92 1.06-6.2L3 9.53l6.22-.9L12 3Z" />
  </svg>
);

const FolderIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3.5 6.5h6l2 2H20.5v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-11Z" />
  </svg>
);

const SortIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M11 5h10M11 9h7M11 13h4M3 17l3 3 3-3M6 4v16" />
  </svg>
);

const CommandShortcutHint = ({
  shortcut,
  children,
}: {
  shortcut: string;
  children?: React.ReactNode;
}) => {
  const parts = shortcut.replace("++", "+$").split("+");

  return (
    <div className="shortcut">
      {parts.map((item) => (
        <div className="shortcut-wrapper" key={item}>
          <div className="shortcut-key">{item === "$" ? "+" : item}</div>
        </div>
      ))}
      {children && <div className="shortcut-desc">{children}</div>}
    </div>
  );
};

export const WorkspaceCommandPalette: React.FC<WorkspaceCommandPaletteProps> = ({
  isOpen,
  onClose,
  scenes,
  folders,
  trashCount,
  currentView,
  currentSort,
  currentLayout,
  selectedFolderId,
  onSelectScene,
  onCreateScene,
  onCreateFolder,
  onChangeView,
  onSelectFolder,
  onChangeSort,
  onToggleLayout,
  onEmptyTrash,
  onReload,
}) => {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Load recents on initial render / open
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setActiveIndex(0);
      setRecentIds(loadStoredRecents());
      const timer = setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 30);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const recordRecent = useCallback((id: string) => {
    setRecentIds((prev) => {
      const next = [id, ...prev.filter((item) => item !== id)].slice(0, 5);
      saveStoredRecents(next);
      return next;
    });
  }, []);

  const allActions = useMemo<PaletteCommand[]>(() => {
    const selectedFolder = folders.find((f) => f.id === selectedFolderId);
    const defaultSceneLabel = selectedFolder
      ? `新建画板 (当前：${selectedFolder.name})`
      : "新建画板 (根目录)";

    const list: PaletteCommand[] = [
      // 常用操作
      {
        id: "action-create-scene",
        category: "常用操作",
        label: defaultSceneLabel,
        keywords: [
          "xinjian",
          "huaban",
          "create",
          "scene",
          "new",
          "board",
          selectedFolder?.name || "root",
        ],
        icon: <PlusIcon />,
        shortcut: "↵",
        perform: () => {
          recordRecent("action-create-scene");
          onClose();
          onCreateScene(selectedFolderId);
        },
      },
    ];

    for (const folder of folders) {
      list.push({
        id: `action-create-scene-folder-${folder.id}`,
        category: "常用操作",
        label: `在「${folder.name}」中新建画板`,
        keywords: [
          "xinjian",
          "huaban",
          "folder",
          "create",
          "scene",
          "board",
          "new",
          folder.name,
        ],
        icon: <FolderPlusIcon />,
        perform: () => {
          recordRecent(`action-create-scene-folder-${folder.id}`);
          onClose();
          onCreateScene(folder.id);
        },
      });
    }

    list.push(
      {
        id: "action-create-folder",
        category: "常用操作",
        label: "新建文件夹",
        keywords: ["xinjian", "wenjianjia", "create", "folder", "new", "dir"],
        icon: <FolderPlusIcon />,
        perform: () => {
          recordRecent("action-create-folder");
          onClose();
          onCreateFolder();
        },
      },
      {
        id: "action-reload",
        category: "常用操作",
        label: "刷新画板列表",
        keywords: ["shuaxin", "reload", "refresh"],
        icon: <RefreshIcon />,
        perform: () => {
          recordRecent("action-reload");
          onClose();
          onReload();
        },
      },
    );

    if (trashCount > 0) {
      list.push({
        id: "action-empty-trash",
        category: "常用操作",
        label: `清空回收站 (${trashCount})`,
        keywords: ["qingkong", "huishouzhan", "empty", "trash", "clear"],
        icon: <TrashIcon />,
        perform: () => {
          recordRecent("action-empty-trash");
          onClose();
          onEmptyTrash();
        },
      });
    }

    // 视图与筛选
    list.push(
      {
        id: "view-all",
        category: "视图与筛选",
        label: "查看所有画板",
        keywords: ["suoyou", "all", "quanbu"],
        icon: <GridIcon />,
        activeBadge:
          currentView === "all" && !selectedFolderId ? "当前" : undefined,
        perform: () => {
          recordRecent("view-all");
          onClose();
          onChangeView("all");
          onSelectFolder(null);
        },
      },
      {
        id: "view-recent",
        category: "视图与筛选",
        label: "查看最近打开",
        keywords: ["zuijin", "recent", "opened"],
        icon: <ClockIcon />,
        activeBadge: currentView === "recent" ? "当前" : undefined,
        perform: () => {
          recordRecent("view-recent");
          onClose();
          onChangeView("recent");
          onSelectFolder(null);
        },
      },
      {
        id: "view-favorites",
        category: "视图与筛选",
        label: "查看收藏画板",
        keywords: ["shoucang", "favorite", "star"],
        icon: <StarIcon />,
        activeBadge: currentView === "favorites" ? "当前" : undefined,
        perform: () => {
          recordRecent("view-favorites");
          onClose();
          onChangeView("favorites");
          onSelectFolder(null);
        },
      },
      {
        id: "view-trash",
        category: "视图与筛选",
        label: "查看回收站",
        keywords: ["huishouzhan", "trash", "recycle"],
        icon: <TrashIcon />,
        activeBadge: currentView === "trash" ? "当前" : undefined,
        perform: () => {
          recordRecent("view-trash");
          onClose();
          onChangeView("trash");
          onSelectFolder(null);
        },
      },
    );

    for (const folder of folders) {
      list.push({
        id: `folder-${folder.id}`,
        category: "视图与筛选",
        label: `筛选文件夹：${folder.name}`,
        keywords: ["wenjianjia", "folder", folder.name],
        icon: <FolderIcon />,
        activeBadge: selectedFolderId === folder.id ? "当前" : undefined,
        perform: () => {
          recordRecent(`folder-${folder.id}`);
          onClose();
          onChangeView("all");
          onSelectFolder(folder.id);
        },
      });
    }

    // 显示设置
    list.push(
      {
        id: "display-layout",
        category: "显示设置",
        label: currentLayout === "grid" ? "切换为列表视图" : "切换为网格视图",
        keywords: ["qiehuan", "wangge", "liebiao", "layout", "grid", "list"],
        icon: currentLayout === "grid" ? <ListIcon /> : <GridIcon />,
        perform: () => {
          recordRecent("display-layout");
          onClose();
          onToggleLayout();
        },
      },
      {
        id: "sort-updated",
        category: "显示设置",
        label: "按最近修改时间排序",
        keywords: ["xiugai", "paixu", "updated", "sort"],
        icon: <SortIcon />,
        activeBadge: currentSort === "updated" ? "当前" : undefined,
        perform: () => {
          recordRecent("sort-updated");
          onClose();
          onChangeSort("updated");
        },
      },
      {
        id: "sort-opened",
        category: "显示设置",
        label: "按最近打开时间排序",
        keywords: ["dakai", "paixu", "opened", "sort"],
        icon: <SortIcon />,
        activeBadge: currentSort === "opened" ? "当前" : undefined,
        perform: () => {
          recordRecent("sort-opened");
          onClose();
          onChangeSort("opened");
        },
      },
      {
        id: "sort-created",
        category: "显示设置",
        label: "按创建时间排序",
        keywords: ["chuangjian", "paixu", "created", "sort"],
        icon: <SortIcon />,
        activeBadge: currentSort === "created" ? "当前" : undefined,
        perform: () => {
          recordRecent("sort-created");
          onClose();
          onChangeSort("created");
        },
      },
    );

    return list;
  }, [
    trashCount,
    folders,
    currentView,
    selectedFolderId,
    currentLayout,
    currentSort,
    recordRecent,
    onClose,
    onCreateScene,
    onCreateFolder,
    onReload,
    onEmptyTrash,
    onChangeView,
    onSelectFolder,
    onToggleLayout,
    onChangeSort,
  ]);

  // 画板检索列表
  const sceneCommands = useMemo<PaletteCommand[]>(() => {
    return scenes.map((scene) => ({
      id: `scene-${scene.id}`,
      category: "画板",
      label: scene.name || "未命名白板",
      keywords: [scene.name, scene.folder_name || "", ...scene.tags],
      icon: <SceneIcon />,
      meta: {
        folderName: scene.folder_name,
        tags: scene.tags,
        timeText: formatSceneTime(scene.last_opened_at || scene.updated_at),
      },
      perform: ({ newTab } = {}) => {
        recordRecent(`scene-${scene.id}`);
        onClose();
        onSelectScene(scene, newTab);
      },
    }));
  }, [scenes, recordRecent, onClose, onSelectScene]);

  // 全部命令 Map，供最近使用（Recents）反查
  const commandMap = useMemo(() => {
    const map = new Map<string, PaletteCommand>();
    for (const cmd of allActions) {
      map.set(cmd.id, cmd);
    }
    for (const cmd of sceneCommands) {
      map.set(cmd.id, cmd);
    }
    return map;
  }, [allActions, sceneCommands]);

  // 分组命令列表
  const groupedCommands = useMemo<CommandGroup[]>(() => {
    const trimmed = normalizeText(query);

    // 1. 当无搜索词时，展示“最近使用”（如有）+ 常规分组
    if (!trimmed) {
      const groups: CommandGroup[] = [];

      // 提取有效的最近使用命令
      const recentCommands = recentIds
        .map((id) => commandMap.get(id))
        .filter((cmd): cmd is PaletteCommand => Boolean(cmd));

      const recentIdSet = new Set(recentCommands.map((c) => c.id));

      if (recentCommands.length > 0) {
        groups.push({
          category: "最近使用",
          icon: historyCommandIcon,
          items: recentCommands,
        });
      }

      const commonCategories: Array<PaletteCommand["category"]> = [
        "常用操作",
        "画板",
        "视图与筛选",
        "显示设置",
      ];

      for (const cat of commonCategories) {
        if (cat === "画板") {
          const sortedRecentScenes = [...sceneCommands]
            .filter((cmd) => !recentIdSet.has(cmd.id))
            .sort((a, b) => {
              const sceneA = scenes.find((s) => `scene-${s.id}` === a.id);
              const sceneB = scenes.find((s) => `scene-${s.id}` === b.id);
              return (
                (sceneB?.last_opened_at || sceneB?.updated_at || 0) -
                (sceneA?.last_opened_at || sceneA?.updated_at || 0)
              );
            })
            .slice(0, 5);

          if (sortedRecentScenes.length > 0) {
            groups.push({
              category: "画板",
              items: sortedRecentScenes,
            });
          }
        } else {
          const items = allActions.filter(
            (cmd) => cmd.category === cat && !recentIdSet.has(cmd.id),
          );
          if (items.length > 0) {
            groups.push({
              category: cat,
              items,
            });
          }
        }
      }

      return groups;
    }

    // 2. 当有搜索词时，模糊匹配所有指令和画板，按分类组织
    const matches = (cmd: PaletteCommand) => {
      const target = normalizeText(
        [
          cmd.label,
          cmd.category,
          ...(cmd.keywords || []),
          cmd.meta?.folderName || "",
          ...(cmd.meta?.tags || []),
        ].join(" "),
      );
      return target.includes(trimmed);
    };

    const matchedActions = allActions.filter(matches);
    const matchedScenes = sceneCommands.filter(matches);

    const groups: CommandGroup[] = [];
    const categoryOrder: Array<PaletteCommand["category"]> = [
      "常用操作",
      "画板",
      "视图与筛选",
      "显示设置",
    ];

    for (const cat of categoryOrder) {
      const items = [...matchedActions, ...matchedScenes].filter(
        (item) => item.category === cat,
      );
      if (items.length > 0) {
        groups.push({ category: cat, items });
      }
    }
    return groups;
  }, [query, recentIds, commandMap, allActions, sceneCommands, scenes]);

  // 平铺命令列表以进行上下键高亮索引
  const flattenedItems = useMemo(() => {
    return groupedCommands.flatMap((g) => g.items);
  }, [groupedCommands]);

  // 重置 activeIndex 当查询发生变动
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // 滚动聚焦高亮项
  useEffect(() => {
    const el = itemRefs.current[activeIndex];
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  const executeItem = useCallback(
    (item: PaletteCommand, newTab = false) => {
      item.perform({ newTab });
    },
    [],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((prev) =>
          flattenedItems.length === 0 ? 0 : (prev + 1) % flattenedItems.length,
        );
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((prev) =>
          flattenedItems.length === 0
            ? 0
            : (prev - 1 + flattenedItems.length) % flattenedItems.length,
        );
      } else if (event.key === "Enter") {
        event.preventDefault();
        const active = flattenedItems[activeIndex];
        if (active) {
          const isNewTab = event.ctrlKey || event.metaKey;
          executeItem(active, isNewTab);
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    },
    [flattenedItems, activeIndex, executeItem, onClose],
  );

  if (!isOpen) {
    return null;
  }

  let runningIndex = 0;

  return (
    <WorkspaceDialog
      className="workspace-command-palette-dialog"
      onClose={onClose}
      closable
    >
      <div className="palette-dialog-inner">
        <div className="ExcTextField ExcTextField--fullWidth">
          <div className="ExcTextField__input">
            <input
              ref={inputRef}
              type="text"
              value={query}
              placeholder="搜索菜单、命令或画板..."
              aria-label="搜索菜单、命令或画板"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>
        </div>

        <div className="shortcuts-wrapper">
          <CommandShortcutHint shortcut="↑↓">选择</CommandShortcutHint>
          <CommandShortcutHint shortcut="↵">确定</CommandShortcutHint>
          <CommandShortcutHint shortcut="Ctrl+↵">
            新标签打开
          </CommandShortcutHint>
          <CommandShortcutHint shortcut="Esc">关闭</CommandShortcutHint>
        </div>

        <div className="commands" role="listbox">
          {flattenedItems.length === 0 ? (
            <div className="no-match">
              <div className="icon">{searchIcon}</div>
              <span>没有匹配的命令……</span>
            </div>
          ) : (
            groupedCommands.map((group) => (
              <div key={group.category} className="command-category">
                <div className="command-category-title">
                  {group.category}
                  {group.icon && (
                    <div className="icon" style={{ marginLeft: "6px" }}>
                      {group.icon}
                    </div>
                  )}
                </div>
                {group.items.map((item) => {
                  const itemIndex = runningIndex++;
                  const isSelected = itemIndex === activeIndex;

                  return (
                    <button
                      key={`${group.category}-${item.id}`}
                      ref={(el) => {
                        itemRefs.current[itemIndex] = el;
                      }}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      className={`command-item ${
                        isSelected ? "item-selected" : ""
                      }`}
                      onClick={(e) => {
                        const isNewTab =
                          e.ctrlKey || e.metaKey || e.button === 1;
                        executeItem(item, isNewTab);
                      }}
                      onMouseMove={() => setActiveIndex(itemIndex)}
                    >
                      <div className="name">
                        <div className="icon">{item.icon}</div>
                        <span className="label-text">{item.label}</span>
                        {item.meta && (
                          <div className="item-meta">
                            {item.meta.folderName && (
                              <span className="item-folder">
                                <FolderIcon />
                                {item.meta.folderName}
                              </span>
                            )}
                            {item.meta.tags && item.meta.tags.length > 0 && (
                              <span className="item-tag">
                                #{item.meta.tags.join(" #")}
                              </span>
                            )}
                            {item.meta.timeText && (
                              <span className="item-time">
                                {item.meta.timeText}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="item-trailing">
                        {item.activeBadge && (
                          <span className="active-pill">
                            {item.activeBadge}
                          </span>
                        )}
                        {item.shortcut && (
                          <CommandShortcutHint shortcut={item.shortcut} />
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </WorkspaceDialog>
  );
};
