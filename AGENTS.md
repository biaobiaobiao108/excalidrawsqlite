# Agent Guidelines

本项目使用 Bun 1.4.4+、Bun HTML Bundler 和原生 SQLite。项目结构、配置与部署见 [README.md](README.md)。

## 目录导航

- `excalidraw-app/`：前端应用与界面。
- `server/`：服务端 API、SQLite、鉴权、附件、实时同步与 MCP；入口为 `server/server.ts`。
- `packages/`：Monorepo 内部共享包。
- `scripts/`：构建、发布和维护脚本。
- `tests/unit/`、`tests/server/`：单元测试与服务端测试。
- `public/`：静态资源。
- `data/`：本地运行数据，不作为源码修改。
- `excalidraw-app/build/`、`server-build/`：构建产物；应修改对应源码并重新构建。

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

- 每次提交包含应用代码、服务端代码、脚本、配置或测试改动时，提交前按顺序完成以下步骤：

  1. 运行 `bun run format`，格式化脚本固定范围内的源码和配置。
  2. 检查格式化产生的 diff，确认没有无关改动。首次统一格式基线时，格式变化单独提交。
  3. 运行 `bun run test:all`，依次完成类型检查、单元测试、服务端测试、生产构建和包体积检查。

- 上述检查全部通过后再提交。代码再次改动后，从格式化开始重新执行完整流程；任一检查失败，先修复再继续。
- 依赖变更额外运行 `bun audit`。仅修改文档时可跳过上述代码检查，但需检查链接、示例和格式。
- 每个完成的代码改动集都必须提交，包括重构、维护类改动和小修复。提交标题使用中文，并按 `feat:`、`fix:`、`docs:`、`test:`、`chore:` 或 `ci:` 分类。多 agent 并行修改时，由主 agent 统一核验并提交完整改动。
- 本地不需要构建 Docker 镜像，由 CI 负责；CI 使用 `bun run format --check` 检查与本地相同的固定范围。浏览器测试保持必要且精简。
