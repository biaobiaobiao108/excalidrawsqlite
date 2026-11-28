import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  colorSchema,
  createDrawingBatch,
  drawingElementSchema,
  elementUpdateSchema,
  removeDrawingElements,
  updateDrawingElements,
} from "./mcp-drawing";
import { copyDrawingSelection } from "./mcp-copy";
import { inspectDrawingOverlaps } from "./mcp-overlap";
import { getSceneFolderFields } from "./mcp-management";
import { measureMcpPhase } from "./mcp-trace";
import { compactMcpSchema } from "./mcp-schema";
import { HttpError } from "./errors";
import {
  drawingReceipt,
  responseModeSchema,
  result as buildMcpResult,
} from "./mcp-response";
import {
  assertRevision,
  autoBindSchema,
  bindCreated,
  boardMetadataSchema,
  expectedRevisionSchema,
  type makeSafeTool,
  type SceneData,
} from "./mcp-helpers";
import type { ServerRuntime } from "./types";

type ElementToolDeps = {
  runtime: ServerRuntime;
  api: <T>(
    path: string,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    body?: unknown,
  ) => Promise<T>;
  result: typeof buildMcpResult;
  safeTool: <T>(
    handler: (args: T) => Promise<ReturnType<typeof buildMcpResult>>,
    operation: string,
  ) => ReturnType<typeof makeSafeTool<T>>;
};

export const registerElementTools = (
  server: McpServer,
  { runtime, api, result, safeTool }: ElementToolDeps,
) => {
  server.registerTool(
    "add_elements",
    {
      title: "向画板绘制图元",
      description:
        "一次追加最多 1,000 个描述，不要逐个调用。矩形/椭圆/菱形的 text 自动绑定居中文字。混合删除、添加和改名优先 update_board。",
      inputSchema: compactMcpSchema(
        z
          .object({
            boardId: z.string().min(1).max(128),
            elements: z.array(drawingElementSchema).min(1).max(1_000),
            responseMode: responseModeSchema,
            expectedRevision: expectedRevisionSchema,
            autoBind: autoBindSchema,
          })
          .strict(),
      ),
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    safeTool(
      async ({
        boardId,
        elements,
        expectedRevision,
        responseMode,
        autoBind,
      }) => {
        const current = await api<SceneData>(
          `/api/scenes/${encodeURIComponent(boardId)}`,
          "GET",
        );
        assertRevision(current, expectedRevision);
        const {
          created,
          elements: merged,
          autoBinding,
        } = measureMcpPhase("transformMs", () =>
          bindCreated(createDrawingBatch(elements, current.elements), autoBind),
        );
        const saved = await api<{
          revision: number;
          updated_at: number;
        }>(`/api/scenes/${encodeURIComponent(boardId)}`, "PUT", {
          baseRevision: current.revision,
          elements: merged,
          appState: current.appState || {},
        });
        return result({
          boardId,
          elementCount: merged.length,
          ...drawingReceipt(created, responseMode),
          revision: saved.revision,
          ...(autoBinding ? { autoBinding } : {}),
        });
      },
      "add_elements",
    ),
  );

  server.registerTool(
    "copy_elements",
    {
      title: "复制图元到当前或其他画板",
      description:
        "复制最多1000个图元描述，自动生成新ID并重连选择集内箭头；标签ID会连同所属形状一起复制。targetBoardId省略表示同板复制，dx/dy默认20。外部绑定默认解绑；preserve仅同板可用。只复制input视图可写图元，不能投影时整次拒绝；省略的原生元数据见warnings。返回idMap，无需手工改ID。",
      inputSchema: compactMcpSchema(
        z.strictObject({
          boardId: z.string().min(1).max(128).describe("来源画板"),
          targetBoardId: z.string().min(1).max(128).optional(),
          elementIds: z.array(z.string().min(1).max(128)).min(1).max(1_000),
          dx: z.number().finite().min(-1_000_000).max(1_000_000).default(20),
          dy: z.number().finite().min(-1_000_000).max(1_000_000).default(20),
          externalBindings: z.enum(["detach", "preserve"]).default("detach"),
          expectedRevision: expectedRevisionSchema.describe(
            "目标画板的读取时修订号；同板复制也使用此字段",
          ),
          sourceExpectedRevision:
            expectedRevisionSchema.describe("跨板复制时可校验来源画板修订号"),
          responseMode: responseModeSchema,
        }),
      ),
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    safeTool(
      async ({
        boardId,
        targetBoardId = boardId,
        elementIds,
        dx,
        dy,
        externalBindings,
        expectedRevision,
        sourceExpectedRevision,
        responseMode,
      }) => {
        if (targetBoardId !== boardId && externalBindings === "preserve")
          throw new HttpError(
            400,
            "INVALID_COPY_BINDING",
            "跨画板复制不能保留选择集外绑定，请使用 externalBindings=detach",
          );
        const source = await api<SceneData>(
          `/api/scenes/${encodeURIComponent(boardId)}`,
          "GET",
        );
        assertRevision(source, sourceExpectedRevision);
        const target =
          targetBoardId === boardId
            ? source
            : await api<SceneData>(
                `/api/scenes/${encodeURIComponent(targetBoardId)}`,
                "GET",
              );
        assertRevision(target, expectedRevision);
        const { copied, created, merged } = measureMcpPhase(
          "transformMs",
          () => {
            const copied = copyDrawingSelection(
              source.elements,
              elementIds,
              target.elements,
              dx,
              dy,
              externalBindings === "preserve",
            );
            const batch = createDrawingBatch(copied.elements, target.elements);
            return {
              copied,
              created: batch.created,
              merged: batch.elements,
            };
          },
        );
        const overlaps = inspectDrawingOverlaps(
          target.elements,
          merged,
          copied.elements.map((element) => element.id!),
        );
        const saved = await api<{ revision: number }>(
          `/api/scenes/${encodeURIComponent(targetBoardId)}`,
          "PUT",
          {
            baseRevision: target.revision,
            elements: merged,
            appState: target.appState,
          },
        );
        return result({
          boardId: targetBoardId,
          sourceBoardId: boardId,
          revision: saved.revision,
          elementCount: merged.length,
          ...drawingReceipt(created, responseMode),
          idMap: copied.idMap,
          groupIdMap: copied.groupIdMap,
          ...overlaps,
          warnings: [...copied.warnings, ...overlaps.warnings],
        });
      },
      "copy_elements",
    ),
  );

  server.registerTool(
    "update_board",
    {
      title: "批量修改画板",
      description:
        "一次原子保存：先删除 removeElementIds，再添加 elements，再按 updates 原地修改；还可同步改名、背景、收藏、标签及文件夹。修改保留图元ID与连接。新文件夹可用 folderName 自动获取或创建。",
      inputSchema: compactMcpSchema(
        z
          .object({
            boardId: z.string().min(1).max(128),
            expectedRevision: expectedRevisionSchema,
            elements: z
              .array(drawingElementSchema)
              .min(1)
              .max(1_000)
              .optional(),
            removeElementIds: z
              .array(z.string().min(1).max(128))
              .min(1)
              .max(1_000)
              .optional(),
            updates: z
              .array(elementUpdateSchema)
              .min(1)
              .max(1_000)
              .optional()
              .describe(
                "修改对象数组 [{id,...}]；新增用 elements，可在同次添加后更新该新 ID",
              ),
            responseMode: responseModeSchema,
            name: z.string().trim().min(1).max(120).optional(),
            autoBind: autoBindSchema,
            backgroundColor: colorSchema.optional(),
            ...boardMetadataSchema,
          })
          .strict(),
      ),
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    safeTool(
      async ({
        boardId,
        expectedRevision,
        elements,
        removeElementIds,
        updates,
        name,
        backgroundColor,
        folderId,
        folderName,
        tags,
        favorite,
        responseMode,
        autoBind,
      }) => {
        if (
          !elements &&
          !removeElementIds &&
          !updates &&
          name === undefined &&
          backgroundColor === undefined &&
          folderId === undefined &&
          folderName === undefined &&
          tags === undefined &&
          favorite === undefined
        ) {
          throw new HttpError(
            400,
            "EMPTY_UPDATE",
            "请提供图元修改或画板元数据中至少一项。",
          );
        }
        const current = await api<SceneData>(
          `/api/scenes/${encodeURIComponent(boardId)}`,
          "GET",
        );
        assertRevision(current, expectedRevision);
        const { remaining, created, updated, autoBinding } = measureMcpPhase(
          "transformMs",
          () => {
            const remaining = removeDrawingElements(
              current.elements,
              removeElementIds || [],
            );
            const { created, elements: merged } = createDrawingBatch(
              elements || [],
              remaining.elements,
            );
            const updated = updateDrawingElements(merged, updates || []);
            const attached = bindCreated(
              { created, elements: updated.elements },
              autoBind,
            );
            return {
              remaining,
              created: attached.created,
              updated: { ...updated, elements: attached.elements },
              autoBinding: attached.autoBinding,
            };
          },
        );
        if (
          !remaining.removedCount &&
          !created.length &&
          !updated.updatedCount &&
          name === undefined &&
          backgroundColor === undefined &&
          folderId === undefined &&
          folderName === undefined &&
          tags === undefined &&
          favorite === undefined
        ) {
          return result({
            boardId,
            revision: current.revision,
            elementCount: current.elements.length,
            ...drawingReceipt(created, responseMode),
            removedCount: 0,
            requestedRemovedCount: remaining.requestedRemovedCount,
            cascadeRemovedCount: remaining.cascadeRemovedCount,
            notFoundIds: remaining.notFoundIds,
            updatedCount: 0,
            noop: true,
          });
        }
        const folder = getSceneFolderFields({ folderId, folderName }, runtime);
        const changedIds = [
          ...created.map((element) => element.id),
          ...(updates || []).map((update) => update.id),
        ];
        const overlaps = changedIds.length
          ? inspectDrawingOverlaps(
              current.elements,
              updated.elements,
              changedIds,
            )
          : {};
        const saved = await api<{ revision: number }>(
          `/api/scenes/${encodeURIComponent(boardId)}`,
          "PUT",
          {
            baseRevision: current.revision,
            ...(name === undefined ? {} : { name }),
            elements: updated.elements,
            appState: {
              ...current.appState,
              ...(backgroundColor === undefined
                ? {}
                : { viewBackgroundColor: backgroundColor }),
            },
            ...folder,
            tags,
            favorite,
          },
        );
        return result({
          boardId,
          revision: saved.revision,
          elementCount: updated.elements.length,
          ...drawingReceipt(created, responseMode),
          removedCount: remaining.removedCount,
          requestedRemovedCount: remaining.requestedRemovedCount,
          cascadeRemovedCount: remaining.cascadeRemovedCount,
          notFoundIds: remaining.notFoundIds,
          updatedCount: updated.updatedCount,
          ...(autoBinding ? { autoBinding } : {}),
          ...overlaps,
        });
      },
      "update_board",
    ),
  );
};
