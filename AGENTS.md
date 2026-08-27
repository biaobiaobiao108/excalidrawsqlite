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

## 5. 容器运行身份与 rootless 兼容性

- `Dockerfile` 运行阶段和默认 `docker-compose.yml` 不得擅自改为固定的 `bun` 用户或 `1000:1000` UID/GID；当前默认 root 身份用于兼容 rootless Podman/Docker 的用户命名空间和绑定挂载权限。
- 若确需非 root 运行，必须由部署方显式配置 `user: "UID:GID"`（或等价参数），同步更新部署文档，并验证 SQLite/WAL 及附件目录的读写权限；不得把固定 UID 作为镜像默认值。
