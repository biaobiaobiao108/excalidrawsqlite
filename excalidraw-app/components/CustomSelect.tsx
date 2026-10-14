import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import "./CustomSelect.scss";

export type CustomSelectOption = {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
};

type CustomSelectProps = {
  value: string;
  options: readonly CustomSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  menuPlacement?: "bottom" | "top";
  mobileSheet?: boolean;
  mobileTitle?: string;
  size?: "compact" | "field" | "language";
  style?: React.CSSProperties;
};

const ChevronIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="m4 6 4 4 4-4" />
  </svg>
);

const CheckIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="m3.5 8.25 2.75 2.75L12.5 4.75" />
  </svg>
);

type MenuPosition = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: "bottom" | "top";
};

const MENU_VIEWPORT_PADDING = 8;
const MENU_GAP = 6;
const MENU_MAX_HEIGHT = 256;

export const CustomSelect = ({
  value,
  options,
  onChange,
  ariaLabel,
  className = "",
  disabled = false,
  menuPlacement = "bottom",
  mobileSheet = false,
  mobileTitle,
  size = "compact",
  style,
}: CustomSelectProps) => {
  const [open, setOpen] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const listboxId = useId();
  const useMobileSheet = mobileSheet && isMobileViewport;

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedOption = options[selectedIndex];
  const highlightedOption = options[highlightedIndex];

  useEffect(() => {
    if (!mobileSheet) {
      return;
    }
    const ownerWindow = rootRef.current?.ownerDocument.defaultView;
    if (!ownerWindow) {
      return;
    }
    const media = ownerWindow.matchMedia("(max-width: 720px)");
    const updateViewport = () => setIsMobileViewport(media.matches);
    updateViewport();
    media.addEventListener("change", updateViewport);
    return () => media.removeEventListener("change", updateViewport);
  }, [mobileSheet]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const ownerDocument = rootRef.current?.ownerDocument;
    if (!ownerDocument) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target) &&
        !menuRef.current?.contains(event.target) &&
        !sheetRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };

    ownerDocument.addEventListener("pointerdown", handlePointerDown);
    return () => {
      ownerDocument.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || useMobileSheet) {
      setMenuPosition(null);
      return;
    }

    const trigger = triggerRef.current;
    const menu = menuRef.current;
    const ownerDocument = rootRef.current?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (!trigger || !menu || !ownerWindow) {
      return;
    }

    const updatePosition = () => {
      const triggerRect = trigger.getBoundingClientRect();
      const viewportWidth = ownerDocument.documentElement.clientWidth ||
        ownerWindow.innerWidth;
      const viewportHeight = ownerDocument.documentElement.clientHeight ||
        ownerWindow.innerHeight;
      const availableAbove = Math.max(
        0,
        triggerRect.top - MENU_GAP - MENU_VIEWPORT_PADDING,
      );
      const availableBelow = Math.max(
        0,
        viewportHeight - triggerRect.bottom - MENU_GAP - MENU_VIEWPORT_PADDING,
      );
      const desiredHeight = Math.min(menu.scrollHeight, MENU_MAX_HEIGHT);
      let placement = menuPlacement;

      if (
        (placement === "bottom" &&
          availableBelow < desiredHeight &&
          availableAbove > availableBelow) ||
        (placement === "top" &&
          availableAbove < desiredHeight &&
          availableBelow > availableAbove)
      ) {
        placement = placement === "bottom" ? "top" : "bottom";
      }

      const availableHeight =
        placement === "top" ? availableAbove : availableBelow;
      const maxHeight = Math.min(MENU_MAX_HEIGHT, availableHeight);
      const renderedHeight = Math.min(menu.scrollHeight, maxHeight);
      const width = Math.min(
        triggerRect.width,
        Math.max(0, viewportWidth - MENU_VIEWPORT_PADDING * 2),
      );
      const left = Math.min(
        Math.max(triggerRect.left, MENU_VIEWPORT_PADDING),
        Math.max(
          MENU_VIEWPORT_PADDING,
          viewportWidth - MENU_VIEWPORT_PADDING - width,
        ),
      );
      const top = placement === "top"
        ? triggerRect.top - MENU_GAP - renderedHeight
        : triggerRect.bottom + MENU_GAP;

      setMenuPosition((previous) => {
        if (
          previous?.top === top &&
          previous.left === left &&
          previous.width === width &&
          previous.maxHeight === maxHeight &&
          previous.placement === placement
        ) {
          return previous;
        }
        return { top, left, width, maxHeight, placement };
      });
    };

    updatePosition();
    const animationFrame = ownerWindow.requestAnimationFrame(updatePosition);
    ownerWindow.addEventListener("resize", updatePosition);
    ownerWindow.addEventListener("scroll", updatePosition, true);
    ownerWindow.visualViewport?.addEventListener("resize", updatePosition);
    ownerWindow.visualViewport?.addEventListener("scroll", updatePosition);

    return () => {
      ownerWindow.cancelAnimationFrame(animationFrame);
      ownerWindow.removeEventListener("resize", updatePosition);
      ownerWindow.removeEventListener("scroll", updatePosition, true);
      ownerWindow.visualViewport?.removeEventListener("resize", updatePosition);
      ownerWindow.visualViewport?.removeEventListener("scroll", updatePosition);
    };
  }, [open, menuPlacement, options.length, useMobileSheet]);

  useLayoutEffect(() => {
    if (open && useMobileSheet && highlightedIndex >= 0) {
      optionRefs.current[highlightedIndex]?.focus();
    }
  }, [highlightedIndex, open, useMobileSheet]);

  useEffect(() => {
    if (!open || !useMobileSheet) {
      return;
    }
    const ownerDocument = rootRef.current?.ownerDocument;
    if (!ownerDocument) {
      return;
    }
    const previousOverflow = ownerDocument.body.style.overflow;
    ownerDocument.body.style.overflow = "hidden";
    return () => {
      ownerDocument.body.style.overflow = previousOverflow;
    };
  }, [open, useMobileSheet]);

  const focusTrigger = () => {
    triggerRef.current?.focus();
  };

  const closeMenu = () => {
    setOpen(false);
    focusTrigger();
  };

  const findNextEnabledIndex = (startIndex: number, direction: 1 | -1) => {
    if (!options.length) {
      return -1;
    }

    for (let offset = 1; offset <= options.length; offset += 1) {
      const index =
        (startIndex + offset * direction + options.length) % options.length;
      if (!options[index].disabled) {
        return index;
      }
    }

    return -1;
  };

  const findBoundaryEnabledIndex = (fromEnd: boolean) => {
    const indexes = options.map((option, index) => ({ option, index }));
    const boundary = fromEnd ? indexes.reverse() : indexes;
    return boundary.find(({ option }) => !option.disabled)?.index ?? -1;
  };

  const openMenu = (initialIndex = selectedIndex) => {
    setHighlightedIndex(
      initialIndex >= 0 && !options[initialIndex]?.disabled
        ? initialIndex
        : findBoundaryEnabledIndex(false),
    );
    setOpen(true);
  };

  const selectOption = (option: CustomSelectOption) => {
    if (option.disabled) {
      return;
    }
    onChange(option.value);
    closeMenu();
  };

  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      setHighlightedIndex(
        findNextEnabledIndex(
          highlightedIndex >= 0 ? highlightedIndex : selectedIndex,
          1,
        ),
      );
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      setHighlightedIndex(
        findNextEnabledIndex(
          highlightedIndex >= 0 ? highlightedIndex : selectedIndex,
          -1,
        ),
      );
      return;
    }

    if (event.key === "Home" && open) {
      event.preventDefault();
      setHighlightedIndex(findBoundaryEnabledIndex(false));
      return;
    }

    if (event.key === "End" && open) {
      event.preventDefault();
      setHighlightedIndex(findBoundaryEnabledIndex(true));
      return;
    }

    if ((event.key === "Enter" || event.key === " ") && open) {
      event.preventDefault();
      if (highlightedOption) {
        selectOption(highlightedOption);
      }
      return;
    }

    if (event.key === "Escape" && open) {
      event.preventDefault();
      closeMenu();
    }
  };

  const handleOptionKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setHighlightedIndex(findNextEnabledIndex(index, direction));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setHighlightedIndex(findBoundaryEnabledIndex(event.key === "End"));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (options[index]) {
        selectOption(options[index]);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
    }
  };

  const portalTarget =
    rootRef.current?.closest("dialog") || rootRef.current?.ownerDocument.body;
  const optionList = (
    <div
      ref={menuRef}
      id={listboxId}
      className={`custom-select__menu custom-select__menu--${
        menuPosition?.placement || menuPlacement
      } ${useMobileSheet ? "custom-select__menu--sheet" : ""}`.trim()}
      role="listbox"
      aria-label={ariaLabel}
      aria-hidden={!useMobileSheet && !menuPosition}
      style={useMobileSheet ? undefined : {
        top: menuPosition?.top ?? 0,
        left: menuPosition?.left ?? 0,
        width: menuPosition?.width ?? 0,
        maxHeight: menuPosition?.maxHeight ?? 0,
        visibility: menuPosition ? "visible" : "hidden",
      }}
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(element) => { optionRefs.current[index] = element; }}
          id={`${listboxId}-option-${option.value}`}
          type="button"
          role="option"
          tabIndex={useMobileSheet && index === highlightedIndex ? 0 : -1}
          aria-selected={option.value === value}
          className={`custom-select__option ${
            option.value === value ? "is-selected" : ""
          } ${
            index === highlightedIndex ? "is-highlighted" : ""
          }`.trim()}
          disabled={option.disabled}
          onMouseEnter={() => setHighlightedIndex(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => selectOption(option)}
          onKeyDown={(event) => handleOptionKeyDown(event, index)}
        >
          <span className="custom-select__option-label">
            {option.label}
          </span>
          {option.value === value && (
            <span className="custom-select__check">
              <CheckIcon />
            </span>
          )}
        </button>
      ))}
    </div>
  );
  const menu = open && options.length > 0 && (useMobileSheet ? (
    <div
      ref={sheetRef}
      className="custom-select__mobile-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          closeMenu();
        }
      }}
    >
      <section
        className="custom-select__mobile-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={mobileTitle || ariaLabel}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            closeMenu();
          } else if (event.key === "Tab") {
            const first = closeButtonRef.current;
            const last = optionRefs.current[highlightedIndex];
            if (
              event.shiftKey && event.target === first && last
            ) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && event.target === last && first) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div className="custom-select__mobile-handle" aria-hidden="true" />
        <div className="custom-select__mobile-heading">
          <h2>{mobileTitle || ariaLabel}</h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="custom-select__mobile-close"
            aria-label="关闭"
            onClick={closeMenu}
          >
            ×
          </button>
        </div>
        {optionList}
      </section>
    </div>
  ) : optionList);

  return (
    <div
      ref={rootRef}
      className={`custom-select custom-select--${size} ${
        open ? "custom-select--open" : ""
      } ${className}`.trim()}
      style={style}
    >
      <button
        ref={triggerRef}
        type="button"
        className="custom-select__trigger"
        aria-label={ariaLabel}
        aria-haspopup={useMobileSheet ? "dialog" : "listbox"}
        aria-expanded={open}
        aria-controls={listboxId}
        disabled={disabled}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="custom-select__label">
          {selectedOption?.label ?? value}
        </span>
        <span className="custom-select__chevron">
          <ChevronIcon />
        </span>
      </button>
      {menu && portalTarget ? createPortal(menu, portalTarget) : null}
    </div>
  );
};
