# Guidelines for AI Agents

本仓库是一个基于 **Bun 1.4+** 与 **原生 SQLite** 驱动的纯净、自托管虚拟手绘风格白板。本项目已实现**纯粹的 Bun 原生全栈开发与全生命周期统一**，在安装、编译、测试、开发调试、运行与部署全流程中**彻底脱离 Node.js**。支持多画板管理、云端自动持久化、图片附件存储、密码保护、`bun run dev` 前后端一体化热重载与极速 Docker 容器化部署。

## 1. 提交规范 (Mandatory Git Commit Rule)

- **每次实现一个新功能或者修复一个 bug 并验证通过后，必须执行一次 `git commit`**。
- 提交信息必须规范清晰，遵循语义化格式（如 `feat:`, `fix:`, `refactor:`, `test:`, `docs:` 等），并且用中文。

## 2. 环境与包管理规范 (Bun Ecosystem & Pure Full-Stack)

- 本项目统一使用 **Bun (1.4+)**；运行时、构建器和测试入口不得重新引入 Vite、Vitest、npm 或 yarn。
- 安装依赖统一使用 `bun install`（维护 `bun.lock`）。
- 脚本执行与构建统一使用 `bun run <script>` 或直接通过 `bun` 执行 TypeScript 文件；项目根目录与 `scripts/` 下全部脚本均须使用纯 TypeScript ESM 规范（使用 `Bun.file` / `Bun.write` / `Bun.spawnSync`），严禁使用 CommonJS `require`。
- 代码中的 `node:*` 协议导入（如 `node:path`、`node:crypto`）仅作为服务端标准模块命名空间，由 Bun 原生 Zig/C++ 实现高性能驱动，绝不允许引入 Node.js 运行时依赖。

## 3. 前端构建与现代浏览器性能规范 (Bun HTML Bundler)

- **前端打包引擎**：前端构建统一由原生 **Bun HTML Bundler** 驱动（[`scripts/build-frontend.ts`](scripts/build-frontend.ts)），配合 Dart Sass 插件直接以 `excalidraw-app/index.html` 为入口进行极速打包，严禁重新引入 Vite、Rollup 或 Webpack。
- **构建配置与环境注入**：
  - 构建产物配置 `publicPath: "/"`，确保深层路由与静态资源路径解析一致；
  - 在 `Bun.build` 的 `define` 中完备注入 `import.meta.env`、`PKG_NAME`、`PKG_VERSION` 及 `process.env.NODE_ENV`，避免浏览器端运行时因缺少环境对象而抛错；
  - 同源 Script 与 Link 标签清理冗余的 `crossorigin` 属性，防止无意义的 CORS 检查；
  - 生产构建使用 Bun 1.4 支持的现代浏览器目标（当前为 `target: "browser"`；Bun 1.4 不接受 `esnext` 作为构建目标），仅支持最新 Chrome、Edge、Firefox、Safari 和 iOS Safari。严禁引入过时浏览器兼容降级包。
- **按需动态加载**：
  - AI、Mermaid、CJK 字体、CodeMirror、pako 回退和字体子集化能力必须保持按需加载。新增大型依赖前先确认不会被静态 import 拉入主入口，优先使用动态 `import()`；
  - Excalifont 是唯一保留的本地默认字体，必须从 `packages/excalidraw/fonts/Excalifont` 加载；霞鹜文楷与思源黑体是外部字体，必须分别通过版本化 jsDelivr `<link rel="stylesheet">` 加载。样式表内部注册分片 `@font-face` 时，编辑器必须使用样式表声明的 CSS 字体名，不得把 CSS URL 写入 `@font-face src`，并同步在 CSP 中放行 `cdn.jsdelivr.net` 的样式与字体来源；
  - `encode`/`decode` 及图片、SVG 元数据编码接口是异步的，调用方必须 `await`。

### Safari 优先适配

- 最新 macOS Safari 是本项目的首要浏览器目标；新增或调整的前端体验先按 Safari 验证，再保证其他受支持浏览器正常。
- 优先使用能力检测，不假设 `navigator.deviceMemory`、剪贴板或文件系统 API 存在；受 HTTPS/localhost 安全上下文限制的能力必须提供回退或清楚提示。
- UI 与画布改动需关注 Safari 的触控板手势、DPR/Canvas、动态视口、字体加载、剪贴板、文件导入导出和键盘焦点；交互改动使用 Codex 内置浏览器做必要的 Safari 冒烟检查。

## 4. 全栈开发与热重载规范 (Unified Dev Server)

- **一键全栈开发指令**：统一使用 `bun run dev`（映射为 `bun server/server.ts --dev`），无需打开多个终端，无需配置复杂的跨端口反向代理。
- **开发态架构设计**：
  - 启动时由 [`server/dev-server.ts`](server/dev-server.ts) 自动检查产物并自举初始编译；
  - 内置基于 Bun 原生文件系统的防抖观察器，实时监控 `excalidraw-app` 与 `packages` 源码变动，变动时触发毫秒级增量重新构建；
  - 构建完成后通过 [`server/dev-reload.ts`](server/dev-reload.ts) 原生 SSE 通道（`GET /__dev_reload`）向客户端广播重载事件；
  - 客户端通过独立外链脚本 [`public/dev-live-reload.js`](file:///D:/MyBuild/excalidrawsqlite/public/dev-live-reload.js) 接收信号并无感热刷新页面，严格满足 CSP 安全要求。

## 5. CSP 与运行时安全规范

- `server/http.ts` 生成的 `script-src` 禁止 `unsafe-inline` 和 `unsafe-eval`，仅允许必要的 `'wasm-unsafe-eval'`。禁止引入 `eval`、`new Function` 或在 `index.html` 中添加内联脚本。
- 入口启动逻辑放在 `public/theme-init.js` 和 `public/dev-live-reload.js` 等外部独立资源中，入口样式通过 `excalidraw-app/index.tsx` 导入 `index.scss`，严禁移回 HTML 内联代码。
- CSS 侧的 `style-src-elem/style-src-attr 'unsafe-inline'` 是当前 React 内联样式及 Mermaid/CodeMirror 运行时注入的明确兼容范围；不得把这种许可扩展到 `script-src`。
- 调整 CSP、Blob iframe、Worker 或外部资源域名后，运行 `bun run test:server` 并用现代浏览器验证。

## 6. 数据持久化与后端规范 (Bun + SQLite)

- 后端启动入口是 `server/server.ts`，职责模块位于 `server/` 目录，基于 Bun 原生 `bun:sqlite`，数据文件默认位于 `data/excalidraw.db`。
- `server/server.ts` 只负责服务启动、定时维护、优雅关闭和公共导出；新增业务逻辑应放入对应职责模块。
- 后端高频查询操作优先通过预编译语句（Prepared Statements，如 `WeakMap<ServerRuntime, ...>` 缓存的 `db.query` 对象）单例复用，降低重复编译 SQL 开销。
- 附件与静态文件分发接口需提供基于 SHA-256 摘要的 `ETag` 与 `If-None-Match` 协商缓存，支持秒级 `304 Not Modified` 响应以节省网络资源。
- 后端模块按以下方向依赖：共享类型/错误/校验/HTTP 基础能力 → 鉴权、数据库、附件、画板和备份模块 → `routes.ts` → `server.ts`。业务模块不得反向导入 `server.ts`，不得引入不必要的循环依赖。
- 控制台输出一律使用 `console.log` / `console.info`（调用 Windows 宽字符 API），禁止使用原始字节流写入的 `process.stdout.write`，防止在非 UTF-8 代码页终端下出现乱码。
- SQLite 只初始化当前 schema，不维护 schema 版本、数据库迁移或旧库兼容分支。附件使用二进制流式写入、原子替换与失败回滚，相关改动必须覆盖当前行为和失败场景。
- Docker 生产运行阶段必须复制完整的 `server/` 目录；容器环境使用 `oven/bun:1.4.2-alpine`，确保运行镜像内零 Node.js 残留。

## 7. 容器运行身份与 rootless 兼容性

- `Dockerfile` 运行阶段和默认 `docker-compose.yml` 不得擅自改为固定的 `bun` 用户或 `1000:1000` UID/GID；当前默认 root 身份用于兼容 rootless Podman/Docker 的用户命名空间和绑定挂载权限。
- 若确需非 root 运行，必须由部署方显式配置 `user: "UID:GID"`（或等价参数），同步更新部署文档，并验证 SQLite/WAL 及附件目录的读写权限；不得把固定 UID 作为镜像默认值。

## 8. 测试与验证

测试按层级运行，普通单元测试不得加载浏览器环境：

- `bun test` / `bun run test:unit`：运行 `tests/unit` 中基于 `bun:test` 的纯逻辑测试；不得依赖 JSDOM、React 全局 setup 或大规模快照。
- `bun run test:server`：运行 `tests/server` 中基于 Bun 原生 SQLite/API 的集成测试；测试必须清理临时数据库、附件和锁文件。
- `bun run test:all`：依次执行单元、服务端、类型、代码规范、构建与体积门禁。

按改动范围选择验证：

1. 文档或注释：可跳过自动化测试，但必须检查链接、示例和格式，然后直接提交。
2. `server/` 或持久化：运行 `bun run test:server`。
3. 局部前端或算法：运行 `bun test` 或 `bun run test:typecheck`；涉及 UI 行为时运行 `bun run build` 并进行必要的手动冒烟检查。
4. 依赖、构建配置、跨模块接口或发布级改动：运行 `bun run test:all`。

每次代码或文档修改后立即执行一次带中文主题的 Conventional Commit。

## 9. 内存、缓存与生命周期规范（当前实现）

- 总原则：以编辑体验和导出质量为先；所有新增历史、缓存、队列、WebSocket 重连计时器、上传/备份临时文件都必须有明确上限、释放/取消路径和失败回滚。不得为了省内存破坏场景、图片、备份 API 或 `BinaryFileData` 公共契约。SQLite 仅支持当前 schema，不记录 schema 版本、不自动迁移旧库；schema 变更按当前开发库验证，禁止静默丢弃业务数据。持久化保存必须前后端协同剥离 `isDeleted` 废弃图元；日常操作充分利用 SQLite Freelist 空闲页池化复用以避免频繁截断引发 IO 抖动与写放大；回收站支持基于 `TRASH_RETENTION_DAYS` 的 TTL 自动物理清理并联动附件 GC。
- History：默认最多保留 200 条、估算上限 64 MiB；按点数组、字符串、数组和字段数量估算，不序列化完整对象。超限从最老记录淘汰，但最近的单个超大操作仍保留；撤销、重做和分支写入必须同步维护预算。`Store.clear()`、编辑器卸载时必须清理待执行动作、History、Store 和临时引用，但不能清掉云端保存队列仍持有的最新快照。
- Canvas：`StaticCanvas`、`InteractiveCanvas`、`NewElementCanvas` 使用统一的自适应 `renderScale`。编辑画布总预算约为普通设备 32M、低内存设备 16M RGBA 像素；无预览按 2 层、有预览按 3 层计算，并随视口/DPR 变化调整。CSS 尺寸和导出分辨率不得降低；分配失败时应降低比例重试，并释放上一次失败分配的引用。
- 图片与前端文件：保持 `BinaryFileData`、`files` 和 IndexedDB 的兼容契约；`imageCache` 必须保持 Map 兼容并使用按解码像素计费的 LRU，默认预算为普通设备 128 MiB、低内存/移动设备 64 MiB。当前可见、选中、裁剪和交互中的图片固定保留；只有不再被场景、History、云端快照、缩略图任务或交互引用的文件才能回收，淘汰后必须能重新解码。云端网络加载可使用 Blob/FileReader 路径，普通设备最多 4 路、低内存/移动设备最多 2 路并发。当前云端场景缓存最多 2 个、文件元数据缓存最多 512 项，上传哈希缓存使用弱引用；新增缓存必须有容量上限或弱引用策略，不能长期保留重复的完整 data URL。若未来引入 Blob/Object URL，只能用于有明确生命周期的临时解码/渲染路径，并必须在卸载、淘汰或错误时 revoke，同时保留从 `files`/IndexedDB 恢复的路径。
- 云端保存队列：同一场景只保留最新待保存快照，成功保存、取消、释放或冲突处理后及时清理已无引用的快照；不得静默丢弃最新未保存数据。保存队列应维持当前的版本/冲突语义，并在前一次保存成功后对仍待保存的快照重新基于最新版本合并，避免无意义的 409。若后续增加字节或场景数量上限，必须采用刷新、背压或显式错误处理，不能直接淘汰最新快照。开发/测试统计至少覆盖文件、元素、快照和队列引用。
- 服务端请求、附件与备份：使用 `MAX_IN_FLIGHT_BODY_BYTES`（默认 64 MiB）限制聚合请求体；已知 `Content-Length` 只用于提前拒绝或安全预分配，不能为了计算哈希把二进制整体读入内存。二进制上传必须流式写临时文件、增量计算 SHA-256/大小，成功后原子替换；超限、校验失败或数据库失败时清理并回滚。附件垃圾回收必须分批执行（当前默认每批 100 个），通过 `.gc` 隔离/删除临时产物并清理过期 `.tmp`、`.bak`、`.gc` 文件。完整备份应从磁盘流式打包；数据库快照接口如需返回 `ArrayBuffer`，必须先进行大小限制并在测试中覆盖失败清理。备份内容遵循当前 schema 与备份契约。
- 原生 WebSocket：实时通道只传递轻量事件和版本信息，不发送完整场景或附件；客户端控制消息限制为 8 KiB，连接回压限制为 256 KiB，空闲连接超时为 120 秒。重连计时器、可见性监听和订阅必须在编辑器/页面卸载时清理；重连后使用当前场景版本进行增量对账，避免重复拉取大对象或无限重试。
- 统计与验证：内存统计仅用于开发/测试，不进入生产日志；至少覆盖 History、`files`、解码图片、缓存条目、Canvas 像素、云端待保存快照和服务端 body 当前/峰值占用。内存相关改动运行 `bun test`、`bun run test:typecheck`、`bun run test:server`；涉及渲染、实时同步或交互时追加 `bun run build` 和必要的浏览器冒烟检查，跨模块或发布级改动运行 `bun run test:all`。
