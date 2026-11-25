import * as z from "zod/v4";
import { autoBindArrowEndpoints } from "./mcp-autobind";
import { measureMcpApi, measureMcpPhase, traceMcpTool } from "./mcp-trace";
import { formatMcpSummary } from "./mcp-summary";
import { HttpError } from "./errors";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { ServerRuntime } from "./types";

export const MCP_PATH = "/mcp";

export type ApiHandler = (req: Request) => Promise<Response>;
export type McpRequestHandler = {
  fetch: (req: Request) => Promise<Response>;
  close: () => Promise<void>;
};

export type SceneData = {
  id: string;
  name: string;
  elements: ExcalidrawElement[];
  appState: Record<string, unknown>;
  revision: number;
};

export const getMcpServerInstructions = (runtime: ServerRuntime) =>
  [
    "狐涂画板 MCP 使用简化绘图描述，参数以工具 schema 为准，不接受原生 Excalidraw JSON。",
    "创建时一次提交全部内容：自由绘图用 create_board，流程/时间线/架构/泳道用 create_diagram，卡片网格用 create_layout；创建重试复用 idempotencyKey。",
    "修改用 update_board 批量原地更新，复制用 copy_elements；保留已有图元 ID 和连接。已读版本通过 expectedRevision 校验，冲突后重新读取判断，不盲目重试。",
    "常规读取用 get_board 的 compact，修改前用 input；仅 elements 可直接作为 updates，只读 elementGeometry 不可写回。分页、截断及 unsupportedElementIds/warnings 不代表完整场景，不能据此覆盖全板。",
    "文字 width 控制换行，height 自动计算。形状 text 为绑定标签，复杂卡片的独立文字与背景用 groupId 关联；需要随节点移动的连线用绑定 arrow，无箭头时 endArrowhead=null。MCP 移动/复制只处理指定 IDs，不自动扩展整个分组。",
    "structuredContent 是完整结果，text 是简要摘要。单次失败检查 isError 和 ok/error；参数校验可能仅有 isError/text，批处理须逐项检查 ok/error。",
    "创建后 inspect_layout 检查，再按图元 ID 修改并复查；complete=false 或容器跳过不等于通过。诊断和文字尺寸均为几何估算，建议需结合设计意图判断，工具不自动修复。",
    `delete_board 仅移入回收站，restore_board 还原，无永久删除工具。${runtime.config.trashRetentionDays === 0 ? "回收站自动清理已禁用。" : `回收站保留 ${runtime.config.trashRetentionDays} 天后自动清理。`}`,
  ].join(" ");

export const cleanBoardRecord = (
  value: Record<string, unknown>,
): Record<string, unknown> => {
  const { thumbnail_file_id: _thumbnail, size: _size, ...clean } = value;
  if (typeof value.id === "string" && typeof value.revision === "number") {
    clean.boardId = value.id;
    delete clean.id;
  }
  if (typeof clean.boardId === "string") {
    for (const [stored, exposed] of [
      ["element_count", "elementCount"],
      ["folder_id", "folderId"],
      ["folder_name", "folderName"],
      ["created_at", "createdAt"],
      ["updated_at", "updatedAt"],
      ["last_opened_at", "lastOpenedAt"],
      ["deleted_at", "deletedAt"],
    ]) {
      if (Object.hasOwn(clean, stored)) {
        clean[exposed] = clean[stored];
        delete clean[stored];
      }
    }
  }
  if (typeof clean.icon === "string" && typeof clean.id === "string") {
    for (const [stored, exposed] of [
      ["scene_count", "boardCount"],
      ["created_at", "createdAt"],
      ["updated_at", "updatedAt"],
    ]) {
      if (Object.hasOwn(clean, stored)) {
        clean[exposed] = clean[stored];
        delete clean[stored];
      }
    }
  }
  return clean;
};

export const result = (value: Record<string, unknown>) =>
  measureMcpPhase("responseBuildMs", () => {
    const structuredContent = {
      ok: !value.error,
      ...cleanBoardRecord(value),
      ...Object.fromEntries(
        ["items", "boards", "results", "folders"]
          .filter((key) => Array.isArray(value[key]))
          .map((key) => [
            key,
            (value[key] as Record<string, unknown>[]).map(cleanBoardRecord),
          ]),
      ),
      ...(value.folder && typeof value.folder === "object"
        ? { folder: cleanBoardRecord(value.folder as Record<string, unknown>) }
        : {}),
    };
    return {
      structuredContent,
      content: [] as Array<{ type: "text"; text: string }>,
    };
  });

export const responseModeSchema = z
  .enum(["minimal", "ids"])
  .optional()
  .describe(
    "默认 minimal 仅返回修订号/数量/URL；ids 另含图元 ID 与 inputIndex 映射",
  );

export const drawingReceipt = (
  created: readonly ExcalidrawElement[],
  mode: "minimal" | "ids" = "minimal",
) => {
  if (mode === "minimal") return { addedCount: created.length };
  const ids = new Set(created.map((element) => element.id));
  const generated = created.filter(
    (element) =>
      element.type === "text" &&
      element.containerId &&
      ids.has(element.containerId),
  );
  const generatedIds = new Set(generated.map((element) => element.id));
  const requested = created.filter((element) => !generatedIds.has(element.id));
  return {
    addedCount: created.length,
    requestedElementIds: requested.map((element) => element.id),
    generatedElementIds: generated.map((element) => element.id),
    elementMap: requested.map((element, inputIndex) => ({
      inputIndex,
      elementId: element.id,
      ...(element.boundElements?.find((bound) => bound.type === "text")
        ? {
            labelId: element.boundElements.find(
              (bound) => bound.type === "text",
            )!.id,
          }
        : {}),
    })),
  };
};

export const positionReceipt = (
  elements: readonly ExcalidrawElement[],
  id: string,
) => {
  const element = elements.find((item) => item.id === id && !item.isDeleted);
  if (!element) return { elementId: id };
  const geometry = (item: ExcalidrawElement) => ({
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
  });
  const labelId = element.boundElements?.find(
    (bound) => bound.type === "text",
  )?.id;
  const label = labelId
    ? elements.find((item) => item.id === labelId && !item.isDeleted)
    : undefined;
  return {
    elementId: id,
    ...geometry(element),
    ...(label ? { label: { id: label.id, ...geometry(label) } } : {}),
  };
};

export const makeSafeTool =
  <T>(
    handler: (args: T) => Promise<ReturnType<typeof result>>,
    trace = false,
    operation = "tool",
  ) =>
  async (args: T) =>
    traceMcpTool(trace, operation, async () => {
      let completed: ReturnType<typeof result>;
      try {
        completed = await handler(args);
      } catch (error) {
        if (error instanceof HttpError) {
          completed = result({
            error: { code: error.code, message: error.message },
          });
        } else throw error;
      }
      return measureMcpPhase("responseBuildMs", () => ({
        ...completed,
        ...(completed.structuredContent.ok === false ? { isError: true } : {}),
        content: [
          {
            type: "text" as const,
            text: formatMcpSummary(operation, completed.structuredContent),
          },
        ],
      }));
    });

export const expectedRevisionSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("可选的读取时修订号；省略时读取最新版本，仍使用乐观锁保存");
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .refine((key) => !!key.trim(), "幂等 key 不能为空")
  .optional()
  .describe(
    "可选创建幂等 key，有效 24 小时；相同 key/参数重试返回已有画板当前摘要，addedCount=0，不重新绘制；改参数须换 key",
  );
export const autoBindSchema = z
  .boolean()
  .default(false)
  .describe(
    "显式开启时，对新箭头未绑定端点尝试 24px 内最近形状绑定；保留原坐标，歧义不猜。默认关闭；超过检测预算返回 autoBinding.complete=false",
  );
export const createIntent = (tool: string, args: Record<string, unknown>) => {
  const { idempotencyKey: _key, responseMode: _mode, ...payload } = args;
  return { tool, args: payload };
};
export const bindCreated = (
  drawing: { elements: ExcalidrawElement[]; created: ExcalidrawElement[] },
  enabled: boolean,
) => {
  if (!enabled) return { ...drawing, autoBinding: undefined };
  const createdIds = new Set(drawing.created.map((element) => element.id));
  const { elements, ...autoBinding } = autoBindArrowEndpoints(
    drawing.elements,
    [...createdIds],
  );
  return {
    elements,
    created: elements.filter((element) => createdIds.has(element.id)),
    autoBinding,
  };
};

export const boardMetadataSchema = {
  folderId: z
    .string()
    .min(1)
    .max(128)
    .nullable()
    .optional()
    .describe("目标文件夹 ID；null 移至根目录，不可与 folderName 同传"),
  folderName: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .optional()
    .describe("按精确名称获取或创建文件夹；重名拒绝，不可与 folderId 同传"),
  tags: z
    .array(z.string().trim().min(1).max(32))
    .max(12)
    .optional()
    .describe("完整标签列表，空数组清除；增删标签可用 manage_board"),
  favorite: z.boolean().optional(),
};

export const assertRevision = (
  current: SceneData,
  expectedRevision?: number,
) => {
  if (expectedRevision !== undefined && expectedRevision !== current.revision) {
    throw new HttpError(
      409,
      "REVISION_CONFLICT",
      `画板已更新，当前修订号为 ${current.revision}；请重新读取后判断修改。`,
    );
  }
};

export const getPathToken = (req: Request) => {
  const pathname = new URL(req.url).pathname;
  const prefix = `${MCP_PATH}/`;
  if (!pathname.startsWith(prefix)) {
    return "";
  }
  const encodedToken = pathname.slice(prefix.length);
  if (!encodedToken || encodedToken.includes("/")) {
    return "";
  }
  try {
    return decodeURIComponent(encodedToken);
  } catch {
    return "";
  }
};

export const createRequestBodyLimiter = (maxConcurrent: number) => {
  let active = 0;
  const waiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
    remove: () => void;
    settled: boolean;
  }> = [];

  const releaseSlot = () => {
    active = Math.max(0, active - 1);
    while (waiters.length) {
      const waiter = waiters.shift()!;
      if (waiter.settled) {
        continue;
      }
      waiter.settled = true;
      waiter.remove();
      active += 1;
      waiter.resolve();
      return;
    }
  };

  return {
    acquire: (signal?: AbortSignal) =>
      new Promise<() => void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("The request was aborted", "AbortError"));
          return;
        }
        if (active < maxConcurrent) {
          active += 1;
          let released = false;
          resolve(() => {
            if (!released) {
              released = true;
              releaseSlot();
            }
          });
          return;
        }

        const waiter = {
          resolve: () => {
            let released = false;
            resolve(() => {
              if (!released) {
                released = true;
                releaseSlot();
              }
            });
          },
          reject: (error: unknown) => {
            if (waiter.settled) {
              return;
            }
            waiter.settled = true;
            waiter.remove();
            reject(error);
          },
          remove: () => {
            signal?.removeEventListener("abort", abort);
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
          },
          settled: false,
        };
        const abort = () =>
          waiter.reject(
            new DOMException("The request was aborted", "AbortError"),
          );
        signal?.addEventListener("abort", abort, { once: true });
        waiters.push(waiter);
      }),
  };
};

export const createInternalApi =
  (apiHandler: ApiHandler, sessionToken: string) =>
  async <T>(
    path: string,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    body?: unknown,
  ) =>
    measureMcpApi(method, async () => {
      const req = new Request(`http://excalidraw-mcp.internal${path}`, {
        method,
        headers: {
          Cookie: `excalidraw_session=${sessionToken}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const res = await apiHandler(req);
      const responseBody = await res.text();
      let parsed: unknown;
      try {
        parsed = responseBody ? JSON.parse(responseBody) : null;
      } catch {
        parsed = responseBody;
      }
      if (!res.ok) {
        const error = parsed as { code?: string; error?: string } | null;
        throw new HttpError(
          res.status,
          error?.code || "MCP_API_ERROR",
          error?.error || `内部画板 API 请求失败（HTTP ${res.status}）`,
        );
      }
      return parsed as T;
    });
