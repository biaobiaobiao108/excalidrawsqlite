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
  size = "compact",
  style,
}: CustomSelectProps) => {
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const listboxId = useId();

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedOption = options[selectedIndex];
  const highlightedOption = options[highlightedIndex];

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
        !menuRef.current?.contains(event.target)
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
    if (!open) {
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
      const isMobileViewport = viewportWidth <= 720;
      const maxMenuHeight = isMobileViewport
        ? Math.min(420, Math.round(viewportHeight * 0.62))
        : MENU_MAX_HEIGHT;
      const width = Math.min(
        isMobileViewport
          ? viewportWidth - MENU_VIEWPORT_PADDING * 2
          : triggerRect.width,
        Math.max(0, viewportWidth - MENU_VIEWPORT_PADDING * 2),
      );
      // Measure after applying the mobile width so wrapped long names have
      // their real height before choosing whether the menu opens above/below.
      menu.style.width = `${width}px`;
      const availableAbove = Math.max(
        0,
        triggerRect.top - MENU_GAP - MENU_VIEWPORT_PADDING,
      );
      const availableBelow = Math.max(
        0,
        viewportHeight - triggerRect.bottom - MENU_GAP - MENU_VIEWPORT_PADDING,
      );
      const desiredHeight = Math.min(menu.scrollHeight, maxMenuHeight);
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
      const maxHeight = Math.min(maxMenuHeight, availableHeight);
      const renderedHeight = Math.min(menu.scrollHeight, maxHeight);
      const left = isMobileViewport
        ? (viewportWidth - width) / 2
        : Math.min(
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
  }, [open, menuPlacement, options.length]);

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

  const portalTarget =
    rootRef.current?.closest("dialog") || rootRef.current?.ownerDocument.body;
  const menu = open && options.length > 0 && (
    <div
      ref={menuRef}
      id={listboxId}
      className={`custom-select__menu custom-select__menu--${
        menuPosition?.placement || menuPlacement
      }`}
      role="listbox"
      aria-label={ariaLabel}
      aria-hidden={!menuPosition}
      style={{
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
          id={`${listboxId}-option-${option.value}`}
          type="button"
          role="option"
          tabIndex={-1}
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
        aria-haspopup="listbox"
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
