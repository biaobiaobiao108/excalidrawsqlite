import fs from "node:fs";
import path from "node:path";
import { broadcastDevReload } from "./dev-reload";
import { buildFrontend } from "../scripts/build-frontend";
import { PROJECT_ROOT } from "./paths";

export const startDevWatcher = async (): Promise<() => void> => {
  console.log("[Dev] 📦 正在生成开发前端构建...");
  await buildFrontend({ isDev: true });

  const watchTargets = [
    { path: path.join(PROJECT_ROOT, "excalidraw-app"), recursive: true },
    { path: path.join(PROJECT_ROOT, "packages"), recursive: true },
    { path: path.join(PROJECT_ROOT, "public"), recursive: true },
    { path: PROJECT_ROOT, recursive: false },
    {
      path: path.join(PROJECT_ROOT, "scripts", "build-frontend.ts"),
      recursive: false,
    },
  ];

  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  let isBuilding = false;
  let rebuildPending = false;

  const isIgnoredChange = (filename: string) => {
    const parts = filename.split(/[\\/]/).filter(Boolean);
    return parts.some(
      (part) =>
        ["build", "dist", "node_modules", ".git"].includes(part) ||
        part.endsWith(".tmp"),
    );
  };

  const handleRebuild = () => {
    if (rebuildTimer) {
      clearTimeout(rebuildTimer);
    }
    rebuildTimer = setTimeout(async () => {
      rebuildTimer = null;
      if (isBuilding) {
        rebuildPending = true;
        return;
      }
      isBuilding = true;
      do {
        rebuildPending = false;
        try {
          console.log("\n[Dev] ⚡ 检测到前端源码变动，正在重新打包...");
          await buildFrontend({ isDev: true });
          console.log("[Dev] 📢 编译完成，正在通知浏览器热刷新...");
          broadcastDevReload();
        } catch (error) {
          console.error("[Dev] ❌ 增量打包失败:", error);
        }
      } while (rebuildPending);
      isBuilding = false;
    }, 100);
  };

  const watchers: fs.FSWatcher[] = [];
  for (const target of watchTargets) {
    if (fs.existsSync(target.path)) {
      try {
        const watcher = fs.watch(
          target.path,
          { recursive: target.recursive },
          (_event, filename) => {
            if (!filename) return;
            const name = String(filename);
            if (isIgnoredChange(name)) {
              return;
            }
            if (
              target.path === PROJECT_ROOT &&
              !/^\.env(?:\.[A-Za-z0-9_-]+)?$/.test(path.basename(name))
            ) {
              return;
            }
            handleRebuild();
          },
        );
        watchers.push(watcher);
      } catch (err) {
        console.warn(`[Dev] 无法监听路径 ${target.path}:`, err);
      }
    }
  }

  console.info(
    "[Dev] 👁️ 前端源码热重载观察器已就绪 (excalidraw-app, packages, public, env)",
  );

  return () => {
    if (rebuildTimer) {
      clearTimeout(rebuildTimer);
    }
    for (const w of watchers) {
      try {
        w.close();
      } catch {}
    }
  };
};
