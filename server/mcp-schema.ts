import * as z from "zod/v4";
import type { StandardSchemaV1, StandardSchemaWithJSON } from "@modelcontextprotocol/server";

const MAX_ERROR_GROUPS = 8;
const MAX_SAMPLE_PATHS = 3;
const shorten = (value: string, limit: number) => value.length <= limit ? value : `${value.slice(0, limit)}…`;

/** Keep representative field paths without repeating the same error for every batch item. */
function compactIssues(issues: readonly z.core.$ZodIssue[]): StandardSchemaV1.Issue[] {
  const groups = new Map<string, { message: string; paths: string[]; count: number }>();
  for (const issue of issues) {
    const path = issue.path.map(String).join(".") || "参数";
    const field = issue.path.map((part) => typeof part === "number" ? "*" : String(part)).join(".");
    const key = `${issue.code}:${field}:${issue.message}`;
    let group = groups.get(key);
    if (!group) {
      group = { message: shorten(issue.message, 450), paths: [], count: 0 };
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
        return parsed.success ? { value: parsed.data } : { issues: compactIssues(parsed.error.issues) };
      },
      jsonSchema: {
        input: (options) => standard.jsonSchema.input({ ...options, libraryOptions: { ...options.libraryOptions, reused: "ref" } }),
        output: (options) => standard.jsonSchema.output({ ...options, libraryOptions: { ...options.libraryOptions, reused: "ref" } }),
      },
    },
  };
}
