import { describe, expect, it } from "bun:test";
import { refreshWorkspacePage } from "../../excalidraw-app/components/workspace-page-refresh";
import type {
  CloudScenePageOptions,
  CloudSceneSummary,
} from "../../excalidraw-app/data/cloudStorage";

const board = (id: string) => ({ id } as CloudSceneSummary);

describe("workspace loaded-page refresh", () => {
  it("preserves the loaded window and derives its cursor from fresh ordering", async () => {
    const boards = Array.from({ length: 110 }, (_, i) => board(`board-${i}`));
    const requests: CloudScenePageOptions[] = [];
    const result = await refreshWorkspacePage(
      { tag: "work", sort: "created" },
      105,
      async (options) => {
        requests.push(options);
        const offset = Number(options.cursor || 0);
        const end = offset + options.limit!;
        return {
          items: boards.slice(offset, end),
          nextCursor: end < boards.length ? String(end) : null,
          totalCount: boards.length,
        };
      },
      () => true,
    );
    expect(result?.items).toEqual(boards.slice(0, 105));
    expect(result?.nextCursor).toBe("105");
    expect(requests).toEqual([
      { tag: "work", sort: "created", cursor: null, limit: 100 },
      { tag: "work", sort: "created", cursor: "100", limit: 5 },
    ]);
  });

  it("removes deleted boards instead of retaining stale later pages", async () => {
    const freshBoards = Array.from({ length: 102 }, (_, i) => board(`fresh-${i}`));
    const result = await refreshWorkspacePage(
      { trash: true },
      205,
      async ({ cursor, limit }) => {
        const offset = Number(cursor || 0);
        const end = offset + limit!;
        return {
          items: freshBoards.slice(offset, end),
          nextCursor: end < freshBoards.length ? String(end) : null,
          totalCount: freshBoards.length,
        };
      },
      () => true,
    );
    expect(result).toEqual({ items: freshBoards, nextCursor: null, totalCount: 102 });
  });

  it("discards an obsolete refresh without fetching more pages", async () => {
    let current = true;
    let requests = 0;
    const result = await refreshWorkspacePage(
      {},
      200,
      async () => {
        requests += 1;
        current = false;
        return { items: [board("old-query")], nextCursor: "next", totalCount: 200 };
      },
      () => current,
    );
    expect(result).toBeNull();
    expect(requests).toBe(1);
  });
});
