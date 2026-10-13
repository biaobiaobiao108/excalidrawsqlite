import * as z from "zod/v4";
import type { StandardSchemaV1, StandardSchemaWithJSON } from "@modelcontextprotocol/server";

const MAX_ERROR_GROUPS = 8;
const MAX_SAMPLE_PATHS = 3;
const shorten = (value: string, limit: number) => value.length <= limit ? value : `${value.slice(0, limit)}…`;

const readInputPath = (input: unknown, path: readonly PropertyKey[]): unknown => {
  let current = input;
  for (const part of path) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, part)) return undefined;
    current = (current as Record<PropertyKey, unknown>)[part];
  }
  return current;
};

/** Suggestions describe the public drawing contract, never echo argument values. */
function issueMessage(issue: z.core.$ZodIssue, input: unknown): string {
  const owner = readInputPath(input, issue.path);
  const element = readInputPath(input, issue.path.at(-1) === "labelStyle" ? issue.path.slice(0, -1) : issue.path);
  const elementType = element && typeof element === "object" && Object.hasOwn(element, "type")
    ? (element as { type?: unknown }).type : undefined;
  const isDrawing = Boolean(element && typeof element === "object" && (
    (typeof elementType === "string" && ["rectangle", "ellipse", "diamond", "text", "line", "arrow"].includes(elementType)) ||
    ((issue.path[0] === "updates" || issue.path[0] === "update") && Object.hasOwn(element, "id"))
  ));
  const hints: string[] = [];
  let message = shorten(issue.message, 300);
  if (issue.code === "unrecognized_keys") {
    message = `Unrecognized keys: ${issue.keys.slice(0, 3).map((key) => JSON.stringify(shorten(key, 40))).join("、")}${issue.keys.length > 3 ? `（共 ${issue.keys.length} 个）` : ""}；请删除这些不支持的字段`;
    if (issue.path.length === 0 && owner && typeof owner === "object" && Object.hasOwn(owner, "boardId") && issue.keys.includes("id"))
      hints.push('update_element 的图元字段需放入 update，例如 {"boardId":"画板ID","update":{"id":"图元ID","dx":20}}');
    if (isDrawing) {
      if (elementType === "line" && issue.keys.some((key) => ["startBinding", "endBinding", "startArrowhead", "endArrowhead"].includes(key)))
        hints.push('line 使用固定坐标；需要绑定节点的无箭头连线，请改用 {"type":"arrow","endArrowhead":null}，startArrowhead 默认 null');
      if (issue.keys.includes("height") && owner && typeof owner === "object" && (owner as { type?: unknown }).type === "text")
        hints.push('文字高度按内容自动计算；用 width 控制换行或 fontSize 调整字号，例如 {"width":200,"fontSize":20}');
      if (issue.keys.includes("angle"))
        hints.push('使用 rotation（度），例如 {"rotation":90}；原始 angle（弧度）需乘 180/π 转换');
      if (issue.keys.includes("strokeColour")) hints.push("strokeColour 应改为 strokeColor");
    }
  } else if (issue.path.at(-1) === "opacity" && (
    (issue.code === "too_small" && issue.minimum === 0) ||
    (issue.code === "too_big" && issue.maximum === 100) ||
    (issue.code === "invalid_type" && issue.expected === "number")
  )) {
    hints.push('opacity 使用数字百分比 0–100，例如 {"opacity":50} 表示 50%；不要传 "50%"');
  } else if (issue.code === "custom" && issue.message === "autoResize=true 时不能同时提供 width") {
    hints.push('固定换行宽度可用 {"width":200,"autoResize":false}；自动宽度则删除 width');
  }
  return shorten([message, ...hints.slice(0, 2)].join("；"), 600);
}

/** Keep representative field paths without repeating the same error for every batch item. */
function compactIssues(issues: readonly z.core.$ZodIssue[], input: unknown): StandardSchemaV1.Issue[] {
  const groups = new Map<string, { message: string; paths: string[]; count: number }>();
  for (const issue of issues) {
    const path = issue.path.map(String).join(".") || "参数";
    const field = issue.path.map((part) => typeof part === "number" ? "*" : String(part)).join(".");
    const message = issueMessage(issue, input);
    const key = `${issue.code}:${field}:${message}`;
    let group = groups.get(key);
    if (!group) {
      group = { message, paths: [], count: 0 };
      groups.set(key, group);
    }
    group.count++;
    if (group.paths.length < MAX_SAMPLE_PATHS) group.paths.push(shorten(path, 160));
  }
  const result = [...groups.values()].slice(0, MAX_ERROR_GROUPS).map((group) => ({
    message: `${group.paths.join("、")}: ${group.message}${group.count > group.paths.length ? `（共 ${group.count} 处）` : ""}`,
  }));
  if (groups.size > MAX_ERROR_GROUPS) result.push({ message: `另有 ${groups.size - MAX_ERROR_GROUPS} 类校验错误；修正以上字段后重试` });
  return result;
}

/** Public Standard Schema adapter: unchanged Zod validation, shared JSON definitions, bounded errors. */
export function compactMcpSchema<T extends z.ZodType>(schema: T): StandardSchemaWithJSON<z.input<T>, z.output<T>> {
  const standard = schema["~standard"];
  return {
    "~standard": {
      version: 1,
      vendor: "hutudraw",
      types: standard.types,
      async validate(value) {
        const parsed = await schema.safeParseAsync(value);
        return parsed.success ? { value: parsed.data } : { issues: compactIssues(parsed.error.issues, value) };
      },
      jsonSchema: {
        input: (options) => standard.jsonSchema.input({ ...options, libraryOptions: { ...options.libraryOptions, reused: "ref" } }),
        output: (options) => standard.jsonSchema.output({ ...options, libraryOptions: { ...options.libraryOptions, reused: "ref" } }),
      },
    },
  };
}
