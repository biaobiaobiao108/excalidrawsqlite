import React, { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
  const portalAnchorRef = useRef<HTMLSpanElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const ownerDocument = portalAnchorRef.current?.ownerDocument;
    if (ownerDocument?.body) {
      setPortalTarget(ownerDocument.body);
    }
  }, []);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const content = contentRef.current;
    const ownerDocument = dialog?.ownerDocument;
    if (!dialog || !content || !ownerDocument) {
      return;
    }

    const previousFocus = ownerDocument.activeElement as HTMLElement | null;

    if (!dialog.open) {
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        // jsdom does not implement the dialog API. The open attribute keeps
        // the component testable while production browsers use showModal().
        dialog.setAttribute("open", "");
      }
    }

    const closeDialog = () => {
      if (typeof dialog.close === "function") {
        dialog.close();
      } else {
        dialog.removeAttribute("open");
        onCloseRef.current?.();
      }
    };

    const initialFocus = content.querySelector<HTMLElement>("[autofocus]");
    const firstFocusable =
      content.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (initialFocus || firstFocusable || content).focus();

    const handleCancel = (event: Event) => {
      if (!closable) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      closeDialog();
    };

    const handleBackdropClick = (event: MouseEvent) => {
      if (closable && event.target === dialog) {
        closeDialog();
      }
    };

    const handleClose = () => onCloseRef.current?.();

    dialog.addEventListener("cancel", handleCancel);
    dialog.addEventListener("click", handleBackdropClick);
    dialog.addEventListener("close", handleClose);

    return () => {
      dialog.removeEventListener("cancel", handleCancel);
      dialog.removeEventListener("click", handleBackdropClick);
      dialog.removeEventListener("close", handleClose);
      if (dialog.open && typeof dialog.close === "function") {
        dialog.close();
      }
      if (previousFocus?.isConnected) {
        previousFocus.focus();
      }
    };
  }, [closable, portalTarget]);

  if (!portalTarget) {
    return <span ref={portalAnchorRef} hidden aria-hidden="true" />;
  }

  return createPortal(
    <dialog
      ref={dialogRef}
      className={`workspace-dialog${className ? ` ${className}` : ""}`}
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : "对话框"}
    >
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
    </dialog>,
    portalTarget,
  );
};
