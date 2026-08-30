import type { OutlineNode } from "./types";

let idCounter = 0;
const generateNodeId = () => `node_${Date.now()}_${++idCounter}`;

const cleanMarkdownText = (raw: string): string => {
  return raw
    .replace(/\*\*(.*?)\*\*/g, "$1") // Bold **
    .replace(/__(.*?)__/g, "$1") // Bold __
    .replace(/\*(.*?)\*/g, "$1") // Italic *
    .replace(/_(.*?)_/g, "$1") // Italic _
    .replace(/`([^`]+)`/g, "$1") // Inline code `
    .replace(/~~(.*?)~~/g, "$1") // Strikethrough ~~
    .trim();
};

type ParsedLine = {
  raw: string;
  text: string;
  level: number;
  type: "heading" | "list" | "indent";
};

export const parseOutlineToTree = (inputText: string): OutlineNode | null => {
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
      parsedLines.push({
        raw: line,
        text: cleanMarkdownText(headingMatch[2]),
        level: headingLevel,
        type: "heading",
      });
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
      parsedLines.push({
        raw: line,
        text: cleanMarkdownText(listMatch[3]),
        level,
        type: "list",
      });
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
      parsedLines.push({
        raw: line,
        text: cleanMarkdownText(indentMatch[2]),
        level,
        type: "indent",
      });
    }
  }

  if (parsedLines.length === 0) {
    return null;
  }

  // Normalize levels to be sequential starting from 0 (root)
  // Find minimum level
  const minLevel = Math.min(...parsedLines.map((p) => p.level));

  // If the first line is level 1 / minLevel, make it the root.
  // If there are multiple minLevel lines at the top or throughout, determine if we need a virtual root or if line 0 is the root.
  let root: OutlineNode;
  let startIndex = 0;

  if (parsedLines.length === 1) {
    return {
      id: generateNodeId(),
      text: parsedLines[0].text,
      level: 0,
      children: [],
    };
  }

  // Check if first line can be the root
  const firstLine = parsedLines[0];
  const otherMinLevelLines = parsedLines
    .slice(1)
    .filter((p) => p.level === firstLine.level);

  if (firstLine.level === minLevel && otherMinLevelLines.length === 0) {
    // Clean single root
    root = {
      id: generateNodeId(),
      text: firstLine.text,
      level: 0,
      children: [],
    };
    startIndex = 1;
  } else {
    // If the first item is not strictly unique top level, use the first line's text or create a root
    root = {
      id: generateNodeId(),
      text: firstLine.text,
      level: 0,
      children: [],
    };
    startIndex = 1;
  }

  // Build tree using stack
  const stack: { node: OutlineNode; rawLevel: number }[] = [
    { node: root, rawLevel: firstLine.level },
  ];

  for (let i = startIndex; i < parsedLines.length; i++) {
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
    newNode.parent = parent.node;
    parent.node.children.push(newNode);
    stack.push({ node: newNode, rawLevel: current.level });
  }

  return root;
};
