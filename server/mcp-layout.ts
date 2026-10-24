import * as z from "zod/v4";
import {
  colorSchema,
  drawingElementSchema,
  measureDrawingText,
} from "./mcp-drawing";
import { randomBase64Url } from "./crypto";

const fontFamily = z.enum(["Excalifont", "system", "WenKai"]);
export const measureTextSchema = z
  .object({
    text: z.string().min(1).max(10_000),
    fontFamily: fontFamily.optional(),
    fontSize: z.number().finite().min(1).max(512).optional(),
    width: z
      .number()
      .finite()
      .positive()
      .max(1_000_000)
      .optional()
      .describe(
        "固定换行宽度；省略时计算自然宽度。返回服务端估算，与 MCP 文字创建一致，实际字体请预览确认",
      ),
  })
  .strict();

const cardSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("可选稳定卡片 ID，返回背景、标题、正文 ID；无需手写坐标"),
    title: z.string().max(2_000).optional(),
    body: z.string().max(10_000).optional(),
    backgroundColor: colorSchema.optional(),
  })
  .strict()
  .refine(
    (card) => !!card.title || !!card.body,
    "卡片至少需要非空 title 或 body",
  );

export const layoutSchema = z
  .object({
    mode: z
      .literal("grid")
      .default("grid")
      .describe(
        "卡片网格，按输入顺序从左到右、从上到下；每行高度按最高卡片自动计算",
      ),
    cards: z.array(cardSchema).min(1).max(100),
    columns: z.number().int().min(1).max(12).default(3),
    x: z.number().finite().min(-900_000).max(900_000).default(0),
    y: z.number().finite().min(-900_000).max(900_000).default(0),
    cardWidth: z.number().finite().min(40).max(4_000).default(320),
    gap: z.number().finite().min(0).max(1_000).default(24),
    padding: z.number().finite().min(0).max(500).default(20),
    textGap: z.number().finite().min(0).max(200).default(12),
    minCardHeight: z.number().finite().min(1).max(10_000).default(100),
    titleFontSize: z.number().finite().min(1).max(128).default(24),
    bodyFontSize: z.number().finite().min(1).max(128).default(18),
    fontFamily: fontFamily.default("system"),
    strokeColor: colorSchema.default("#d0d7de"),
    backgroundColor: colorSchema.default("#ffffff"),
    textColor: colorSchema.default("#1f2328"),
  })
  .strict()
  .refine(
    (value) => value.cardWidth > 2 * value.padding,
    "cardWidth 必须大于两倍 padding",
  )
  .refine(
    (value) =>
      value.cards.every(
        (card) =>
          (!card.title ||
            value.cardWidth - value.padding * 2 >= value.titleFontSize) &&
          (!card.body ||
            value.cardWidth - value.padding * 2 >= value.bodyFontSize),
      ),
    "卡片可用文字宽度至少应容纳一个对应字号的字符；请增大 cardWidth、减小 padding 或字号",
  )
  .refine(
    (value) =>
      new Set(value.cards.filter((card) => card.id).map((card) => card.id))
        .size === value.cards.filter((card) => card.id).length,
    "卡片 ID 不得重复",
  );

/** A bounded deterministic grid; text uses the same estimator as the writable drawing API. */
export const buildDrawingLayout = (input: z.infer<typeof layoutSchema>) => {
  const width = input.cardWidth - input.padding * 2;
  const measured = input.cards.map((card) => {
    const title = card.title
      ? measureDrawingText({
          text: card.title,
          width,
          fontSize: input.titleFontSize,
          fontFamily: input.fontFamily,
        })
      : undefined;
    const body = card.body
      ? measureDrawingText({
          text: card.body,
          width,
          fontSize: input.bodyFontSize,
          fontFamily: input.fontFamily,
        })
      : undefined;
    const height = Math.max(
      input.minCardHeight,
      input.padding * 2 +
        (title?.height ?? 0) +
        (body?.height ?? 0) +
        (title && body ? input.textGap : 0),
    );
    return { card, title, body, height };
  });
  const elements: z.infer<typeof drawingElementSchema>[] = [];
  const cards: {
    id: string;
    groupId: string;
    elementIds: string[];
    x: number;
    y: number;
    width: number;
    height: number;
  }[] = [];
  let y = input.y;
  for (let start = 0; start < measured.length; start += input.columns) {
    const row = measured.slice(start, start + input.columns);
    const rowHeight = Math.max(...row.map((entry) => entry.height));
    for (let column = 0; column < row.length; column++) {
      const { card, title, body, height } = row[column];
      const id = card.id ?? `card_${randomBase64Url(12)}`;
      const groupId = `group_${randomBase64Url(12)}`;
      const backgroundId = `${id}:background`,
        elementIds = [backgroundId];
      const x = input.x + column * (input.cardWidth + input.gap);
      elements.push(
        drawingElementSchema.parse({
          type: "rectangle",
          id: backgroundId,
          groupId,
          x,
          y,
          width: input.cardWidth,
          height,
          strokeColor: input.strokeColor,
          backgroundColor: card.backgroundColor ?? input.backgroundColor,
          fillStyle: "solid",
          roughness: 0,
          roundness: 12,
        }),
      );
      let textY = y + input.padding;
      for (const [part, text, fontSize] of [
        ["title", title, input.titleFontSize],
        ["body", body, input.bodyFontSize],
      ] as const) {
        if (!text) continue;
        const textId = `${id}:${part}`;
        elements.push(
          drawingElementSchema.parse({
            type: "text",
            id: textId,
            groupId,
            x: x + input.padding,
            y: textY,
            width,
            text: text.originalText,
            fontSize,
            fontFamily: input.fontFamily,
            strokeColor: input.textColor,
            roughness: 0,
          }),
        );
        elementIds.push(textId);
        textY += text.height + input.textGap;
      }
      cards.push({
        id,
        groupId,
        elementIds,
        x,
        y,
        width: input.cardWidth,
        height,
      });
    }
    y += rowHeight + input.gap;
  }
  return {
    elements,
    cards,
    bounds: {
      x: input.x,
      y: input.y,
      width:
        Math.min(input.columns, input.cards.length) *
          (input.cardWidth + input.gap) -
        input.gap,
      height: y - input.y - input.gap,
    },
    estimated: true as const,
    note: "文本高度使用 MCP 服务端估算器，非浏览器实际字体测量；每张卡片背景、标题、正文共享原生分组。请预览复查字体差异。",
  };
};
