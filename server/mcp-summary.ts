type Data = Record<string, unknown>;
const record = (value: unknown): Data => value && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const singleLine = (value: unknown) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim() : "";
const shorten = (value: string, length: number) => value.length > length ? value.slice(0, Math.max(0, length - 1)) + "…" : value;
const count = (data: Data, key: string) => typeof data[key] === "number" && Number.isFinite(data[key]) && data[key] >= 0 ? data[key] as number : 0;
const list = (data: Data, key: string): unknown[] => Array.isArray(data[key]) ? data[key] as unknown[] : [];
const number = (value: number) => Math.round(value * 100) / 100;
const name = (value: unknown) => {
  const cleaned = singleLine(value);
  return cleaned ? `「${shorten(cleaned, 40)}」` : "";
};
const boardLocation = (data: Data) => [singleLine(data.boardId) ? `boardId=${singleLine(data.boardId)}` : "", typeof data.revision === "number" ? `修订号 ${data.revision}` : ""].filter(Boolean);
const pageStatus = (data: Data) => [data.nextCursor != null || data.nextOffset != null ? "还有下一页" : "", data.truncated === true ? "内容已截断" : ""].filter(Boolean);
const diagnostics = (data: Data) => {
  const details: string[] = [];
  if (record(data.overlapCheck).complete === false || data.overlapCheckComplete === false) details.push("重叠检查未完成");
  const binding = record(data.autoBinding);
  if (binding.complete === false) details.push("自动吸附检查未完成");
  if (list(binding, "bindings").length) details.push(`绑定 ${list(binding, "bindings").length} 个箭头端点`);
  if (list(data, "warnings").length) details.push(`${list(data, "warnings").length} 条提示`);
  return details;
};

export const formatMcpSummary = (operation: string, data: Data): string => {
  if (data.error) {
    const error = record(data.error);
    return `操作失败：${typeof error.message === "string" ? error.message : singleLine(error.code) || "未知错误"}`;
  }
  let parts: string[];
  let includeUrl = false;
  switch (operation) {
    case "create_board":
    case "create_diagram":
    case "create_layout":
      parts = [data.idempotentReplay === true ? `返回已有画板${name(data.name)}` : `已创建${name(data.name) || "画板"}`, `新增 ${count(data, "addedCount")} 个图元`, ...boardLocation(data), ...diagnostics(data)];
      includeUrl = true;
      break;
    case "get_board":
      parts = [typeof data.returnedElementCount === "number" ? `已读取 ${count(data, "returnedElementCount")} 个图元` : `已读取画板摘要；全板 ${count(data, "elementCount")} 个图元`, ...boardLocation(data), ...pageStatus(data), ...diagnostics(data)];
      if (list(data, "unsupportedElementIds").length) parts.push(`${list(data, "unsupportedElementIds").length} 个图元无法投影为可写描述`);
      break;
    case "list_boards":
    case "list_folders":
    case "list_tags": {
      const key = operation === "list_boards" ? "items" : operation === "list_folders" ? "folders" : "tags";
      const label = operation === "list_boards" ? "画板" : operation === "list_folders" ? "文件夹" : "标签";
      parts = [`已返回 ${list(data, key).length} 个${label}`, ...pageStatus(data)];
      break;
    }
    case "get_boards_batch":
    case "batch_manage_boards": {
      const outcomes = list(data, operation === "get_boards_batch" ? "boards" : "results").map(record);
      const succeeded = typeof data.succeeded === "number" ? count(data, "succeeded") : outcomes.filter((item) => item.ok === true).length;
      const failed = typeof data.failed === "number" ? count(data, "failed") : outcomes.length - succeeded;
      parts = [`批量${operation === "get_boards_batch" ? "读取" : "管理"}：成功 ${succeeded}，失败 ${failed}`, ...pageStatus(data)];
      const unchanged = outcomes.filter((item) => item.ok === true && item.noop === true).length;
      if (unchanged) parts.push(`${unchanged} 个画板无需修改`);
      break;
    }
    case "inspect_layout": {
      const summary = record(data.summary);
      const overflow = record(record(data.checks).text_overflow);
      parts = [`布局检查：${count(summary, "errors")} 个错误，${count(summary, "warnings")} 个警告`, data.complete === true ? "检查已完成" : "检查未完成", ...boardLocation(data)];
      if (count(overflow, "skippedNoContainer")) parts.push(`${count(overflow, "skippedNoContainer")} 个文字未找到容器，已跳过溢出检查`);
      if (count(overflow, "skippedAmbiguousContainer")) parts.push(`${count(overflow, "skippedAmbiguousContainer")} 个文字容器存在歧义，已跳过`);
      break;
    }
    case "measure_text":
      parts = [`文字估算：${number(count(data, "width"))} × ${number(count(data, "height"))} px，${count(data, "lineCount")} 行`];
      break;
    case "add_elements":
    case "copy_elements":
    case "remove_elements":
    case "update_element":
    case "update_board": {
      const action = operation === "add_elements" ? `已新增 ${count(data, "addedCount")} 个图元` : operation === "copy_elements" ? `已复制 ${count(data, "addedCount")} 个图元` : operation === "remove_elements" ? `已移除 ${count(data, "removedCount")} 个图元` : `已修改 ${count(data, "updatedCount")} 个图元`;
      parts = [data.noop === true ? "无需修改" : operation === "update_board" && !count(data, "updatedCount") && !count(data, "addedCount") && !count(data, "removedCount") ? "已更新画板设置" : action];
      if (operation === "update_board" && !data.noop) parts.push(`新增 ${count(data, "addedCount")}，移除 ${count(data, "removedCount")}`);
      parts.push(...boardLocation(data), ...diagnostics(data));
      break;
    }
    case "manage_board":
    case "delete_board":
    case "restore_board":
      parts = [data.noop === true ? "无需修改" : operation === "manage_board" ? "已修改画板元数据" : operation === "delete_board" ? "已将 1 个画板移入回收站" : "已恢复 1 个画板", ...boardLocation(data)];
      break;
    case "create_folder":
    case "ensure_folder":
    case "update_folder":
    case "delete_folder": {
      const folder = data.dryRun === true ? record(data.folder) : data;
      const action = data.dryRun === true ? "删除文件夹预览" : data.noop === true ? "文件夹无需修改" : operation === "ensure_folder" && data.created === false ? "已复用文件夹" : operation === "delete_folder" ? "已删除文件夹" : operation === "update_folder" ? "已修改文件夹" : "已创建文件夹";
      const folderId = singleLine(folder.folderId) || singleLine(folder.id);
      parts = [`${action}${name(folder.name)}`, ...(folderId ? [`folderId=${folderId}`] : [])];
      parts.push(data.dryRun === true ? `将移动 ${count(data, "wouldMoveBoards")} 个画板到根目录` : operation === "delete_folder" ? `已移动 ${count(data, "movedBoards")} 个画板到根目录` : `含 ${count(folder, "boardCount")} 个画板`);
      break;
    }
    default:
      parts = [`${shorten(singleLine(operation), 80) || "操作"}已完成`, ...boardLocation(data)];
  }
  const firstLine = shorten(parts.filter(Boolean).join("；"), 1024);
  const url = includeUrl ? singleLine(data.url) : "";
  if (!url || firstLine.length + 8 >= 1024) return firstLine;
  return `${firstLine}\n直达链接：${shorten(url, 1024 - firstLine.length - 6)}`;
};
