# Guidelines for AI Agents

本仓库是一个基于 **Bun 1.4+** 与 **原生 SQLite** 驱动的纯净、自托管虚拟手绘风格白板。本项目已实现**纯粹的 Bun 原生全栈开发与全生命周期统一**，在安装、编译、测试、开发调试、运行与部署全流程中**彻底脱离 Node.js**。支持多画板管理、云端自动持久化、图片附件存储、密码保护、`bun run dev` 前后端一体化热重载与极速 Docker 容器化部署。

## 1. 提交规范 (Mandatory Git Commit Rule)

- **每次完成代码修改或功能调整后，必须立即执行 Git 提交（git commit）**，确保改动有清晰、原子化的版本记录。
- 提交信息应简明扼要，使用 Conventional Commits 格式（如 `feat: ...`, `fix: ...`, `refactor: ...`, `chore: ...`）。

## 2. 环境与包管理规范 (Bun Ecosystem & Pure Full-Stack)

- 本项目已完全迁移至 **Bun (1.4+)**，在运行时、构建器与自动化测试中彻底剔除 Node.js / Vite / Vitest / npm / yarn。
- 安装依赖统一使用 `bun install`（维护 `bun.lock`）。
- 脚本执行与构建统一使用 `bun run <script>` 或直接通过 `bun` 执行 TypeScript 文件。
- 代码中的 `node:*` 协议导入（如 `node:path`、`node:crypto`）仅作为服务端标准模块命名空间，由 Bun 原生 Zig/C++ 实现高性能驱动，绝不允许引入 Node.js 运行时依赖。

## 3. 前端构建与现代浏览器性能规范 (Bun HTML Bundler)

- **前端打包引擎**：前端构建统一由原生 **Bun HTML Bundler** 驱动（[`scripts/build-frontend.ts`](file:///D:/MyBuild/excalidrawsqlite/scripts/build-frontend.ts)），配合 Dart Sass 插件直接以 `excalidraw-app/index.html` 为入口进行极速打包，严禁重新引入 Vite、Rollup 或 Webpack。
- **构建配置与环境注入**：
  - 构建产物配置 `publicPath: "/"`，确保深层路由与静态资源路径解析一致；
  - 在 `Bun.build` 的 `define` 中完备注入 `import.meta.env`、`PKG_NAME`、`PKG_VERSION` 及 `process.env.NODE_ENV`，避免浏览器端运行时因缺少环境对象而抛错；
  - 同源 Script 与 Link 标签清理冗余的 `crossorigin` 属性，防止无意义的 CORS 检查；
  - 生产构建使用 Bun 1.4 支持的现代浏览器目标（当前为 `target: "browser"`；Bun 1.4 不接受 `esnext` 作为构建目标），仅支持最新 Chrome、Edge、Firefox、Safari 和 iOS Safari。严禁引入过时浏览器兼容降级包。
- **按需动态加载**：
  - AI、Mermaid、CJK 字体、CodeMirror、pako 回退和字体子集化能力必须保持按需加载。新增大型依赖前先确认不会被静态 import 拉入主入口，优先使用动态 `import()`；
  - 「霞鹜文楷」资源位于 `packages/excalidraw/fonts/LXGWWenKai`，必须通过 `Fonts.ts` 的动态 import 按需加载；Bun HTML Bundler 原生解析并打包导入的字体资产，构建阶段仅保留字体开源许可（`OFL.txt`），杜绝向 `build/` 目录冗余复制全量字体源文件；
  - `encode`/`decode` 及图片、SVG 元数据编码接口是异步的，调用方必须 `await`。

## 4. 全栈开发与热重载规范 (Unified Dev Server)

- **一键全栈开发指令**：统一使用 `bun run dev`（映射为 `bun server/server.ts --dev`），无需打开多个终端，无需配置复杂的跨端口反向代理。
- **开发态架构设计**：
  - 启动时由 [`server/dev-server.ts`](file:///D:/MyBuild/excalidrawsqlite/server/dev-server.ts) 自动检查产物并自举初始编译；
  - 内置基于 Bun 原生文件系统的防抖观察器，实时监控 `excalidraw-app` 与 `packages` 源码变动，变动时触发毫秒级增量重新构建；
  - 构建完成后通过 [`server/dev-reload.ts`](file:///D:/MyBuild/excalidrawsqlite/server/dev-reload.ts) 原生 SSE 通道（`GET /__dev_reload`）向客户端广播重载事件；
  - 客户端通过独立外链脚本 [`public/dev-live-reload.js`](file:///D:/MyBuild/excalidrawsqlite/public/dev-live-reload.js) 接收信号并无感热刷新页面，严格满足 CSP 安全要求。

## 5. CSP 与运行时安全规范

- `server/http.ts` 生成的 `script-src` 禁止 `unsafe-inline` 和 `unsafe-eval`，仅允许必要的 `'wasm-unsafe-eval'`。禁止引入 `eval`、`new Function` 或在 `index.html` 中添加内联脚本。
- 入口启动逻辑放在 `public/theme-init.js` 和 `public/dev-live-reload.js` 等外部独立资源中，入口样式通过 `excalidraw-app/index.tsx` 导入 `index.scss`，严禁移回 HTML 内联代码。
- CSS 侧的 `style-src-elem/style-src-attr 'unsafe-inline'` 是当前 React 内联样式及 Mermaid/CodeMirror 运行时注入的明确兼容范围；不得把这种许可扩展到 `script-src`。
- 调整 CSP、Blob iframe、Worker 或外部资源域名后，运行 `bun run test:server` 并用现代浏览器验证。

## 6. 数据持久化与后端规范 (Bun + SQLite)

- 后端启动入口是 `server/server.ts`，职责模块位于 `server/` 目录，基于 Bun 原生 `bun:sqlite`，数据文件默认位于 `data/excalidraw.db`。
- `server/server.ts` 只负责服务启动、定时维护、优雅关闭和兼容导出；新增业务逻辑应放入对应职责模块。
- 后端模块按以下方向依赖：共享类型/错误/校验/HTTP 基础能力 → 鉴权、数据库、附件、画板和备份模块 → `routes.ts` → `server.ts`。业务模块不得反向导入 `server.ts`，不得引入不必要的循环依赖。
- 控制台输出一律使用 `console.log` / `console.info`（调用 Windows 宽字符 API），禁止使用原始字节流写入的 `process.stdout.write`，防止在非 UTF-8 代码页终端下出现乱码。
- SQLite WAL、数据库迁移、旧版 `data_url` 附件迁移、附件原子写入与回滚逻辑属于持久化契约，修改后必须覆盖兼容性和失败场景测试。
- Docker 生产运行阶段必须复制完整的 `server/` 目录；容器环境使用 `oven/bun:1.4.1-alpine`，确保运行镜像内零 Node.js 残留。

## 7. 容器运行身份与 rootless 兼容性

- `Dockerfile` 运行阶段和默认 `docker-compose.yml` 不得擅自改为固定的 `bun` 用户或 `1000:1000` UID/GID；当前默认 root 身份用于兼容 rootless Podman/Docker 的用户命名空间和绑定挂载权限。
- 若确需非 root 运行，必须由部署方显式配置 `user: "UID:GID"`（或等价参数），同步更新部署文档，并验证 SQLite/WAL 及附件目录的读写权限；不得把固定 UID 作为镜像默认值。

## 8. 分级验证与提交规范 (Tiered Verification & Commit)

根据实际修改的文件类型与影响范围，严格执行分级验证，避免无意义的全量测试开销：

1. **纯文档与注释改动 (免测)**：
   - 适用范围：`*.md`、`*.mdx`、`dev-docs/`、`docs/`、`LICENSE`、代码注释或纯文档配置。
   - 规则：**直接执行 Git 提交，严禁运行全量测试或构建命令**。
2. **后端与持久化改动 (极速验证)**：
   - 适用范围：`server/`、数据库迁移逻辑、API 路由。
   - 规则：运行快速后端测试 `bun run test:server`（耗时 < 1.5s）。
3. **前端局部功能与模块改动 (局部验证)**：
   - 适用范围：`packages/` 或 `excalidraw-app/` 内的局部组件、算法或样式修改。
   - 规则：优先运行与该改动直接相关的测试文件（如 `bun test packages/excalidraw/tests`）或 `bun run test:typecheck`，不要盲目跑全量测试。
4. **全量与发布级验证 (必要时执行)**：
   - 适用范围：修改了 `package.json`、核心依赖项、`scripts/build-frontend.ts` 打包引擎配置、核心跨模块接口或用户显式要求。
   - 规则：运行 `bun run test:server && bun run test:typecheck && bun run build`。

- **原子提交要求**：每次代码或文档修改完成后立即执行一次原子 Git 提交，提交信息使用 Conventional Commits 格式。文档修改也应单独或与同一主题的代码修改一起提交，保持提交记录可追溯。
