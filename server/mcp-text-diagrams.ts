import { DOMParser as LinkedomDOMParser, parseHTML } from "linkedom";
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { convertToExcalidrawElements } from "@excalidraw/element";
import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
  Theme,
} from "@excalidraw/element/types";
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

const decodeDataUrl = (
  dataUrl: string,
): { mimeType: string; bytes: Uint8Array<ArrayBuffer> } => {
  const commaIndex = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || commaIndex === -1) {
    throw new HttpError(400, "INVALID_INPUT", "Mermaid 导出的图像数据格式无效");
  }
  const header = dataUrl.slice(5, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  const parts = header.split(";").filter(Boolean);
  const isBase64 = parts[parts.length - 1]?.toLowerCase() === "base64";
  const mimeType =
    (isBase64 ? parts.slice(0, -1) : parts)[0] || "image/svg+xml";

  if (isBase64) {
    return {
      mimeType,
      bytes: new Uint8Array(Buffer.from(payload, "base64")),
    };
  }
  return {
    mimeType,
    bytes: new TextEncoder().encode(decodeURIComponent(payload)),
  };
};

export type UploadedFileHandler = (
  fileId: string,
  mimeType: string,
  bytes: Uint8Array<ArrayBuffer>,
) => Promise<string>;

export const buildMermaidScene = async (
  mermaidDefinition: string,
  uploadFile: UploadedFileHandler,
): Promise<{
  elements: ExcalidrawElement[];
  convertedAsImage: boolean;
  fileCount: number;
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

  const converted = convertToExcalidrawElements(parsed.elements, {
    regenerateIds: true,
  }) as ExcalidrawElement[];

  const files = parsed.files || {};
  const fileIdMap = new Map<string, string>();
  for (const [id, fileData] of Object.entries(files)) {
    if (!fileData?.dataURL) {
      continue;
    }
    const { mimeType, bytes } = decodeDataUrl(fileData.dataURL);
    const savedId = await uploadFile(id, fileData.mimeType || mimeType, bytes);
    fileIdMap.set(id, savedId);
  }

  const elements =
    fileIdMap.size > 0
      ? converted.map((element) => {
          if (element.type === "image") {
            const img = element as ExcalidrawImageElement;
            if (img.fileId && fileIdMap.has(img.fileId)) {
              return {
                ...img,
                fileId: fileIdMap.get(
                  img.fileId,
                )! as ExcalidrawImageElement["fileId"],
              };
            }
          }
          return element;
        })
      : converted;

  const convertedAsImage =
    elements.length === 1 && elements[0]?.type === "image";

  return {
    elements,
    convertedAsImage,
    fileCount: fileIdMap.size,
  };
};

export const offsetDiagramElements = (
  elements: ExcalidrawElement[],
  targetX = 0,
  targetY = 0,
): ExcalidrawElement[] => {
  if ((targetX === 0 && targetY === 0) || elements.length === 0) {
    return elements;
  }
  let minX = Infinity;
  let minY = Infinity;
  for (const el of elements) {
    if (el.isDeleted) {
      continue;
    }
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return elements;
  }
  const dx = targetX - minX;
  const dy = targetY - minY;
  if (dx === 0 && dy === 0) {
    return elements;
  }
  return elements.map((el) => ({
    ...el,
    x: el.x + dx,
    y: el.y + dy,
  }));
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
