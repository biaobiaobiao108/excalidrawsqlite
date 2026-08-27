import React, { useState } from "react";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";

import { verifyAuthPassword } from "../data/cloudStorage";

import "./AuthDialog.scss";
import { WorkspaceDialog } from "./WorkspaceDialog";

interface AuthDialogProps {
  isOpen: boolean;
  onSuccess: () => void;
  onClose?: () => void;
}

export const AuthDialog: React.FC<AuthDialogProps> = ({
  isOpen,
  onSuccess,
  onClose,
}) => {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  if (!isOpen) {
    return null;
  }

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) {
      e.preventDefault();
    }
    if (!password.trim()) {
      setError("请输入访问密码");
      return;
    }
    setIsLoading(true);
    setError("");

    try {
      const ok = await verifyAuthPassword(password.trim());
      if (ok) {
        setPassword("");
        onSuccess();
      } else {
        setError("访问密码错误，请重试");
      }
    } catch {
      setError("连接认证服务失败");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <WorkspaceDialog
      onClose={() => {
        setPassword("");
        onClose?.();
      }}
      title="访问授权验证"
      className="auth-dialog"
    >
      <form onSubmit={handleSubmit} className="auth-dialog-form">
        <p className="auth-dialog-desc">
          当前白板系统已开启私有密码访问保护，请输入访问密码以继续使用与同步数据：
        </p>
        <div className="auth-dialog-input-group">
          <input
          type="password"
          name="password"
          aria-label="访问密码"
          placeholder="请输入访问密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="auth-dialog-input"
            autoFocus
            autoComplete="current-password"
          />
        </div>
        {error && (
          <div className="auth-dialog-error" role="alert">
            {error}
          </div>
        )}
        <div className="auth-dialog-actions">
          <FilledButton
            label={isLoading ? "验证中..." : "确认进入"}
            onClick={handleSubmit}
            size="large"
            className="auth-submit-btn"
          />
        </div>
      </form>
    </WorkspaceDialog>
  );
};
