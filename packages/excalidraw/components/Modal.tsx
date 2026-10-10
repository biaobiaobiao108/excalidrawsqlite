import clsx from "clsx";
import { useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";

import { KEYS } from "@excalidraw/common";

import { useCreatePortalContainer } from "../hooks/useCreatePortalContainer";

import "./Modal.scss";

import type { AppState } from "../types";

export const Modal: React.FC<{
  className?: string;
  children: React.ReactNode;
  maxWidth?: number;
  onCloseRequest(): void;
  labelledBy?: string;
  ariaLabel?: string;
  theme?: AppState["theme"];
  closeOnClickOutside?: boolean;
  nativeTopLayer?: boolean;
}> = (props) => {
  const { closeOnClickOutside = true } = props;
  const nativeDialogRef = useRef<HTMLDialogElement>(null);
  const modalRoot = useCreatePortalContainer({
    className: "excalidraw-modal-container",
  });

  useLayoutEffect(() => {
    if (!props.nativeTopLayer) {
      return;
    }

    const dialog = nativeDialogRef.current;
    if (!dialog || dialog.open) {
      return;
    }

    dialog.showModal();

    return () => {
      if (dialog.open) {
        dialog.close();
      }
    };
  }, [modalRoot, props.nativeTopLayer]);

  const animationsDisabled = useMemo(
    () =>
      modalRoot?.ownerDocument.body.classList.contains(
        "excalidraw-animations-disabled",
      ) ?? false,
    [modalRoot],
  );

  if (!modalRoot) {
    return null;
  }

  const handleKeydown = (event: React.KeyboardEvent) => {
    if (event.key === KEYS.ESCAPE) {
      event.preventDefault();
      event.nativeEvent.stopImmediatePropagation();
      event.stopPropagation();
      props.onCloseRequest();
    }
  };

  const className = clsx("Modal", props.className, {
    "animations-disabled": animationsDisabled,
  });

  const children = (
    <>
      <div
        className="Modal__background"
        onClick={closeOnClickOutside ? props.onCloseRequest : undefined}
      />
      <div
        className="Modal__content"
        style={{ "--max-width": `${props.maxWidth}px` }}
        tabIndex={0}
      >
        {props.children}
      </div>
    </>
  );

  return createPortal(
    props.nativeTopLayer ? (
      <dialog
        ref={nativeDialogRef}
        className={className}
        aria-modal="true"
        aria-labelledby={props.labelledBy}
        aria-label={props.ariaLabel}
        onCancel={(event) => {
          event.preventDefault();
          props.onCloseRequest();
        }}
      >
        {children}
      </dialog>
    ) : (
      <div
        className={className}
        role="dialog"
        aria-modal="true"
        onKeyDown={handleKeydown}
        aria-labelledby={props.labelledBy}
        aria-label={props.ariaLabel}
      >
        {children}
      </div>
    ),
    modalRoot,
  );
};
