import type { CloudSaveStatus } from "../data/cloudSync";

type EditorTopRightUIProps = {
  isMobile: boolean;
  currentSceneId: string | null;
  cloudSaveStatus: CloudSaveStatus;
  hasOtherDraft: boolean;
  onSave: () => void;
  onOpenDrafts: () => void;
  onOpenConflict: () => void;
  onNavigateHome: () => void;
};

export const EditorTopRightUI = ({
  isMobile,
  currentSceneId,
  cloudSaveStatus,
  hasOtherDraft,
  onSave,
  onOpenDrafts,
  onOpenConflict,
  onNavigateHome,
}: EditorTopRightUIProps) => {
  const isCloudSaveBusy =
    cloudSaveStatus === "saving" || cloudSaveStatus === "auth";
  const cloudSaveLabel =
    cloudSaveStatus === "conflict"
      ? "处理冲突"
      : cloudSaveStatus === "saving"
        ? "保存中..."
        : cloudSaveStatus === "error"
          ? "重试保存"
          : cloudSaveStatus === "saved"
            ? "已保存"
            : isMobile
              ? "保存"
              : "保存到云端";

  return (
    <div className="excalidraw-ui-top-right">
      {hasOtherDraft && (
        <button
          type="button"
          className="cloud-scenes-top-btn cloud-drafts-top-btn"
          onClick={onOpenDrafts}
        >
          草稿
        </button>
      )}
      <button
        type="button"
        className="cloud-save-top-btn"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          background: "var(--brand-primary, #315f4c)",
          border: "1px solid var(--brand-primary, #315f4c)",
          borderRadius: "8px",
          padding: "6px 12px",
          fontSize: "0.85rem",
          fontWeight: 500,
          cursor:
            !currentSceneId || isCloudSaveBusy ? "not-allowed" : "pointer",
          color: "#fff",
          height: "36px",
          opacity: !currentSceneId || isCloudSaveBusy ? 0.65 : 1,
        }}
        disabled={!currentSceneId || isCloudSaveBusy}
        aria-busy={cloudSaveStatus === "saving"}
        onClick={() => {
          if (cloudSaveStatus === "conflict") {
            onOpenConflict();
          } else {
            onSave();
          }
        }}
        title={
          cloudSaveStatus === "conflict"
            ? "处理云端保存冲突"
            : "将当前白板保存到云端"
        }
      >
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
          <path d="M12 16V4" />
          <path d="m7 9 5-5 5 5" />
          <path d="M5 20h14" />
        </svg>
        {cloudSaveLabel}
      </button>
      <button
        type="button"
        className="cloud-scenes-top-btn"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          background: "var(--surface-panel, #f7f6f1)",
          border: "1px solid var(--border-subtle, #e7e5dd)",
          borderRadius: "8px",
          padding: "6px 12px",
          fontSize: "0.85rem",
          fontWeight: 500,
          cursor: "pointer",
          color: "var(--text-primary, #1f2622)",
          height: "36px",
        }}
        onClick={onNavigateHome}
        title="管理我的云端画板"
      >
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
          <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
        </svg>
        我的画板
      </button>
    </div>
  );
};
