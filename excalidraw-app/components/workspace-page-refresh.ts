import type {
  CloudScenePage,
  CloudScenePageOptions,
} from "../data/cloudStorage";

// Rebuild the loaded window from fresh cursors: merging the first page alone
// would retain deleted boards and skip boards whose sort position changed.
export const refreshWorkspacePage = async (
  options: CloudScenePageOptions,
  loadedCount: number,
  fetchPage: (options: CloudScenePageOptions) => Promise<CloudScenePage>,
  isCurrent: () => boolean,
): Promise<CloudScenePage | null> => {
  const targetCount = Math.max(100, loadedCount);
  const items: CloudScenePage["items"] = [];
  const seenIds = new Set<string>();
  let cursor: string | null = null;
  let totalCount = 0;
  do {
    if (!isCurrent()) {
      return null;
    }
    const page = await fetchPage({
      ...options,
      cursor,
      includeTotal: cursor === null,
      limit: Math.min(100, targetCount - items.length),
    });
    if (!isCurrent()) {
      return null;
    }
    if (cursor === null) totalCount = page.totalCount;
    for (const item of page.items) {
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id);
        items.push(item);
      }
    }
    if (!page.nextCursor || items.length >= targetCount) {
      return { ...page, items, totalCount };
    }
    cursor = page.nextCursor;
  } while (true);
};
