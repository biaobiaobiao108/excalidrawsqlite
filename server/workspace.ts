import type { ServerRuntime } from "./types";

type WorkspaceCounts = {
  sceneCount: number;
  favoriteCount: number;
  trashCount: number;
};

const workspaceQueries = new WeakMap<
  ServerRuntime,
  {
    counts: ReturnType<ServerRuntime["db"]["query"]>;
    tags: ReturnType<ServerRuntime["db"]["query"]>;
  }
>();

export const getWorkspaceStats = (runtime: ServerRuntime) => {
  // The trash count and cutoff form one clearable snapshot. Newly trashed
  // boards after this cutoff stay out of a later "empty trash" operation.
  const trashCutoff = Date.now();
  let queries = workspaceQueries.get(runtime);
  if (!queries) {
    queries = {
      counts: runtime.db.query(`
        SELECT COUNT(CASE WHEN deleted_at IS NULL THEN 1 END) AS sceneCount,
               COUNT(CASE WHEN deleted_at IS NULL AND is_favorite = 1 THEN 1 END) AS favoriteCount,
               COUNT(CASE WHEN deleted_at <= ? THEN 1 END) AS trashCount
        FROM scenes
      `),
      tags: runtime.db.query(`
        SELECT DISTINCT tag.value AS tag
        FROM scenes, json_each(scenes.tags_json) AS tag
        WHERE scenes.deleted_at IS NULL AND tag.type = 'text'
        ORDER BY tag.value
      `),
    };
    workspaceQueries.set(runtime, queries);
  }
  const counts = queries.counts.get(trashCutoff) as WorkspaceCounts;
  const tags = queries.tags.all() as Array<{ tag: string }>;
  return { ...counts, trashCutoff, tags: tags.map(({ tag }) => tag) };
};
