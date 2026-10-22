# Agent Guidelines

本项目使用 Bun 与原生 SQLite。开发、测试和提交流程见 [CONTRIBUTING.md](CONTRIBUTING.md)；项目结构、配置和部署说明见 [README.md](README.md)。

## 基本原则

- 使用中文沟通，优先简单、易维护的改动；需求明确时直接执行。
- JavaScript/TypeScript 使用 Bun。不要引入只能在 Node.js 运行时工作的依赖、其他包管理器或替代前端构建/测试工具；Bun 支持的 `node:*` 标准模块可以使用。
- 遵循现有模块边界：`server/server.ts` 负责启动和生命周期，业务逻辑放在 `server/` 对应模块；业务模块不要反向依赖入口或形成循环依赖。
- 不无故增加依赖、抽象层或兼容分支；改动前先检查相关实现和测试。

## 必须保留的项目约束

- CSP 的 `script-src` 不得放宽到 `unsafe-inline` 或 `unsafe-eval`；入口脚本保持外置。修改 CSP、Worker、Blob iframe 或外部资源来源时，按贡献指南验证。
- SQLite 只初始化当前 schema，不提供迁移。结构调整不得静默丢弃数据；部署升级和备份流程见 README。
- 附件上传保持流式写入、原子替换和失败回滚，不破坏现有 API 与文件数据契约。
- 新增缓存、队列、计时器或临时文件时，提供明确的容量边界及释放、取消或失败清理路径；调整内存行为前检查现有预算和相关测试。
- 前端保持大型可选功能按需加载，并优先保障最新 Safari。Docker 默认运行身份不得改为固定 UID/GID，以保留 rootless 挂载兼容性。

## 验证与提交

- 按 [CONTRIBUTING.md](CONTRIBUTING.md) 选择与改动范围匹配的验证；优先跑相关检查，跨模块或发布级改动再跑全量测试。浏览器测试按需执行。
- 文档改动检查链接、示例和格式即可。
- 每个独立改动验证通过后提交一次，使用中文主题的 Conventional Commit 信息。
