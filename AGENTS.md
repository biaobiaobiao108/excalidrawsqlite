# Guidelines for AI Agents

## 1. 提交规范 (Mandatory Git Commit Rule)
- **每次完成代码修改或功能调整后，必须立即执行 Git 提交（git commit）**，确保改动有清晰、原子化的版本记录。
- 提交信息应简明扼要，使用 Conventional Commits 格式（如 `feat: ...`, `fix: ...`, `refactor: ...`, `chore: ...`）。

## 2. 环境与包管理规范 (Bun Ecosystem)
- 本项目已完全迁移至 **Bun (1.4+)**，严禁引入 `yarn` 或 `npm` 相关指令与依赖。
- 安装依赖使用 `bun install`（维护 `bun.lock`）。
- 脚本执行与构建统一使用 `bun run <script>`。

## 3. DOM / Browser API 规范
- 对于新的 DOM/Browser API 调用，优先使用 `app.ownerDocument` 和 `app.ownerWindow`，避免直接使用全局 `document` / `window`；若没有 `app` 实例，从挂载节点的 `node.ownerDocument` 及其 `defaultView` 中派生。

## 4. 数据持久化与后端规范 (Bun + SQLite)
- 后端服务位于 `server/server.ts`，基于 Bun 原生 `bun:sqlite`，数据文件默认位于 `data/excalidraw.db`。
- 新增 API 或白板图元数据字段时，保持向后兼容并做好输入校验。

