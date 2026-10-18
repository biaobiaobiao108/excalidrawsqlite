import { describe, expect, it } from "bun:test";
import { formatMcpSummary } from "../../server/mcp-summary";

describe("MCP operation summaries", () => {
  it("does not claim successful overflow coverage when no containers were checked", () => {
    const summary = formatMcpSummary("inspect_layout", { boardId: "free", complete: true, summary: { errors: 0, warnings: 0 },
      checks: { text_overflow: { status: "not_executed", checkedContainers: 0, skippedNoContainer: 8 } } });
    expect(summary).toContain("检查未完成");
    expect(summary).toContain("文字溢出检查未执行");
    expect(summary).toContain("groupId");
    expect(summary).toContain("不能视为无溢出");
    expect(summary).not.toContain("检查已完成");
  });

  it("locates diagnostic examples with types, severity and quantified overlap without dumping every issue", () => {
    const summary = formatMcpSummary("inspect_layout", { boardId: "issues", complete: true, summary: { errors: 0, warnings: 2 },
      issues: [ { type: "text_overlap", severity: "warning", severityHint: "minor", elementIds: ["source", "target"],
        metrics: { overlapDepth: 5.5, overlapRatio: 0.22 }, suggestedUpdate: { id: "target", dx: 0, dy: 36 } },
      { type: "text_overflow", severity: "warning", elementIds: ["body", "card"] } ] });
    expect(summary).toContain("text_overlap×1");
    expect(summary).toContain("text_overflow×1");
    expect(summary).toContain("source ↔ target");
    expect(summary).toContain("warning/text_overlap/minor");
    expect(summary).toContain("最大几何重叠 5.5 px（ratio 0.22）");
    expect(summary).toContain("dy=36");
    expect(summary.split("\n")).toHaveLength(2);
    expect(summary.length).toBeLessThanOrEqual(1024);
  });

  it("bounds diagnostic examples without truncating the board identity", () => {
    const summary = formatMcpSummary("inspect_layout", { boardId: "b".repeat(128), complete: true,
      summary: { errors: 0, warnings: 100 }, issues: Array.from({ length: 100 }, (_, index) => ({ type: "text_overlap", severity: "warning",
        elementIds: [String(index).padEnd(128, "x"), String(index + 1).padEnd(128, "y")] })) });
    expect(summary.length).toBeLessThanOrEqual(1024);
    expect(summary).toContain(`boardId=${"b".repeat(128)}`);
    expect(summary).toContain("示例");
    expect(summary).not.toContain("99".padEnd(128, "x"));
  });
  for (const operation of ["create_board", "create_diagram", "create_layout"]) {
    it(`${operation} identifies the board and idempotent replay`, () => {
      const data = { name: "系统全景图", addedCount: 222, boardId: "board-1", revision: 3, url: "https://board.test/board-1", elements: [{ text: "私人正文不要返回" }] };
      const summary = formatMcpSummary(operation, data);
      expect(summary).toContain("已创建「系统全景图」；新增 222 个图元");
      expect(summary).toContain("boardId=board-1；修订号 3");
      expect(summary.split("\n")).toHaveLength(2);
      expect(summary).toContain("直达链接：https://board.test/board-1");
      expect(summary).not.toContain("私人正文");
      expect(summary).not.toContain("structuredContent");
      const replay = formatMcpSummary(operation, { ...data, addedCount: 0, idempotentReplay: true });
      expect(replay).toContain("返回已有画板");
      expect(replay).toContain("新增 0 个图元");
      expect(replay).not.toContain("已创建");
    });
  }

  it("reads summary and paginated projections without confusing total and returned counts", () => {
    expect(formatMcpSummary("get_board", { boardId: "read", revision: 5, elementCount: 222 })).toContain("画板摘要；全板 222 个图元；boardId=read；修订号 5");
    const projection = formatMcpSummary("get_board", { boardId: "read", returnedElementCount: 10, elementCount: 222, nextOffset: 10, truncated: true, unsupportedElementIds: ["unsupported"] });
    expect(projection).toContain("已读取 10 个图元");
    expect(projection).toContain("还有下一页；内容已截断");
    expect(projection).toContain("1 个图元无法投影");
  });

  for (const [operation, key, label] of [["list_boards", "items", "画板"], ["list_folders", "folders", "文件夹"], ["list_tags", "tags", "标签"]]) {
    it(`${operation} summarizes pagination and empty lists`, () => {
      expect(formatMcpSummary(operation, { [key!]: [{ name: "private" }], nextCursor: "cursor" })).toBe(`已返回 1 个${label}；还有下一页`);
      expect(formatMcpSummary(operation, { [key!]: [], nextCursor: null })).toBe(`已返回 0 个${label}`);
    });
  }

  for (const operation of ["get_boards_batch", "batch_manage_boards"]) {
    it(`${operation} distinguishes all success, mixed and all failure`, () => {
      const key = operation === "get_boards_batch" ? "boards" : "results";
      expect(formatMcpSummary(operation, { [key]: [{ ok: true }, { ok: false }] })).toContain("成功 1，失败 1");
      expect(formatMcpSummary(operation, { [key]: [{ ok: false }, { ok: false }], truncated: true })).toContain("成功 0，失败 2；内容已截断");
      expect(formatMcpSummary(operation, { [key]: [{ ok: true, noop: true }, { ok: true }] })).toContain("成功 2，失败 0；1 个画板无需修改");
    });
  }

  it("batch management trusts actual counts rather than hypothetical input size", () => {
    expect(formatMcpSummary("batch_manage_boards", { succeeded: 3, failed: 2, partial: true, results: [] })).toContain("成功 3，失败 2");
  });

  it("inspection makes incompleteness and skipped containers visible", () => {
    const summary = formatMcpSummary("inspect_layout", { boardId: "inspection", revision: 2, complete: false, summary: { errors: 0, warnings: 1 }, checks: { text_overflow: { skippedNoContainer: 5, skippedAmbiguousContainer: 2 } } });
    expect(summary).toContain("0 个错误，1 个警告；检查未完成");
    expect(summary).toContain("boardId=inspection；修订号 2");
    expect(summary).toContain("5 个文字未找到容器，已跳过溢出检查");
    expect(summary).toContain("2 个文字容器存在歧义，已跳过");
    expect(formatMcpSummary("inspect_layout", { complete: true, summary: { errors: 1, warnings: 0 } })).toContain("1 个错误，0 个警告；检查已完成");
  });

  it("text measurements disclose estimation without exposing text", () => {
    expect(formatMcpSummary("measure_text", { width: 120.555, height: 48, lineCount: 2, text: "private" })).toBe("文字估算：120.56 × 48 px，2 行");
  });

  for (const [operation, countField, expected] of [["add_elements", "addedCount", "已新增 4 个图元"], ["copy_elements", "addedCount", "已复制 4 个图元"], ["remove_elements", "removedCount", "已移除 4 个图元"], ["update_element", "updatedCount", "已修改 4 个图元"], ["update_board", "updatedCount", "已修改 4 个图元"]]) {
    it(`${operation} reports actual modifications and no-op`, () => {
      const data = { [countField!]: 4, boardId: "updated", revision: 9 };
      expect(formatMcpSummary(operation!, data)).toContain(expected!);
      expect(formatMcpSummary(operation!, data)).toContain("boardId=updated；修订号 9");
      expect(formatMcpSummary(operation!, { ...data, noop: true })).toBe("无需修改；boardId=updated；修订号 9");
    });
  }

  it("atomic updates summarize added, updated and removed counts separately", () => {
    const summary = formatMcpSummary("update_board", { updatedCount: 2, addedCount: 3, removedCount: 5, overlapCheck: { complete: false }, autoBinding: { complete: false, bindings: [{}] }, warnings: [{}] });
    expect(summary).toContain("已修改 2 个图元；新增 3，移除 5");
    expect(summary).toContain("重叠检查未完成；自动吸附检查未完成；绑定 1 个箭头端点；1 条提示");
    expect(formatMcpSummary("update_board", { updatedCount: 0, addedCount: 0, removedCount: 0, boardId: "metadata" })).toContain("已更新画板设置");
  });

  for (const [operation, expected] of [["manage_board", "已修改画板元数据"], ["delete_board", "已将 1 个画板移入回收站"], ["restore_board", "已恢复 1 个画板"]]) {
    it(`${operation} explains state changes and no-op`, () => {
      expect(formatMcpSummary(operation!, { boardId: "managed", revision: 2 })).toBe(`${expected}；boardId=managed；修订号 2`);
      expect(formatMcpSummary(operation!, { boardId: "managed", revision: 2, noop: true })).toBe("无需修改；boardId=managed；修订号 2");
    });
  }

  for (const [operation, expected] of [["create_folder", "已创建文件夹"], ["ensure_folder", "已创建文件夹"], ["update_folder", "已修改文件夹"], ["delete_folder", "已删除文件夹"]]) {
    it(`${operation} retains folder identity and board counts`, () => {
      const summary = formatMcpSummary(operation!, { name: "设计", id: "folder", boardCount: 3, movedBoards: 3 });
      expect(summary).toContain(`${expected}「设计」；folderId=folder`);
      expect(summary).toContain(operation === "delete_folder" ? "已移动 3 个画板到根目录" : "含 3 个画板");
    });
  }

  it("folder reuse, unchanged metadata and deletion preview are explicit", () => {
    expect(formatMcpSummary("ensure_folder", { id: "reuse", created: false })).toContain("已复用文件夹；folderId=reuse");
    expect(formatMcpSummary("update_folder", { id: "same", noop: true })).toContain("文件夹无需修改；folderId=same");
    expect(formatMcpSummary("delete_folder", { dryRun: true, folder: { id: "preview", name: "设计" }, wouldMoveBoards: 7 })).toBe("删除文件夹预览「设计」；folderId=preview；将移动 7 个画板到根目录");
    expect(formatMcpSummary("delete_folder", { folderId: "deleted", movedBoards: 2 })).toContain("folderId=deleted；已移动 2 个画板到根目录");
  });

  it("names and URL controls cannot add lines, long names preserve locating fields", () => {
    const summary = formatMcpSummary("create_board", { name: "\n" + "名称".repeat(1000) + "\r\n", boardId: "stable", revision: 8, addedCount: 2, url: "https://test.example/board\nunsafe\u2028line" });
    expect(summary.length).toBeLessThanOrEqual(1024);
    expect(summary.split("\n")).toHaveLength(2);
    expect(summary).toContain("…」；新增 2 个图元；boardId=stable；修订号 8");
    expect(summary).toContain("直达链接：https://test.example/board unsafe line");
  });

  it("preserves long valid links and drops optional details before shortening locating information", () => {
    const url = "https://test.example/" + "x".repeat(800);
    const summary = formatMcpSummary("create_board", { name: "名称".repeat(1000), boardId: "stable", revision: 2, addedCount: 1, url });
    expect(summary).toContain(`\n直达链接：${url}`);
    expect(summary).toContain("boardId=stable");
    expect(summary.length).toBeLessThanOrEqual(1024);
    const tightUrl = "https://test.example/" + "x".repeat(970);
    const compact = formatMcpSummary("create_board", { name: "名称".repeat(1000), boardId: "stable", revision: 999, addedCount: 12345, url: tightUrl });
    expect(compact).toContain(`\n直达链接：${tightUrl}`);
    expect(compact).toContain("boardId=stable");
    expect(compact).not.toContain("名称");
    expect(compact.length).toBeLessThanOrEqual(1024);
  });

  it("omits oversized links explicitly instead of returning a broken URL", () => {
    const summary = formatMcpSummary("create_board", { boardId: "stable", addedCount: 1, url: "https://test.example/" + "x".repeat(2000) });
    expect(summary).toContain("boardId=stable");
    expect(summary).toContain("直达链接过长，使用 boardId 定位");
    expect(summary).not.toContain("https://test.example/");
    expect(summary.length).toBeLessThanOrEqual(1024);
  });

  it("errors retain their specific reason, and unknown operations are identified", () => {
    const reason = "修订号冲突：期望 2，实际 3\n请重新读取。";
    expect(formatMcpSummary("update_board", { error: { code: "CONFLICT", message: reason } })).toBe(`操作失败：${reason}`);
    expect(formatMcpSummary("new_tool", { boardId: "board" })).toBe("new_tool已完成；boardId=board");
  });
});
