import React, { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  LockedIconFilled,
  eyeIcon,
  eyeClosedIcon,
} from "@excalidraw/excalidraw/components/icons";

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
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isShaking, setIsShaking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setPassword("");
      setError("");
      setIsShaking(false);
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  const triggerError = (msg: string) => {
    setError(msg);
    setIsShaking(true);
    setTimeout(() => {
      setIsShaking(false);
    }, 500);
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) {
      e.preventDefault();
    }
    if (isLoading) {
      return;
    }
    if (!password.trim()) {
      triggerError("请输入访问密码");
      inputRef.current?.focus();
      return;
    }
    setIsLoading(true);
    setError("");

    try {
      // Only trim for the empty-value check; configured passwords may
      // intentionally contain leading or trailing whitespace.
      const ok = await verifyAuthPassword(password);
      if (ok) {
        setPassword("");
        onSuccess();
      } else {
        triggerError("访问密码错误，请重新输入");
        inputRef.current?.select();
      }
    } catch {
      triggerError("连接认证服务失败，请稍后重试");
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
      className="auth-dialog"
      closable={false}
    >
      <div className="auth-dialog-card">
        <div className="auth-dialog-header">
          <div className="auth-dialog-badge" aria-hidden="true">
            {LockedIconFilled}
          </div>
          <h2 className="auth-dialog-title">访问授权验证</h2>
          <p className="auth-dialog-desc">
            当前白板系统已开启私有访问保护，请输入访问密码以继续使用与同步数据
          </p>
        </div>

        <form onSubmit={handleSubmit} className="auth-dialog-form">
          <div
            className={clsx("auth-dialog-input-group", {
              "is-shaking": isShaking,
            })}
          >
            <input
              ref={inputRef}
              type={showPassword ? "text" : "password"}
              name="password"
              aria-label="访问密码"
              placeholder="请输入访问密码"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (error) {
                  setError("");
                }
              }}
              className={clsx("auth-dialog-input", { "has-error": !!error })}
              autoComplete="current-password"
              disabled={isLoading}
              autoFocus
            />
            <button
              type="button"
              className="auth-dialog-toggle-visibility"
              aria-label={showPassword ? "隐藏密码" : "显示密码"}
              title={showPassword ? "隐藏密码" : "显示密码"}
              onClick={() => setShowPassword(!showPassword)}
              tabIndex={-1}
            >
              {showPassword ? eyeClosedIcon : eyeIcon}
            </button>
          </div>

          {error && (
            <div
              className={clsx("auth-dialog-error", { "is-shaking": isShaking })}
              role="alert"
            >
              <span className="auth-dialog-error-icon" aria-hidden="true">
                ⚠️
              </span>
              <span>{error}</span>
            </div>
          )}

          <div className="auth-dialog-actions">
            <button
              type="submit"
              className="auth-submit-btn"
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <span className="auth-btn-spinner" aria-hidden="true" />
                  <span>验证中...</span>
                </>
              ) : (
                <span>确认进入</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </WorkspaceDialog>
  );
};
