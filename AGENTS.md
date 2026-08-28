# Guidelines for AI Agents

本仓库是一个基于 **Bun 1.4+** 与 **原生 SQLite** 驱动的纯净、自托管虚拟手绘风格白板。支持多画板管理、云端自动持久化、图片附件存储、密码保护与极速 Docker 容器化部署。

## 1. 提交规范 (Mandatory Git Commit Rule)

- **每次完成代码修改或功能调整后，必须立即执行 Git 提交（git commit）**，确保改动有清晰、原子化的版本记录。
- 提交信息应简明扼要，使用 Conventional Commits 格式（如 `feat: ...`, `fix: ...`, `refactor: ...`, `chore: ...`）。

## 2. 环境与包管理规范 (Bun Ecosystem)

- 本项目已完全迁移至 **Bun (1.4+)**，严禁引入 `yarn` 或 `npm` 相关指令与依赖。
- 安装依赖使用 `bun install`（维护 `bun.lock`）。
- 脚本执行与构建统一使用 `bun run <script>`。

## 3. 现代浏览器与性能规范

- 生产环境只支持最新 Chrome、Edge、Firefox、Safari 和 iOS Safari；生产构建目标为 `esnext`。不要重新添加旧浏览器 Browserslist、polyfill、转译兼容层或无必要的降级分支。
- AI、Mermaid、CJK 字体、CodeMirror、pako 回退和字体子集化能力应保持按需加载。新增大型依赖前先确认不会被静态 import 拉入主入口；优先使用动态 `import()`，并检查 Rollup chunk 是否符合职责。
- 每次调整依赖、动态 import、Vite `manualChunks`、PWA 缓存或压缩逻辑后，运行 `bun run build` 和 `bun run build:check-size`。不得通过放宽预算掩盖主入口膨胀；当前预算由 `scripts/check-bundle-size.js` 统一维护。
- `encode`/`decode` 及图片、SVG 元数据编码接口是异步的，调用方必须 `await`。变更原生 Compression Streams 或 pako 回退时，必须保留旧版 bstring/zlib 数据的读取能力，并补充 Unicode、PNG、SVG 回归测试。
- 生产 Service Worker 不预缓存 Mermaid、pako、图表、CodeMirror 等延迟 chunk；新增延迟 chunk 时同步检查 `globIgnores`、`runtimeCaching` 和 hash 缓存策略，避免首屏下载或离线缓存遗漏。

## 4. CSP 与运行时安全规范

- `server/server.ts` 的 `script-src` 禁止 `unsafe-inline` 和 `unsafe-eval`，仅允许必要的 `'wasm-unsafe-eval'`。禁止引入 `eval`、`new Function` 或在 `index.html` 中添加内联脚本。
- 入口启动逻辑放在 `public/theme-init.js` 等外部资源中，入口样式通过 `excalidraw-app/index.tsx` 导入 `index.scss`。不要为了方便把它们移回 HTML 内联代码。
- CSS 侧的 `style-src-elem/style-src-attr 'unsafe-inline'` 是当前 React 内联样式及 Mermaid/CodeMirror 运行时注入的明确兼容范围；不得把这种许可扩展到 `script-src`。若要完全移除 CSS inline，需要单独规划样式迁移或第三方编辑器隔离。
- 调整 CSP、Blob iframe、Worker 或外部资源域名后，运行 `bun run test:server`，并用现代浏览器验证首屏、Mermaid、字体子集化、图片导出和离线缓存；不要只检查服务端响应头。

## 5. DOM / Browser API 规范

- 对于新的 DOM/Browser API 调用，优先使用 `app.ownerDocument` 和 `app.ownerWindow`，避免直接使用全局 `document` / `window`；若没有 `app` 实例，从挂载节点的 `node.ownerDocument` 及其 `defaultView` 中派生。

## 6. 数据持久化与后端规范 (Bun + SQLite)

- 后端服务位于 `server/server.ts`，基于 Bun 原生 `bun:sqlite`，数据文件默认位于 `data/excalidraw.db`。
- 新增 API 或白板图元数据字段时，保持向后兼容并做好输入校验。

## 7. 容器运行身份与 rootless 兼容性

- `Dockerfile` 运行阶段和默认 `docker-compose.yml` 不得擅自改为固定的 `bun` 用户或 `1000:1000` UID/GID；当前默认 root 身份用于兼容 rootless Podman/Docker 的用户命名空间和绑定挂载权限。
- 若确需非 root 运行，必须由部署方显式配置 `user: "UID:GID"`（或等价参数），同步更新部署文档，并验证 SQLite/WAL 及附件目录的读写权限；不得把固定 UID 作为镜像默认值。

## 8. 验证与提交规范

- 修改完成后至少运行与变更相关的测试；涉及构建、入口、CSP、编码或跨模块依赖时运行 `bun run test:all` 和 `bun run build`。
- 全量测试中的 React `act()`、状态更新和既有业务错误日志可能出现在 stderr；以测试最终的 pass/fail 汇总为准，不要为了隐藏预期日志而扩大改动范围。
- 每次代码或功能调整完成后立即执行一次原子 Git 提交，提交信息使用 Conventional Commits 格式。文档修改也应单独或与同一主题的代码修改一起提交，保持提交记录可追溯。
