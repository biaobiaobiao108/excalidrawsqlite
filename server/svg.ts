import { DOMParser } from "linkedom";
import { HttpError } from "./errors";

export const MAX_SVG_FILE_BYTES = 2 * 1024 * 1024;

const FORBIDDEN_SVG_TAGS = new Set([
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "base",
  "applet",
  "frame",
  "frameset",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
]);

const URI_ATTRS = new Set([
  "href",
  "xlink:href",
  "src",
  "action",
  "formaction",
  "data",
]);

const DANGEROUS_CSS_PATTERN =
  /(?:javascript:|vbscript:|expression\s*\(|@import|url\s*\()/i;

const sanitizeElement = (el: Element) => {
  for (const child of [...el.children]) {
    const tag = child.tagName.toLowerCase();
    if (FORBIDDEN_SVG_TAGS.has(tag)) {
      child.remove();
      continue;
    }
    if (
      tag === "style" &&
      DANGEROUS_CSS_PATTERN.test(child.textContent || "")
    ) {
      child.remove();
      continue;
    }
    sanitizeElement(child);
  }

  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase();
    const val = attr.value;
    if (name.startsWith("on")) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (URI_ATTRS.has(name) && !val.trim().startsWith("#")) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (name === "style" && DANGEROUS_CSS_PATTERN.test(val)) {
      el.removeAttribute(attr.name);
    }
  }
};

export const sanitizeSvgBytes = (
  bytes: Uint8Array,
): Uint8Array<ArrayBuffer> => {
  if (bytes.byteLength === 0) {
    throw new HttpError(400, "EMPTY_FILE", "文件内容不能为空");
  }
  if (bytes.byteLength > MAX_SVG_FILE_BYTES) {
    throw new HttpError(413, "FILE_TOO_LARGE", "单个 SVG 文件不能超过 2 MiB");
  }

  const rawText = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(
      rawText,
      "image/svg+xml",
    ) as unknown as Document;
  } catch {
    throw new HttpError(400, "INVALID_SVG", "无效的 SVG 文件");
  }

  const root = doc?.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") {
    throw new HttpError(400, "INVALID_SVG", "无效的 SVG 文件");
  }

  sanitizeElement(root);
  if (!root.getAttribute("xmlns")) {
    root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  }

  const sanitized = root.toString();
  const encoded = new TextEncoder().encode(sanitized);
  if (encoded.byteLength === 0) {
    throw new HttpError(400, "INVALID_SVG", "无效的 SVG 文件");
  }
  return encoded;
};
