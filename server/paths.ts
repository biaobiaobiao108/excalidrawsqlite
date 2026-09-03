import path from "node:path";

export const PROJECT_ROOT = path.resolve(import.meta.dir, "..");

export const resolveProjectPath = (
  value: string | undefined,
  fallback: string,
) => path.resolve(PROJECT_ROOT, value || fallback);
