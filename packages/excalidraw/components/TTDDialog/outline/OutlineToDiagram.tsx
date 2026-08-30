import { useState, useRef, useEffect } from "react";

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

import { OutlineParseError, parseOutlineToTree } from "./parser";
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
- 清晰的直线分支连线`;

const debouncedSaveOutline = debounce((text: string) => {
  EditorLocalStorage.set(EDITOR_LS_KEYS.OUTLINE_TO_DIAGRAM, text);
}, 300);

type OutlinePreviewState = "empty" | "rendering" | "ready" | "error";

const getOutlineErrorMessage = (error: unknown): string => {
  if (error instanceof OutlineParseError) {
    return error.code === "tooLong"
      ? t("outline.inputTooLong") || "大纲内容过长，请缩短后重试"
      : t("outline.tooManyNodes") || "大纲节点过多，请减少内容后重试";
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return t("outline.renderError") || "大纲预览生成失败，请检查输入后重试";
};

export const OutlineToDiagram = ({ isActive }: { isActive?: boolean }) => {
  const [text, setText] = useState(
    () =>
      EditorLocalStorage.get<string>(EDITOR_LS_KEYS.OUTLINE_TO_DIAGRAM) ||
      DEFAULT_OUTLINE_EXAMPLE,
  );
  const [error, setError] = useState<string | null>(null);
  const [previewState, setPreviewState] =
    useState<OutlinePreviewState>("rendering");
  const [previewText, setPreviewText] = useState<string | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const renderGenerationRef = useRef(0);
  const previewStateRef = useRef<OutlinePreviewState>("rendering");
  const inputTextRef = useRef(text);
  const previewTextRef = useRef<string | null>(null);
  const data = useRef<{
    elements: readonly NonDeletedExcalidrawElement[];
    files: null;
  }>({ elements: [], files: null });

  const app = useApp();
  const { theme } = useUIAppState();

  useEffect(() => {
    const generation = ++renderGenerationRef.current;
    const isCurrent = () => renderGenerationRef.current === generation;

    const clearPreview = () => {
      data.current = { elements: [], files: null };
      previewTextRef.current = null;
      setPreviewText(null);
      const canvasNode = canvasRef.current;
      if (canvasNode) {
        canvasNode.replaceChildren();
        if (canvasNode.parentElement) {
          canvasNode.parentElement.style.background = "";
        }
      }
    };

    const updatePreviewState = (state: OutlinePreviewState) => {
      previewStateRef.current = state;
      setPreviewState(state);
    };

    const doRender = async () => {
      const canvasNode = canvasRef.current;
      const parent = canvasNode?.parentElement;
      if (!canvasNode || !parent) {
        return;
      }

      clearPreview();
      setError(null);

      if (!text.trim()) {
        updatePreviewState("empty");
        return;
      }

      updatePreviewState("rendering");

      try {
        const tree = parseOutlineToTree(text);
        if (!tree) {
          throw new Error(
            t("outline.emptyOrInvalid") || "请输入有效的大纲内容",
          );
        }

        const layoutResult = layoutMindmap(tree);
        const generatedElements = generateExcalidrawFromLayout(
          layoutResult,
          theme,
        );

        const ownerWindow =
          app.ownerWindow || canvasNode.ownerDocument.defaultView;
        const devicePixelRatio = ownerWindow?.devicePixelRatio || 1;
        const canvas = await exportToCanvas({
          elements: generatedElements,
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

        data.current = {
          elements: generatedElements,
          files: null,
        };
        previewTextRef.current = text;
        setPreviewText(text);
        updatePreviewState("ready");
        parent.style.background = "var(--default-bg-color)";
        canvasNode.replaceChildren(canvas);
      } catch (err) {
        if (isCurrent()) {
          clearPreview();
          setError(getOutlineErrorMessage(err));
          updatePreviewState("error");
        }
      }
    };

    if (isActive) {
      void doRender();
      debouncedSaveOutline(text);
    }
  }, [text, isActive, theme, app]);

  useEffect(
    () => () => {
      renderGenerationRef.current += 1;
      debouncedSaveOutline.flush();
    },
    [],
  );

  const onInsertToEditor = () => {
    if (
      previewStateRef.current !== "ready" ||
      previewTextRef.current !== inputTextRef.current ||
      data.current.elements.length === 0
    ) {
      return;
    }
    insertToEditor({
      app,
      data,
    });
  };

  const onInputChange = (value: string) => {
    inputTextRef.current = value;
    setText(value);
  };

  const canInsert =
    previewState === "ready" &&
    previewText === text &&
    data.current.elements.length > 0;

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
            ariaLabel={t("outline.inputAriaLabel") || "Markdown outline"}
            language="markdown"
            onChange={onInputChange}
            onKeyboardSubmit={onInsertToEditor}
          />
        </TTDDialogPanel>

        <TTDDialogPanel
          panelActions={[
            {
              action: onInsertToEditor,
              label: t("outline.button") || "插入到画布",
              icon: ArrowRightIcon,
              variant: "button",
              disabled: !canInsert,
            },
          ]}
          renderSubmitShortcut={() => <TTDDialogSubmitShortcut />}
        >
          <TTDDialogOutput
            canvasRef={canvasRef}
            loaded={true}
            loading={previewState === "rendering"}
            hasPreview={previewState === "ready"}
            error={error ? new Error(error) : null}
            errorMessageOverride={error || undefined}
            showErrorGuidance={false}
            emptyMessage={
              t("outline.emptyPreview") || "输入大纲后将在此处显示思维导图预览"
            }
            canvasAriaLabel={
              t("outline.previewAriaLabel") || "Mindmap preview"
            }
            sourceText={text}
          />
        </TTDDialogPanel>
      </TTDDialogPanels>
    </>
  );
};

export default OutlineToDiagram;
