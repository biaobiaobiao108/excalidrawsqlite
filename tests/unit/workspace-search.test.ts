import { describe, expect, it } from "bun:test";
import { parseWorkspaceSearchQuery } from "../../excalidraw-app/components/workspace-search";

describe("workspace search query parsing", () => {
  it("keeps ordinary text as a full text query", () => {
    expect(parseWorkspaceSearchQuery("  测试画板  ")).toEqual({
      query: "测试画板",
    });
  });

  it("treats a leading hash as an exact tag query", () => {
    expect(parseWorkspaceSearchQuery("  #测试标签  ")).toEqual({
      tag: "测试标签",
    });
  });

  it("preserves spaces inside a tag name", () => {
    expect(parseWorkspaceSearchQuery("#项目 标签")).toEqual({
      tag: "项目 标签",
    });
  });

  it("treats a lone hash as ordinary text and empty input as no query", () => {
    expect(parseWorkspaceSearchQuery("#")).toEqual({ query: "#" });
    expect(parseWorkspaceSearchQuery("  ")).toEqual({ query: undefined });
  });
});
