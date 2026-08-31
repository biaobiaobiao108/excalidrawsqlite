import fs from "node:fs";
import path from "node:path";

import type { ServerRuntime } from "./types";

export const buildStaticPath = (staticDir: string, pathname: string) => {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const normalized = decoded === "/" ? "/index.html" : decoded;
  const base = path.resolve(staticDir);
  const candidate = path.resolve(base, `.${normalized}`);
  if (candidate !== base && !candidate.startsWith(`${base}${path.sep}`)) {
    return null;
  }
  return candidate;
};
export const getStaticDir = (runtime: ServerRuntime) => {
  if (runtime.staticDir) {
    return path.resolve(runtime.staticDir);
  }
  const candidates = [
    path.resolve("./excalidraw-app/build"),
    path.resolve("./excalidraw-app/dist"),
    path.resolve("./dist"),
    path.resolve("./build"),
  ];
  return (
    candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0]
  );
};

export const getStaticCacheControl = (pathname: string) => {
  if (
    pathname === "/" ||
    pathname.endsWith("/index.html") ||
    pathname === "/sw.js" ||
    pathname === "/service-worker.js" ||
    pathname === "/manifest.webmanifest"
  ) {
    return "no-cache";
  }
  if (pathname.startsWith("/assets/") || pathname.startsWith("/fonts/")) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
};
