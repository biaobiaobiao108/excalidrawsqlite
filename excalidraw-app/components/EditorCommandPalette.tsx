import { lazy, Suspense } from "react";
import { DEFAULT_CATEGORIES } from "@excalidraw/excalidraw/components/CommandPalette/constants";
import { t } from "@excalidraw/excalidraw/i18n";
import { clearPwaEvent, getPwaEvent } from "../app-pwa";

const LazyCommandPalette = lazy(async () => {
  const { CommandPalette } =
    await import("@excalidraw/excalidraw/components/CommandPalette/CommandPalette");
  return { default: CommandPalette };
});

type EditorCommandPaletteProps = {
  onNavigateHome: () => void;
};

export const EditorCommandPalette = ({
  onNavigateHome,
}: EditorCommandPaletteProps) => (
  <Suspense fallback={null}>
    <LazyCommandPalette
      customCommandPaletteItems={[
        {
          label: "返回至主页",
          category: DEFAULT_CATEGORIES.app,
          predicate: true,
          icon: (
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              stroke="currentColor"
              strokeWidth="2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
          ),
          keywords: [
            "home",
            "zhuye",
            "fanhuizhuye",
            "return",
            "cloud",
            "scene",
            "board",
            "sqlite",
            "画板",
            "主页",
            "云端",
            "返回",
          ],
          perform: onNavigateHome,
        },
        {
          label: t("labels.installPWA"),
          category: DEFAULT_CATEGORIES.app,
          predicate: () => !!getPwaEvent(),
          perform: () => {
            const event = getPwaEvent();
            if (event) {
              event.prompt();
              event.userChoice.then(() => {
                // event cannot be reused, but we’ll hopefully
                // grab new one as the event should be fired again
                clearPwaEvent();
              });
            }
          },
        },
      ]}
    />
  </Suspense>
);
