import { describe, expect, it } from "bun:test";
import * as z from "zod/v4";
import { colorSchema, drawingElementSchema } from "../../server/mcp-drawing";
import { compactMcpSchema } from "../../server/mcp-schema";

describe("compact MCP schemas", () => {
  it("advertises concise color guidance and validates case-insensitive formats at the server boundary", () => {
    const json = z.toJSONSchema(colorSchema, { io: "input" });
    expect(json).toMatchObject({ type: "string", maxLength: 64 });
    expect(json).not.toHaveProperty("pattern");
    expect(json.description).toContain("#RRGGBB");
    for (const color of ["#ABC", "#ABCF", "#AABBCC", "#AABBCCFF", "TRANSPARENT", "ReD"]) {
      expect(colorSchema.parse(color)).toBe(color.toLowerCase());
    }
    for (const color of ["#GGG", "#ABCDE", "not-a-color"]) {
      expect(colorSchema.safeParse(color).success).toBe(false);
    }
  });
  const schema = z.object({ elements: z.array(drawingElementSchema), expectedRevision: z.number().int().positive() }).strict();
  const wrapped = compactMcpSchema(schema)["~standard"];
  const box = { type: "rectangle", x: 0, y: 0, width: 100, height: 100 };

  it("advertises shared definitions while retaining strict type-specific shape contracts", () => {
    const json = wrapped.jsonSchema.input({ target: "draft-2020-12" });
    expect(JSON.stringify(json).length).toBeLessThan(JSON.stringify(z.toJSONSchema(schema, { io: "input" })).length * 0.8);
    expect(json).toHaveProperty("$defs");
    for (const type of ["rectangle", "ellipse", "diamond"]) {
      expect(drawingElementSchema.safeParse({ ...box, type }).success).toBe(true);
      expect(drawingElementSchema.safeParse({ ...box, type, strokeColour: "red" }).success).toBe(false);
      expect(drawingElementSchema.safeParse({ ...box, type, startBinding: { elementId: "a" } }).success).toBe(false);
    }
    expect(drawingElementSchema.safeParse({ type: "text", x: 0, y: 0, text: "a", width: 100 }).success).toBe(false);
    expect(drawingElementSchema.safeParse({ type: "line", points: [[0, 0], [10, 10]], endBinding: { elementId: "a" } }).success).toBe(false);
  });

  it("preserves transforms, defaults, refinements and successful values", async () => {
    const transformed = z.object({ name: z.string().trim(), count: z.number().default(1) }).strict()
      .refine((v) => v.name.length > 0, "名称不能为空");
    const adapter = compactMcpSchema(transformed)["~standard"];
    expect(await adapter.validate({ name: " test " })).toEqual({ value: { name: "test", count: 1 } });
    expect(await adapter.validate({ name: " " })).toHaveProperty("issues");
    const valid = { elements: [box], expectedRevision: 1 };
    expect(await wrapped.validate(valid)).toEqual({ value: schema.parse(valid) });
  });

  it("groups repeated batch errors with concrete paths and counts without accepting invalid input", async () => {
    const bad = { elements: Array.from({ length: 100 }, () => ({ ...box, strokeColor: "not-a-color" })) };
    const result = await wrapped.validate(bad);
    expect(result).toHaveProperty("issues");
    if (!result.issues) throw new Error("expected validation errors");
    const errors = result.issues.map((issue) => issue.message).join("; ");
    expect(errors).toContain("elements.0.strokeColor");
    expect(errors).toContain("共 100 处");
    expect(errors).toContain("expectedRevision");
    expect(errors.length).toBeLessThan(1_000);
    expect(result).not.toHaveProperty("value");
  });
});
