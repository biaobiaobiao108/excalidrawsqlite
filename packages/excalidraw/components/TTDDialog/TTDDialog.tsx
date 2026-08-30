import { lazy, Suspense, useEffect, useState } from "react";

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

  const [mermaidToExcalidrawLib, setMermaidToExcalidrawLib] =
    useState<MermaidToExcalidrawLibProps>({
      loaded: false,
      api: import("@excalidraw/mermaid-to-excalidraw"),
    });

  useEffect(() => {
    const fn = async () => {
      await mermaidToExcalidrawLib.api;
      setMermaidToExcalidrawLib((prev) => ({ ...prev, loaded: true }));
    };
    fn();
  }, [mermaidToExcalidrawLib.api]);

  if (appState.openDialog?.name !== "ttd") {
    return null;
  }

  const activeTab: TTDDialogTabType =
    appState.openDialog.tab === "mermaid" ? "mermaid" : "outline";

  return (
    <Dialog
      className="ttd-dialog"
      onCloseRequest={() => {
        app.setOpenDialog(null);
      }}
      size={1520}
      title={false}
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
          <Suspense fallback={null}>
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
