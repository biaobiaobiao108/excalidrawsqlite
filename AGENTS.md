# Agent Guidelines

本项目使用 Bun 1.4.3+、Bun HTML Bundler 和原生 SQLite。项目结构、配置与部署见 [README.md](README.md)。

## 日常开发

- 使用中文沟通，优先简单、易维护的改动；需求明确时直接执行。
- 安装依赖使用 `bun install`；开发环境使用 `bun run dev`，生产构建使用 `bun run build`。
- JavaScript/TypeScript 使用 Bun。不要引入 Node.js 专属运行时依赖、其他包管理器或替代前端构建/测试工具；Bun 支持的 `node:*` 标准模块可以使用。
- 遵循现有模块边界：`server/server.ts` 负责启动和生命周期，业务逻辑放入 `server/` 对应模块；业务模块不要反向依赖入口或形成循环依赖。
- 不无故增加依赖、抽象层或兼容分支；改动前先检查相关实现和测试。

## 项目约束

- 最新版 macOS Safari 是本项目的首要适配浏览器。涉及界面或画布时，关注触控板、DPR、动态视口和键盘焦点。
- 保持可选大型功能按需加载。`script-src` 不得放宽到 `unsafe-inline` 或 `unsafe-eval`，入口脚本保持外置；修改 CSP、Worker、Blob iframe 或外部资源来源时，运行服务端测试，并在行为需要时做浏览器冒烟。
- SQLite 只初始化当前 schema，不提供迁移。结构调整不得静默丢弃数据；部署升级与备份要求见 README。
- 附件上传保持流式写入、原子替换和失败回滚，不破坏现有 API 与文件数据契约。
- 新增缓存、队列、计时器或临时文件时，明确容量边界及释放、取消和失败清理路径；调整内存行为前检查现有预算和相关测试。
- Docker 默认运行身份不得改为固定 UID/GID，以保留 rootless 挂载兼容性。

## 验证与提交

- 文档改动：检查链接、示例和格式。
- 服务端或持久化改动：运行 `bun run test:server`。
- 局部前端改动：运行相关单测或 `bun run test:unit`；涉及界面行为时补 `bun run build`。需要类型检查时运行 `bun run test:typecheck`。
- 依赖、构建配置、跨模块或发布级改动：运行 `bun run test:all`。按改动范围选择验证，浏览器测试保持必要且精简。
- 每个独立改动验证通过后提交一次，使用中文主题的 Conventional Commit 信息，如 `fix: 修复画板保存`、`docs: 更新开发说明`。
