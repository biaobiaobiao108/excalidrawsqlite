import { useState, useRef, useEffect, useDeferredValue } from "react";

import {
  DEFAULT_EXPORT_PADDING,
  EDITOR_LS_KEYS,
  THEME,
  debounce,
} from "@excalidraw/common";
import { exportToCanvas } from "@excalidraw/utils";

import type { NonDeletedExcalidrawElement } from "@excalidraw/element/types";

import { useApp } from "../../App";
import { ArrowRightIcon } from "../../icons";
import { EditorLocalStorage } from "../../../data/EditorLocalStorage";
import { t } from "../../../i18n";
import { useUIAppState } from "../../../context/ui-appState";
import { TTDDialogPanel } from "../TTDDialogPanel";
import { TTDDialogPanels } from "../TTDDialogPanels";
import { TTDDialogSubmitShortcut } from "../TTDDialogSubmitShortcut";
import { insertToEditor } from "../common";

import { parseOutlineToTree } from "./parser";
import { layoutOutline } from "./layout";
import { generateExcalidrawFromLayout } from "./generator";

import "./OutlineToDiagram.scss";

import type { OutlineLayoutType } from "./types";

const DEFAULT_OUTLINE_EXAMPLE = `# 本期视频大纲：现代白板架构解析
## 核心技术栈
- Bun 1.4 高性能运行时
- SQLite WAL 事务持久化
- React 19 + Canvas 渲染引擎
## 为什么选择 SQLite
- 毫秒级元数据索引查询
- 进程级崩溃安全与事务
- 单文件零配置极速部署
## 创作提效亮点
- 16:9 画框分镜自动排版
- 霞鹜文楷手绘质感中文字体
- 莫兰迪智能层级配色`;

const debouncedSaveOutline = debounce(
  (text: string, layout: OutlineLayoutType) => {
    EditorLocalStorage.set(EDITOR_LS_KEYS.OUTLINE_TO_DIAGRAM, text);
    EditorLocalStorage.set(EDITOR_LS_KEYS.OUTLINE_LAYOUT, layout);
  },
  300,
);

export const OutlineToDiagram = ({ isActive }: { isActive?: boolean }) => {
  const [text, setText] = useState(
    () =>
      EditorLocalStorage.get<string>(EDITOR_LS_KEYS.OUTLINE_TO_DIAGRAM) ||
      DEFAULT_OUTLINE_EXAMPLE,
  );
  const [layoutType, setLayoutType] = useState<OutlineLayoutType>(
    () =>
      (EditorLocalStorage.get<OutlineLayoutType>(
        EDITOR_LS_KEYS.OUTLINE_LAYOUT,
      ) as OutlineLayoutType) || "mindmap",
  );

  const deferredText = useDeferredValue(text);
  const deferredLayout = useDeferredValue(layoutType);
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const renderGenerationRef = useRef(0);
  const data = useRef<{
    elements: readonly NonDeletedExcalidrawElement[];
    files: null;
  }>({ elements: [], files: null });

  const app = useApp();
  const { theme } = useUIAppState();

  useEffect(() => {
    const generation = ++renderGenerationRef.current;
    const isCurrent = () => renderGenerationRef.current === generation;

    const doRender = async () => {
      const canvasNode = canvasRef.current;
      const parent = canvasNode?.parentElement;
      if (!canvasNode || !parent) {
        return;
      }

      if (!deferredText.trim()) {
        setError(null);
        data.current = { elements: [], files: null };
        canvasNode.replaceChildren();
        return;
      }

      try {
        const tree = parseOutlineToTree(deferredText);
        if (!tree) {
          setError(t("outline.emptyOrInvalid") || "请输入有效的大纲内容");
          canvasNode.replaceChildren();
          return;
        }

        setError(null);
        const layoutResult = layoutOutline(tree, deferredLayout);
        const generatedElements = generateExcalidrawFromLayout(
          layoutResult,
          theme,
        );

        data.current = {
          elements: generatedElements,
          files: null,
        };

        const canvas = await exportToCanvas({
          elements: data.current.elements,
          files: null,
          exportPadding: DEFAULT_EXPORT_PADDING,
          maxWidthOrHeight:
            Math.max(parent.offsetWidth, parent.offsetHeight) *
            window.devicePixelRatio,
          appState: {
            exportWithDarkMode: theme === THEME.DARK,
          },
        });

        if (!isCurrent()) {
          return;
        }

        parent.style.background = "var(--default-bg-color)";
        canvasNode.replaceChildren(canvas);
      } catch (err: any) {
        if (isCurrent()) {
          setError(err?.message || "排版解析出错");
        }
      }
    };

    if (isActive) {
      doRender();
      debouncedSaveOutline(deferredText, deferredLayout);
    }
  }, [deferredText, deferredLayout, isActive, theme]);

  useEffect(
    () => () => {
      renderGenerationRef.current += 1;
      debouncedSaveOutline.flush();
    },
    [],
  );

  const onInsertToEditor = () => {
    if (!data.current.elements.length) {
      return;
    }
    insertToEditor({
      app,
      data,
      text,
    });
  };

  return (
    <div className="outline-to-diagram">
      <div className="outline-header-bar">
        <div className="outline-layout-selector">
          <button
            type="button"
            className={layoutType === "mindmap" ? "active" : ""}
            onClick={() => setLayoutType("mindmap")}
          >
            🧭 {t("outline.layouts.mindmap") || "横向导图"}
          </button>
          <button
            type="button"
            className={layoutType === "hierarchy" ? "active" : ""}
            onClick={() => setLayoutType("hierarchy")}
          >
            🌳 {t("outline.layouts.hierarchy") || "架构树"}
          </button>
          <button
            type="button"
            className={layoutType === "storyboard" ? "active" : ""}
            onClick={() => setLayoutType("storyboard")}
          >
            🎬 {t("outline.layouts.storyboard") || "分镜卡片 (16:9)"}
          </button>
        </div>
        <span className="outline-tips">
          {t("outline.tips") || "支持 Markdown 标题、列表与缩进大纲"}
        </span>
      </div>

      <TTDDialogPanels>
        <TTDDialogPanel>
          <div className="outline-editor-wrapper">
            <textarea
              value={text}
              placeholder={
                t("outline.inputPlaceholder") ||
                "# 主题\n## 第一章\n- 要点 1\n- 要点 2\n## 第二章\n- 要点 3"
              }
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (
                  (e.metaKey || e.ctrlKey) &&
                  (e.key === "Enter" || e.code === "Enter")
                ) {
                  e.preventDefault();
                  onInsertToEditor();
                }
              }}
            />
          </div>
        </TTDDialogPanel>

        <TTDDialogPanel
          panelActions={[
            {
              action: () => onInsertToEditor(),
              label: t("outline.button") || "插入到画布",
              icon: ArrowRightIcon,
              variant: "button",
            },
          ]}
          renderSubmitShortcut={() => <TTDDialogSubmitShortcut />}
        >
          <div className="outline-preview-container">
            {error ? (
              <div className="outline-empty-hint">{error}</div>
            ) : (
              <div ref={canvasRef} />
            )}
          </div>
        </TTDDialogPanel>
      </TTDDialogPanels>
    </div>
  );
};

export default OutlineToDiagram;
