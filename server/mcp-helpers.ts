import * as z from "zod/v4";

import { autoBindArrowEndpoints } from "./mcp-autobind";
import { measureMcpPhase, traceMcpTool } from "./mcp-trace";
import { formatMcpSummary } from "./mcp-summary";
import { mcpError, result as buildMcpResult } from "./mcp-response";
import { HttpError } from "./errors";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { ServerRuntime } from "./types";

export const MCP_PATH = "/mcp";

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
    "狐涂画板 MCP 使用简化绘图描述。",
    "查找和读取画板。list_boards 按名称或分类找板，get_board 按 boardId 读单板，get_boards_batch 批读。常规查看用 view=compact，准备修改用 view=input。回写只取 input 视图的 elements。遇到分页、截断或投影警告时，核对读取范围再做增量修改。",
    "创建时一次提交全部内容。create_board 自由绘图，create_diagram 绘制流程、时间线、架构或泳道，create_layout 生成卡片网格。创建重试复用 idempotencyKey。",
    "编辑图元。update_board 一次合并多项修改，update_element 按 ID 改单个图元，add_elements 追加，remove_elements 按 ID 移除，copy_elements 同板或跨板复制。随节点移动的连线用绑定箭头，整组移动或复制需传齐图元 ID。",
    "检查布局。measure_text 估算文字尺寸和换行，inspect_layout 检查重叠、溢出和连接。修改后复查，complete=false 时确认检查覆盖范围。",
    "整理画板。manage_board 改名、收藏、移动或改标签，delete_board 移入回收站，restore_board 恢复，batch_manage_boards 批量管理、移入回收站或恢复。",
    "文件夹与标签。list_folders 查文件夹，list_tags 查在用标签。ensure_folder 按名称获取或创建，create_folder 创建且重名时报错，update_folder 改名称、颜色或图标，delete_folder 删除文件夹并把画板移至根目录。",
    "从 structuredContent 读取结果，检查 ok、error.code 和 suggestedAction，批量操作逐项检查结果。修改画板用读到的 revision 作为 expectedRevision，遇到冲突先重读再决定是否重试。",
    runtime.config.trashRetentionDays === 0
      ? "回收站自动清理已禁用。"
      : `回收站保留 ${runtime.config.trashRetentionDays} 天后自动清理。`,
  ].join("\n\n");

export const makeSafeTool =
  <T>(
    handler: (args: T) => Promise<ReturnType<typeof buildMcpResult>>,
    trace = false,
    operation = "tool",
  ) =>
  async (args: T) =>
    traceMcpTool(trace, operation, async () => {
      let completed: ReturnType<typeof buildMcpResult>;
      try {
        completed = await handler(args);
      } catch (error) {
        if (error instanceof HttpError) {
          completed = buildMcpResult({ error: mcpError(error) });
        } else throw error;
      }
      return measureMcpPhase("responseBuildMs", () => ({
        ...completed,
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
      { currentRevision: current.revision },
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
