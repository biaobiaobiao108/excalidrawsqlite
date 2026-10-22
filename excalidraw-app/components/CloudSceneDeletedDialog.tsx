import React from "react";

import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";

interface CloudSceneDeletedDialogProps {
  isOpen: boolean;
  sceneName: string;
  isRecovering: boolean;
  onRecover: () => void | Promise<void>;
  onDiscard: () => void;
}

export const CloudSceneDeletedDialog: React.FC<CloudSceneDeletedDialogProps> = ({
  isOpen,
  sceneName,
  isRecovering,
  onRecover,
  onDiscard,
}) => {
  if (!isOpen) {
    return null;
  }

  return (
    <Dialog
      title="画板已删除，本地更改仍可恢复"
      size="small"
      onCloseRequest={() => undefined}
      closeOnClickOutside={false}
    >
      <p>“{sceneName}”还有未同步的本地更改。</p>
      <div
        style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}
      >
        <FilledButton
          label="丢弃本地更改"
          onClick={onDiscard}
          variant="outlined"
          disabled={isRecovering}
        />
        <FilledButton
          label={isRecovering ? "正在恢复…" : "恢复为新画板"}
          onClick={onRecover}
          disabled={isRecovering}
        />
      </div>
    </Dialog>
  );
};
