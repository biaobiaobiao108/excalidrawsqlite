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
import { TTDDialogInput } from "../TTDDialogInput";
import { TTDDialogOutput } from "../TTDDialogOutput";
import { TTDDialogPanel } from "../TTDDialogPanel";
import { TTDDialogPanels } from "../TTDDialogPanels";
import { TTDDialogSubmitShortcut } from "../TTDDialogSubmitShortcut";
import { insertToEditor } from "../common";

import { parseOutlineToTree } from "./parser";
import { layoutMindmap } from "./layout";
import { generateExcalidrawFromLayout } from "./generator";

import "./OutlineToDiagram.scss";

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
- 霞鹜文楷手绘质感中文字体
- 莫兰迪智能分支层级配色
- S型贝塞尔曲线分支连线`;

const debouncedSaveOutline = debounce((text: string) => {
  EditorLocalStorage.set(EDITOR_LS_KEYS.OUTLINE_TO_DIAGRAM, text);
}, 300);

export const OutlineToDiagram = ({ isActive }: { isActive?: boolean }) => {
  const [text, setText] = useState(
    () =>
      EditorLocalStorage.get<string>(EDITOR_LS_KEYS.OUTLINE_TO_DIAGRAM) ||
      DEFAULT_OUTLINE_EXAMPLE,
  );

  const deferredText = useDeferredValue(text);
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
        const layoutResult = layoutMindmap(tree);
        const generatedElements = generateExcalidrawFromLayout(
          layoutResult,
          theme,
        );

        data.current = {
          elements: generatedElements,
          files: null,
        };

        const ownerWindow =
          app.ownerWindow || canvasNode.ownerDocument.defaultView;
        const devicePixelRatio = ownerWindow?.devicePixelRatio || 1;

        const canvas = await exportToCanvas({
          elements: data.current.elements,
          files: null,
          exportPadding: DEFAULT_EXPORT_PADDING,
          maxWidthOrHeight:
            Math.max(parent.offsetWidth, parent.offsetHeight) *
            devicePixelRatio,
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
      debouncedSaveOutline(deferredText);
    }
  }, [deferredText, isActive, theme, app]);

  const onInsertToEditor = () => {
    if (data.current.elements.length === 0) {
      return;
    }
    insertToEditor({
      app,
      data,
    });
  };

  return (
    <>
      <div className="ttd-dialog-desc">
        {t("outline.description") ||
          "输入 Markdown 格式的标题与列表大纲，自动生成手绘风格思维导图"}
      </div>

      <TTDDialogPanels>
        <TTDDialogPanel>
          <TTDDialogInput
            input={text}
            placeholder={
              t("outline.inputPlaceholder") ||
              "# 主题\n## 第一章\n- 要点 1\n- 要点 2\n## 第二章\n- 要点 3"
            }
            onChange={(value) => setText(value)}
            onKeyboardSubmit={() => {
              onInsertToEditor();
            }}
          />
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
          <TTDDialogOutput
            canvasRef={canvasRef}
            loaded={true}
            error={error ? new Error(error) : null}
            sourceText={text}
          />
        </TTDDialogPanel>
      </TTDDialogPanels>
    </>
  );
};

export default OutlineToDiagram;
