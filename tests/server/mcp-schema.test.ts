import { describe, expect, it } from "bun:test";
import * as z from "zod/v4";
import { colorSchema, drawingElementSchema, elementUpdateSchema } from "../../server/mcp-drawing";
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
    expect(drawingElementSchema.safeParse({ type: "text", x: 0, y: 0, text: "a", width: 100 }).success).toBe(true);
    expect(drawingElementSchema.safeParse({ type: "text", x: 0, y: 0, text: "a", height: 100 }).success).toBe(false);
    expect(drawingElementSchema.safeParse({ type: "text", x: 0, y: 0, text: "a", width: 100, autoResize: true }).success).toBe(false);
    expect(drawingElementSchema.safeParse({ type: "line", x: 0, y: 0, points: [[0, 0], [10, 10]], endBinding: { elementId: "a" } }).success).toBe(false);
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

  it("explains text sizing and degree rotation without accepting raw fields", async () => {
    const result = await wrapped.validate({
      elements: [{ type: "text", x: 0, y: 0, text: "private-label-value", height: 100, angle: Math.PI / 2 }],
      expectedRevision: 1,
    });
    if (!result.issues) throw new Error("expected validation errors");
    const errors = result.issues.map((issue) => issue.message).join("; ");
    expect(errors).toContain("文字高度按内容自动计算");
    expect(errors).toContain('"width":200');
    expect(errors).toContain("rotation（度）");
    expect(errors).toContain("180/π");
    expect(errors).not.toContain("private-label-value");
    expect(result).not.toHaveProperty("value");
    expect(await wrapped.validate({ elements: [{ type: "text", x: 0, y: 0, text: "label", width: 200, rotation: 90 }], expectedRevision: 1 })).toHaveProperty("value");
  });

  it("offers precise opacity, spelling and auto-resize corrections", async () => {
    for (const opacity of [-1, 101, "50%"]) {
      const result = await wrapped.validate({ elements: [{ ...box, opacity }], expectedRevision: 1 });
      if (!result.issues) throw new Error("expected validation errors");
      expect(result.issues[0].message).toContain("数字百分比 0–100");
      expect(result.issues[0].message).toContain('"opacity":50');
    }
    const misspelling = await wrapped.validate({ elements: [{ ...box, strokeColour: "red" }], expectedRevision: 1 });
    expect(misspelling.issues?.[0].message).toContain("strokeColour 应改为 strokeColor");
    const autoResize = await wrapped.validate({ elements: [{ type: "text", x: 0, y: 0, text: "a", width: 100, autoResize: true }], expectedRevision: 1 });
    expect(autoResize.issues?.[0].message).toContain('"autoResize":false');
    expect(autoResize).not.toHaveProperty("value");
    for (const input of [{ update: { id: "box", angle: 1 } }, { updates: [{ id: "box", angle: 1 }] }]) {
      const updates = compactMcpSchema(z.object({ update: elementUpdateSchema.optional(), updates: z.array(elementUpdateSchema).optional() }).strict())["~standard"];
      const result = await updates.validate(input);
      expect(result.issues?.[0].message).toContain("rotation（度）");
      expect(result).not.toHaveProperty("value");
    }
  });

  it("explains how to create a bound connector without arrowheads", async () => {
    const connector = { type: "line", startBinding: { elementId: "a" }, endBinding: { elementId: "b" } };
    const result = await wrapped.validate({ elements: [connector], expectedRevision: 1 });
    expect(result).not.toHaveProperty("value");
    expect(result.issues?.map((issue) => issue.message).join("; ")).toContain('"endArrowhead":null');
    expect(await wrapped.validate({ elements: [{ ...connector, type: "arrow", endArrowhead: null }], expectedRevision: 1 })).toHaveProperty("value");
  });

  it("shows the update envelope for misplaced element fields", async () => {
    const update = compactMcpSchema(z.object({ boardId: z.string(), update: elementUpdateSchema }).strict())["~standard"];
    const result = await update.validate({ boardId: "private-board-value", id: "private-element-value", dx: 20 });
    const errors = result.issues?.map((issue) => issue.message).join("; ") || "";
    expect(errors).toContain('"update":{"id":"图元ID","dx":20}');
    expect(errors).not.toContain("private-board-value");
    expect(errors).not.toContain("private-element-value");
    expect(result).not.toHaveProperty("value");
  });

  it("bounds unknown-key reports and avoids drawing advice for unrelated objects", async () => {
    const secret = "sensitive-argument-value";
    const extras = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`unknown${index}_${"x".repeat(1_000)}`, secret]));
    const result = await wrapped.validate({ elements: [{ ...box, ...extras }], expectedRevision: 1 });
    if (!result.issues) throw new Error("expected validation errors");
    const errors = result.issues.map((issue) => issue.message).join("; ");
    expect(errors.length).toBeLessThan(1_000);
    expect(errors).toContain("共 1000 个");
    expect(errors).not.toContain(secret);
    expect(result).not.toHaveProperty("value");
    const unrelated = await compactMcpSchema(z.object({ name: z.string() }).strict())["~standard"].validate({ name: secret, height: 20, angle: 90 });
    expect(unrelated.issues?.[0].message).not.toContain("rotation");
    expect(unrelated.issues?.[0].message).not.toContain("文字高度");
  });
});
