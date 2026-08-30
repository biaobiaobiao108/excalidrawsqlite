import type { OutlineNode } from "./types";

let idCounter = 0;
const generateNodeId = () => `node_${Date.now()}_${++idCounter}`;

export const MAX_OUTLINE_CHARACTERS = 20_000;
export const MAX_OUTLINE_NODES = 1_000;

export class OutlineParseError extends Error {
  constructor(public readonly code: "tooLong" | "tooManyNodes") {
    super(
      code === "tooLong"
        ? "Outline input is too long"
        : "Outline has too many nodes",
    );
    this.name = "OutlineParseError";
  }
}

const cleanMarkdownText = (raw: string): string => {
  return raw
    // Only remove unambiguous paired Markdown markers. In particular, do not
    // treat underscores inside words (foo_bar_baz) as emphasis.
    .replace(/!?\[([^\]\r\n]+)\]\([^()\r\n]+\)/g, "$1")
    .replace(/`([^`\r\n]+)`/g, "$1")
    .replace(/\*\*([^*\r\n]+)\*\*/g, "$1")
    .replace(/__([^_\r\n]+)__/g, "$1")
    .replace(/~~([^~\r\n]+)~~/g, "$1")
    .replace(/(?<![\w*])\*([^*\r\n]+)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_([^_\r\n]+)_(?![\w_])/g, "$1")
    .trim();
};

type ParsedLine = {
  text: string;
  level: number;
};

export const parseOutlineToTree = (inputText: string): OutlineNode | null => {
  if (inputText.length > MAX_OUTLINE_CHARACTERS) {
    throw new OutlineParseError("tooLong");
  }

  const lines = inputText
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, "    "))
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return null;
  }

  const parsedLines: ParsedLine[] = [];
  let lastHeadingLevel = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    // Check Markdown headings: # H1, ## H2, ### H3 ...
    const headingMatch = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const headingLevel = headingMatch[1].length;
      lastHeadingLevel = headingLevel;
      const text = cleanMarkdownText(headingMatch[2]);
      if (!text) {
        continue;
      }
      parsedLines.push({
        text,
        level: headingLevel,
      });
      if (parsedLines.length > MAX_OUTLINE_NODES) {
        throw new OutlineParseError("tooManyNodes");
      }
      continue;
    }

    // Check bullet or numbered list
    const listMatch = line.match(/^(\s*)([-*+]|\d+[.)]|\(\d+\))\s+(.*)$/);
    if (listMatch) {
      const indentSpaces = listMatch[1].length;
      const indentLevel = Math.floor(indentSpaces / 2);
      const level =
        lastHeadingLevel > 0
          ? lastHeadingLevel + 1 + indentLevel
          : 1 + indentLevel;
      const text = cleanMarkdownText(listMatch[3]);
      if (!text) {
        continue;
      }
      parsedLines.push({
        text,
        level,
      });
      if (parsedLines.length > MAX_OUTLINE_NODES) {
        throw new OutlineParseError("tooManyNodes");
      }
      continue;
    }

    // Indented plain text
    const indentMatch = line.match(/^(\s*)(.*)$/);
    if (indentMatch) {
      const indentSpaces = indentMatch[1].length;
      const indentLevel = Math.floor(indentSpaces / 2);
      const level =
        lastHeadingLevel > 0
          ? lastHeadingLevel + 1 + indentLevel
          : 1 + indentLevel;
      const text = cleanMarkdownText(indentMatch[2]);
      if (!text) {
        continue;
      }
      parsedLines.push({
        text,
        level,
      });
      if (parsedLines.length > MAX_OUTLINE_NODES) {
        throw new OutlineParseError("tooManyNodes");
      }
    }
  }

  if (parsedLines.length === 0) {
    return null;
  }

  // The first meaningful line is always the central node. Later top-level
  // entries become branches of that node, which keeps the result usable even
  // when a pasted outline contains several H1s or root-level list items.
  const firstLine = parsedLines[0];
  const root: OutlineNode = {
    id: generateNodeId(),
    text: firstLine.text,
    level: 0,
    children: [],
  };

  // Build tree using stack
  const stack: { node: OutlineNode; rawLevel: number }[] = [
    { node: root, rawLevel: firstLine.level },
  ];

  for (let i = 1; i < parsedLines.length; i++) {
    const current = parsedLines[i];
    const newNode: OutlineNode = {
      id: generateNodeId(),
      text: current.text,
      level: 1, // will adjust dynamically
      children: [],
    };

    // Pop until finding the parent whose rawLevel < current.rawLevel
    while (
      stack.length > 1 &&
      stack[stack.length - 1].rawLevel >= current.level
    ) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    newNode.level = parent.node.level + 1;
    parent.node.children.push(newNode);
    stack.push({ node: newNode, rawLevel: current.level });
  }

  return root;
};
