import React, { useCallback, useEffect, useState } from "react";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";

import { TrashIcon } from "@excalidraw/excalidraw/components/icons";

import {
  fetchCloudScenes,
  createCloudScene,
  deleteCloudScene,
  renameCloudScene,
  downloadCloudFullBackup,
  type CloudSceneSummary,
} from "../data/cloudStorage";
import { broadcastCloudSync } from "../data/cloudSync";

import "./CloudScenesDialog.scss";

const EditIcon = (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    stroke="currentColor"
    strokeWidth="2"
    fill="none"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
  </svg>
);

interface CloudScenesDialogProps {
  isOpen: boolean;
  currentSceneId: string | null;
  onClose: () => void;
  onSelectScene: (sceneId: string) => void | Promise<boolean | void>;
  onAuthRequired: () => Promise<boolean>;
  onSceneDeleted: (sceneId: string) => void | Promise<void>;
}

export const CloudScenesDialog: React.FC<CloudScenesDialogProps> = ({
  isOpen,
  currentSceneId,
  onClose,
  onSelectScene,
  onAuthRequired,
  onSceneDeleted,
}) => {
  const [scenes, setScenes] = useState<CloudSceneSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [newSceneName, setNewSceneName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [isExportingBackup, setIsExportingBackup] = useState(false);

  const loadScenes = useCallback(async () => {
    setLoading(true);
    setActionError("");
    let retriedAfterAuth = false;
    try {
      while (true) {
        try {
          const list = await fetchCloudScenes();
          setScenes(list);
          return;
        } catch (err: any) {
          if (
            !retriedAfterAuth &&
            (err.status === 401 || err.code === "AUTH_REQUIRED")
          ) {
            retriedAfterAuth = true;
            if (await onAuthRequired()) {
              continue;
            }
          }
          setActionError(err.message || "加载画板列表失败");
          return;
        }
      }
    } finally {
      setLoading(false);
    }
  }, [onAuthRequired]);

  useEffect(() => {
    if (isOpen) {
      loadScenes();
      setIsCreating(false);
      setEditingId(null);
    }
  }, [isOpen, loadScenes]);

  const handleDownloadBackup = async () => {
    setIsExportingBackup(true);
    setActionError("");
    try {
      const blob = await downloadCloudFullBackup();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `excalidraw-backup-${new Date()
        .toISOString()
        .slice(0, 10)}.tar`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setActionError(err?.message || "导出完整备份失败");
    } finally {
      setIsExportingBackup(false);
    }
  };

  if (!isOpen) {
    return null;
  }

  const handleCreate = async () => {
    if (pendingAction) {
      return;
    }
    const name = newSceneName.trim() || "未命名白板";
    setPendingAction("create");
    setActionError("");
    let retriedAfterAuth = false;
    try {
      while (true) {
        try {
          const created = await createCloudScene({
            name,
            elements: [],
            appState: {},
          });
          setNewSceneName("");
          setIsCreating(false);
          await loadScenes();
          const selected = await onSelectScene(created.id);
          if (selected === false) {
            setActionError("画板已创建，但打开画板失败");
            return;
          }
          onClose();
          return;
        } catch (err: any) {
          if (
            !retriedAfterAuth &&
            (err.status === 401 || err.code === "AUTH_REQUIRED")
          ) {
            retriedAfterAuth = true;
            if (await onAuthRequired()) {
              continue;
            }
          }
          setActionError(err.message || "创建画板失败");
          return;
        }
      }
    } finally {
      setPendingAction(null);
    }
  };

  const handleRename = async (id: string) => {
    if (!editingName.trim()) {
      setEditingId(null);
      return;
    }
    if (pendingAction) {
      return;
    }
    setPendingAction(`rename:${id}`);
    setActionError("");
    let retriedAfterAuth = false;
    try {
      while (true) {
        try {
          const scene = scenes.find((item) => item.id === id);
          const nextRevision = (scene?.revision || 1) + 1;
          await renameCloudScene(id, editingName.trim(), scene?.revision);
          setEditingId(null);
          broadcastCloudSync({
            type: "scene_renamed",
            sceneId: id,
            name: editingName.trim(),
            revision: nextRevision,
          });
          if (currentSceneId === id) {
            // Refresh the scene so the save queue observes the new revision and
            // the current canvas receives the renamed app state without clearing
            // its elements.
            await onSelectScene(id);
          }
          await loadScenes();
          return;
        } catch (err: any) {
          if (
            !retriedAfterAuth &&
            (err.status === 401 || err.code === "AUTH_REQUIRED")
          ) {
            retriedAfterAuth = true;
            if (await onAuthRequired()) {
              continue;
            }
          }
          setActionError(err.message || "重命名画板失败");
          return;
        }
      }
    } finally {
      setPendingAction(null);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`确定要删除画板 "${name}" 吗？该操作无法恢复。`)) {
      return;
    }
    if (pendingAction) {
      return;
    }
    setPendingAction(`delete:${id}`);
    setActionError("");
    let retriedAfterAuth = false;
    try {
      while (true) {
        try {
          await deleteCloudScene(id);
          broadcastCloudSync({
            type: "scene_deleted",
            sceneId: id,
          });
          await loadScenes();
          if (currentSceneId === id) {
            await onSceneDeleted(id);
          }
          return;
        } catch (err: any) {
          if (
            !retriedAfterAuth &&
            (err.status === 401 || err.code === "AUTH_REQUIRED")
          ) {
            retriedAfterAuth = true;
            if (await onAuthRequired()) {
              continue;
            }
          }
          setActionError(err.message || "删除画板失败");
          return;
        }
      }
    } finally {
      setPendingAction(null);
    }
  };

  const handleOpen = async (id: string) => {
    if (pendingAction) {
      return;
    }
    setPendingAction(`open:${id}`);
    setActionError("");
    try {
      const selected = await onSelectScene(id);
      if (selected !== false) {
        onClose();
      }
    } catch (error: any) {
      setActionError(error?.message || "打开画板失败");
    } finally {
      setPendingAction(null);
    }
  };

  const filteredScenes = scenes.filter((s) =>
    s.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const formatDate = (timestamp: number) => {
    const d = new Date(timestamp);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
      d.getDate(),
    )} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  return (
    <Dialog
      onCloseRequest={onClose}
      title="我的云端画板 (SQLite 持久化)"
      className="cloud-scenes-dialog"
      size="regular"
    >
      <div className="cloud-scenes-container">
        <div className="cloud-scenes-header">
          <input
            type="text"
            placeholder="搜索画板名称..."
            aria-label="搜索画板名称"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="cloud-scenes-search"
          />
          {!isCreating && (
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <FilledButton
                label="新建画板"
                onClick={() => {
                  setNewSceneName("未命名白板");
                  setIsCreating(true);
                }}
                size="medium"
                className="create-btn"
                disabled={!!pendingAction || isExportingBackup}
              />
              <FilledButton
                label={isExportingBackup ? "导出中..." : "导出完整备份"}
                onClick={() => void handleDownloadBackup()}
                size="medium"
                variant="outlined"
                className="backup-btn"
                disabled={!!pendingAction || isExportingBackup}
              />
            </div>
          )}
        </div>

        {actionError && (
          <div className="cloud-scenes-error" role="alert">
            {actionError}
          </div>
        )}

        {isCreating && (
          <form
            className="create-scene-row"
            onSubmit={(event) => {
              event.preventDefault();
              void handleCreate();
            }}
          >
            <input
              type="text"
              placeholder="输入新画板名称..."
              aria-label="新画板名称"
              name="sceneName"
              required
              maxLength={120}
              autoComplete="off"
              value={newSceneName}
              onChange={(e) => setNewSceneName(e.target.value)}
              className="create-scene-input"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleCreate();
                }
                if (e.key === "Escape") {
                  setIsCreating(false);
                }
              }}
            />
            <button
              className="btn-confirm"
              type="submit"
              disabled={!!pendingAction}
              aria-busy={pendingAction === "create"}
            >
              {pendingAction === "create" ? "创建中..." : "创建"}
            </button>
            <button
              className="btn-cancel"
              type="button"
              onClick={() => setIsCreating(false)}
              disabled={!!pendingAction}
            >
              取消
            </button>
          </form>
        )}

        <div className="cloud-scenes-list">
          {loading ? (
            <div className="cloud-scenes-empty">正在加载画板列表...</div>
          ) : filteredScenes.length === 0 ? (
            <div className="cloud-scenes-empty">
              {searchQuery
                ? "未找到匹配的画板"
                : "暂无已保存的云端画板，点击上方新建"}
            </div>
          ) : (
            filteredScenes.map((scene) => {
              const isCurrent = scene.id === currentSceneId;
              const isEditing = scene.id === editingId;

              return (
                <div
                  key={scene.id}
                  className={`scene-card ${isCurrent ? "active" : ""}`}
                >
                  <div className="scene-info">
                    {isEditing ? (
                      <input
                        type="text"
                        value={editingName}
                        aria-label="画板名称"
                        maxLength={120}
                        autoComplete="off"
                        onChange={(e) => setEditingName(e.target.value)}
                        onBlur={() => handleRename(scene.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            e.currentTarget.blur();
                          }
                          if (e.key === "Escape") {
                            setEditingId(null);
                          }
                        }}
                        autoFocus
                        className="rename-input"
                        disabled={pendingAction === `rename:${scene.id}`}
                      />
                    ) : (
                      <span
                        className="scene-name"
                        title={`画板：“${scene.name || "未命名白板"}”`}
                        onClick={() => {
                          void handleOpen(scene.id);
                        }}
                      >
                        <span className="scene-name-text">
                          {scene.name || "未命名白板"}
                        </span>
                        {isCurrent && (
                          <span className="current-badge">当前使用</span>
                        )}
                      </span>
                    )}
                    <div className="scene-meta-row">
                      <span
                        className="scene-elements-count"
                        title={`包含 ${scene.element_count ?? 0} 个图元`}
                      >
                        {scene.element_count ?? 0} 个图元
                      </span>
                      <span className="meta-separator" aria-hidden="true">
                        •
                      </span>
                      <span className="scene-time">
                        更新于: {formatDate(scene.updated_at)}
                      </span>
                    </div>
                  </div>

                  <div className="scene-actions">
                    <button
                      className="action-btn open-btn"
                      onClick={() => void handleOpen(scene.id)}
                      title="打开画板"
                      disabled={!!pendingAction}
                      aria-busy={pendingAction === `open:${scene.id}`}
                    >
                      {pendingAction === `open:${scene.id}`
                        ? "打开中..."
                        : "打开"}
                    </button>
                    <button
                      className="action-btn icon-btn"
                      onClick={() => {
                        setEditingId(scene.id);
                        setEditingName(scene.name);
                      }}
                      title="重命名"
                      disabled={!!pendingAction}
                    >
                      {EditIcon}
                    </button>
                    <button
                      className="action-btn icon-btn delete-btn"
                      onClick={() => handleDelete(scene.id, scene.name)}
                      title="删除画板"
                      disabled={!!pendingAction}
                    >
                      {TrashIcon}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </Dialog>
  );
};
