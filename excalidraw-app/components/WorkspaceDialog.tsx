import React, { useLayoutEffect, useRef } from "react";

import "./WorkspaceHome.scss";

const FOCUSABLE_SELECTOR =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

interface WorkspaceDialogProps {
  title?: string;
  onClose?: () => void;
  children: React.ReactNode;
  className?: string;
  closable?: boolean;
}

export const WorkspaceDialog = ({
  title,
  onClose,
  children,
  className,
  closable = true,
}: WorkspaceDialogProps) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const content = contentRef.current;
    const ownerDocument = dialog?.ownerDocument;
    if (!dialog || !content || !ownerDocument) {
      return;
    }

    const previousFocus = ownerDocument.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        content.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => element.offsetParent !== null);

    const initialFocus = content.querySelector<HTMLElement>("[autofocus]");
    (initialFocus || focusable()[0] || content).focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (closable) {
          event.preventDefault();
          onCloseRef.current?.();
        }
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const elements = focusable();
      if (!elements.length) {
        event.preventDefault();
        content.focus();
        return;
      }
      const currentIndex = elements.indexOf(
        ownerDocument.activeElement as HTMLElement,
      );
      if (event.shiftKey && (currentIndex <= 0 || currentIndex === -1)) {
        event.preventDefault();
        elements[elements.length - 1].focus();
      } else if (
        !event.shiftKey &&
        (currentIndex === elements.length - 1 || currentIndex === -1)
      ) {
        event.preventDefault();
        elements[0].focus();
      }
    };

    dialog.addEventListener("keydown", handleKeyDown);
    return () => {
      dialog.removeEventListener("keydown", handleKeyDown);
      if (previousFocus?.isConnected) {
        previousFocus.focus();
      }
    };
  }, [closable]);

  const titleId = "workspace-dialog-title";
  return (
    <div
      ref={dialogRef}
      className={`workspace-dialog${className ? ` ${className}` : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
    >
      {closable ? (
        <button
          type="button"
          className="workspace-dialog-backdrop"
          aria-label="关闭弹窗"
          onClick={onClose}
        />
      ) : (
        <div className="workspace-dialog-backdrop workspace-dialog-backdrop--locked" />
      )}
      <div
        ref={contentRef}
        className="workspace-dialog-content-shell"
        tabIndex={-1}
      >
        {title ? (
          <h2 id={titleId} className="workspace-dialog-title">
            {title}
          </h2>
        ) : null}
        <div className="workspace-dialog-form-content">{children}</div>
      </div>
    </div>
  );
};
