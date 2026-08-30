import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { useUIAppState } from "../../context/ui-appState";
import { t } from "../../i18n";
import { useApp } from "../App";
import { Dialog } from "../Dialog";

import MermaidToExcalidraw from "./MermaidToExcalidraw";
import TTDDialogTabs from "./TTDDialogTabs";
import { TTDDialogTabTriggers } from "./TTDDialogTabTriggers";
import { TTDDialogTabTrigger } from "./TTDDialogTabTrigger";
import { TTDDialogTab } from "./TTDDialogTab";

import "./TTDDialog.scss";

import type { MermaidToExcalidrawLibProps, TTDDialogTabType } from "./types";

const LazyOutlineToDiagram = lazy(() => import("./outline/OutlineToDiagram"));

export const TTDDialog = () => {
  const appState = useUIAppState();
  const app = useApp();

  const activeTab: TTDDialogTabType =
    appState.openDialog?.name === "ttd" &&
    appState.openDialog.tab === "mermaid"
      ? "mermaid"
      : "outline";

  const [mermaidToExcalidrawLib, setMermaidToExcalidrawLib] =
    useState<MermaidToExcalidrawLibProps>({
      loaded: false,
      api: null,
    });
  const mermaidApiRef = useRef<MermaidToExcalidrawLibProps["api"]>(null);

  useEffect(() => {
    if (activeTab !== "mermaid" || mermaidApiRef.current) {
      return;
    }

    const api = import("@excalidraw/mermaid-to-excalidraw");
    mermaidApiRef.current = api;
    setMermaidToExcalidrawLib({ loaded: false, api });
    void api.then(
      () => {
        setMermaidToExcalidrawLib({ loaded: true, api });
      },
      () => {
        setMermaidToExcalidrawLib({ loaded: false, api: null });
      },
    );
  }, [activeTab]);

  if (appState.openDialog?.name !== "ttd") {
    return null;
  }

  return (
    <Dialog
      className="ttd-dialog"
      onCloseRequest={() => {
        app.setOpenDialog(null);
      }}
      size={1520}
      title={false}
      ariaLabel={
        activeTab === "mermaid" ? t("mermaid.title") : t("outline.title")
      }
      autofocus={false}
    >
      <TTDDialogTabs dialog="ttd" tab={activeTab}>
        <TTDDialogTabTriggers>
          <TTDDialogTabTrigger tab="outline">
            {t("outline.label")}
          </TTDDialogTabTrigger>
          <TTDDialogTabTrigger tab="mermaid">
            {t("mermaid.label")}
          </TTDDialogTabTrigger>
        </TTDDialogTabTriggers>

        <TTDDialogTab className="ttd-dialog-content" tab="outline">
          <Suspense
            fallback={
              <div className="ttd-dialog-loading" role="status">
                {t("outline.loading") || "正在加载 Markdown 编辑器…"}
              </div>
            }
          >
            <LazyOutlineToDiagram isActive={activeTab === "outline"} />
          </Suspense>
        </TTDDialogTab>
        <TTDDialogTab className="ttd-dialog-content" tab="mermaid">
          <MermaidToExcalidraw
            mermaidToExcalidrawLib={mermaidToExcalidrawLib}
            isActive={activeTab === "mermaid"}
          />
        </TTDDialogTab>
      </TTDDialogTabs>
    </Dialog>
  );
};
