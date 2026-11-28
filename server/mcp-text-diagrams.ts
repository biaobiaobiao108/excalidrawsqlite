import { DOMParser as LinkedomDOMParser, parseHTML } from "linkedom";
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { convertToExcalidrawElements } from "@excalidraw/element";
import type { ExcalidrawElement, Theme } from "@excalidraw/element/types";
import { MERMAID_TO_EXCALIDRAW_CONFIG } from "@excalidraw/excalidraw/mermaid";
import {
  OutlineParseError,
  parseOutlineToTree,
} from "@excalidraw/excalidraw/components/TTDDialog/outline/parser";
import { layoutOutline } from "@excalidraw/excalidraw/components/TTDDialog/outline/layout";
import { generateExcalidrawFromLayout } from "@excalidraw/excalidraw/components/TTDDialog/outline/generator";
import { HttpError } from "./errors";
// Ensure server-side text metrics provider is registered before calling
// convertToExcalidrawElements().
import "./mcp-drawing-core";

let serverDomInitialized = false;

const ensureServerDomForMermaid = () => {
  if (serverDomInitialized) {
    return;
  }
  if (typeof globalThis.DOMParser === "undefined") {
    globalThis.DOMParser =
      LinkedomDOMParser as unknown as typeof globalThis.DOMParser;
  }
  if (typeof globalThis.document === "undefined") {
    const { document } = parseHTML("<!doctype html><html><body></body></html>");
    globalThis.document = document as unknown as typeof globalThis.document;
  }
  serverDomInitialized = true;
};

export const buildMermaidScene = async (
  mermaidDefinition: string,
): Promise<{
  elements: ExcalidrawElement[];
}> => {
  const trimmed = mermaidDefinition.trim();
  if (!trimmed) {
    throw new HttpError(400, "INVALID_INPUT", "Mermaid 定义内容不能为空");
  }

  ensureServerDomForMermaid();

  let parsed: Awaited<ReturnType<typeof parseMermaidToExcalidraw>>;
  try {
    parsed = await parseMermaidToExcalidraw(
      trimmed,
      MERMAID_TO_EXCALIDRAW_CONFIG,
    );
  } catch (err) {
    if (trimmed.includes('"')) {
      try {
        parsed = await parseMermaidToExcalidraw(
          trimmed.replace(/"/g, "'"),
          MERMAID_TO_EXCALIDRAW_CONFIG,
        );
      } catch {
        const message =
          err instanceof Error ? err.message : "Mermaid 语法解析失败";
        throw new HttpError(400, "INVALID_INPUT", message);
      }
    } else {
      const message =
        err instanceof Error ? err.message : "Mermaid 语法解析失败";
      throw new HttpError(400, "INVALID_INPUT", message);
    }
  }

  const elements = convertToExcalidrawElements(parsed.elements, {
    regenerateIds: true,
  }) as ExcalidrawElement[];

  const hasFallbackImage =
    Object.keys(parsed.files || {}).length > 0 ||
    (elements.length === 1 && elements[0]?.type === "image");
  if (hasFallbackImage) {
    throw new HttpError(
      400,
      "INVALID_INPUT",
      "该 Mermaid 图表类型暂不支持转为原生图元，请改用 flowchart、sequenceDiagram、classDiagram、stateDiagram、erDiagram、gantt、quadrantChart、timeline 或使用 create_diagram",
    );
  }

  return { elements };
};

export const buildMarkdownMindmapScene = (
  markdown: string,
  theme: Theme = "light",
): {
  elements: ExcalidrawElement[];
  nodeCount: number;
} => {
  let root: ReturnType<typeof parseOutlineToTree>;
  try {
    root = parseOutlineToTree(markdown);
  } catch (error) {
    if (error instanceof OutlineParseError) {
      throw new HttpError(400, "INVALID_INPUT", error.message);
    }
    throw error;
  }
  if (!root) {
    throw new HttpError(
      400,
      "INVALID_INPUT",
      "Markdown 大纲为空，请至少提供一个标题或列表项",
    );
  }
  const layout = layoutOutline(root);
  const elements = generateExcalidrawFromLayout(
    layout,
    theme,
  ) as ExcalidrawElement[];
  return {
    elements,
    nodeCount: layout.nodes.length,
  };
};
