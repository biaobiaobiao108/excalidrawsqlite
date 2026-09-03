import fs from "node:fs";
import path from "node:path";
import { broadcastDevReload } from "./dev-reload";
import { buildFrontend } from "../scripts/build-frontend";

export const startDevWatcher = async (): Promise<() => void> => {
  const buildIndexHtml = path.resolve("./excalidraw-app/build/index.html");
  if (!fs.existsSync(buildIndexHtml)) {
    console.log("[Dev] 📦 首次开发启动，正在执行初始前端编译...");
    await buildFrontend({ isDev: true });
  }

  const watchDirs = [
    path.resolve("./excalidraw-app"),
    path.resolve("./packages"),
  ];

  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  let isBuilding = false;

  const handleRebuild = () => {
    if (rebuildTimer) {
      clearTimeout(rebuildTimer);
    }
    rebuildTimer = setTimeout(async () => {
      if (isBuilding) return;
      isBuilding = true;
      try {
        console.log("\n[Dev] ⚡ 检测到前端源码变动，正在增量重新打包...");
        await buildFrontend({ isDev: true });
        console.log("[Dev] 📢 编译完成，正在通知浏览器热刷新...");
        broadcastDevReload();
      } catch (error) {
        console.error("[Dev] ❌ 增量打包失败:", error);
      } finally {
        isBuilding = false;
      }
    }, 100);
  };

  const watchers: fs.FSWatcher[] = [];
  for (const dir of watchDirs) {
    if (fs.existsSync(dir)) {
      try {
        const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
          if (!filename) return;
          const name = String(filename);
          if (
            name.includes("build") ||
            name.includes("dist") ||
            name.includes("node_modules") ||
            name.includes(".git") ||
            name.endsWith(".tmp")
          ) {
            return;
          }
          handleRebuild();
        });
        watchers.push(watcher);
      } catch (err) {
        console.warn(`[Dev] 无法监听目录 ${dir}:`, err);
      }
    }
  }

  console.info("[Dev] 👁️ 前端源码热重载观察器已就绪 (excalidraw-app, packages)");

  return () => {
    for (const w of watchers) {
      try {
        w.close();
      } catch {}
    }
  };
};
