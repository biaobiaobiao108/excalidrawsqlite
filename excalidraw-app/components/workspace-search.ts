import type { CloudScenePageOptions } from "../data/cloudStorage";

export const parseWorkspaceSearchQuery = (
  input: string,
): Pick<CloudScenePageOptions, "query" | "tag"> => {
  const query = input.trim();
  if (query.startsWith("#") && query.slice(1).trim()) {
    return { tag: query.slice(1).trim() };
  }
  return { query: query || undefined };
};
