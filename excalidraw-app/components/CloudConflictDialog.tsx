import React from "react";

import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";

interface CloudConflictDialogProps {
  isOpen: boolean;
  onReload: () => void | Promise<void>;
  onOverwrite: () => void | Promise<void>;
  onDismiss: () => void;
}

export const CloudConflictDialog: React.FC<CloudConflictDialogProps> = ({
  isOpen,
  onReload,
  onOverwrite,
  onDismiss,
}) => {
  if (!isOpen) {
    return null;
  }

  return (
    <Dialog
      title="云端画板发生冲突"
      size="small"
      onCloseRequest={onDismiss}
      closeOnClickOutside={false}
    >
      <p>
        这个画板已在其他设备或标签页更新。请选择保留云端内容，或用当前本地内容覆盖云端版本。
      </p>
      <p style={{ fontSize: "0.85em", opacity: 0.7 }}>
        关闭后会保留本地更改并暂停同步，可点击“处理冲突”再次打开。
      </p>
      <div
        style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}
      >
        <FilledButton
          label="稍后处理"
          onClick={onDismiss}
          variant="outlined"
        />
        <FilledButton
          label="重新加载云端"
          onClick={onReload}
          variant="outlined"
        />
        <FilledButton
          label="以本地内容覆盖"
          onClick={onOverwrite}
          color="danger"
        />
      </div>
    </Dialog>
  );
};
