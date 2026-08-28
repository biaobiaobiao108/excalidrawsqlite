# Excalidraw (Bun + SQLite 持久化纯净私有化版本)

一个基于 **Bun 1.4+** 与 **原生 SQLite** 驱动的纯净、自托管虚拟手绘风格白板。支持多画板管理、云端自动持久化、图片附件存储、密码保护与极速 Docker 容器化部署。本发行版面向最新现代浏览器优化，不再兼容旧版浏览器。

---

## ✨ 核心特性

- 🚀 **全栈 Bun 驱动**：从 Monorepo 依赖管理、构建编译到生产运行，100% 依赖 Bun，零 Node.js / Yarn 依赖。
- 💾 **SQLite 云端持久化**：
  - 基于 Bun 原生 `bun:sqlite`（开启 WAL 高性能并发模式）；
  - 支持多画板管理（列表浏览、新建、重命名、快速切换、删除）；
  - 画布修改防抖约 30 秒自动同步至 SQLite，并使用 revision 防止旧快照覆盖新快照；离开编辑器前会先等待当前画板保存完成；
  - 图片/文件附件保存于 `data/files`，SQLite 只保存文件元数据；
  - 支持 URL 参数 `?id=xxx` 自动识别与加载指定画板。
- 🧼 **私有化体验**：
  - 默认不加载分析脚本、Google Fonts 或官方站点跳转；
  - 界面简洁高效，专为私有化与局域网部署打造。上游协作、图表和字体能力仍可能按功能加载第三方依赖，请按部署策略审查网络出口。
- ⚡ **现代浏览器性能**：
  - 生产构建使用 `esnext` 与最新 Chrome、Edge、Firefox、Safari/iOS Safari 目标，避免旧浏览器转译和兼容层开销；
  - AI、Mermaid、CJK 字体、CodeMirror 与压缩回退实现按需加载，不进入首屏关键路径；
  - 使用原生 `CompressionStream`/`DecompressionStream`，不支持时才动态加载 pako 回退；
  - Service Worker 对带 hash 的功能 chunk、字体和语言包分别缓存，应用更新使用新版本资源。
- 🔐 **轻量鉴权保护**：
  - 通过 `AUTH_PASSWORD` 开启密码保护，使用 HttpOnly 会话 Cookie，不在浏览器保存明文密码；
  - 生产环境必须配置密码，免密模式只能通过 `ALLOW_ANONYMOUS=true` 显式开启。
- 🐳 **极致轻量容器化**：
  - 基于固定版本的 `oven/bun:1.4.0-alpine` 多阶段构建；
  - 单一卷挂载 `./data:/app/data` 即可持久化数据库和图片附件。

---

## 🚀 快速启动

### 方式一：Docker / Podman Compose 容器化部署（推荐）

1. **克隆本仓库**

   ```bash
   git clone <your-repo-url>
   cd excalidraw
   ```

2. **配置与启动** 生产环境必须先设置访问密码：

   ```yaml
   # .env（不要提交到 Git）
   AUTH_PASSWORD=your-strong-password
   ```

   镜像默认保留基础镜像的 root 运行身份，以兼容 rootless Podman/Docker 的用户命名空间和绑定挂载。先创建数据目录：

   ```bash
   mkdir -p ./data
   ```

   如需强制使用非 root 身份，请在 Compose 中显式添加 `user: "UID:GID"`，并先确保该 UID/GID 对 `data/` 有读写权限；rootless Podman 可优先使用 `--userns=keep-id`。

   Compose 文件中的 `:Z` 用于 SELinux 主机的目录重新标记。若 Docker Desktop 的 Compose 实现不接受该后缀，可删除 `:Z`，但不要删除数据卷。启动失败时先检查 `data/` 是否可写，并查看 `podman logs excalidraw`。

   如果明确只在可信局域网免密使用，可额外设置 `ALLOW_ANONYMOUS=true`。

3. **运行容器**

   ```bash
   docker compose up -d --build
   ```

   打开浏览器访问：`http://localhost:8080`。

   使用 Podman 时命令相同：

   ```bash
   podman compose up -d --build
   curl http://localhost:8080/api/health
   ```

   服务默认监听 `0.0.0.0:8080`，因此局域网内其他设备可以访问同一个容器。健康检查只做 O(1) 的 SQLite 查询和目录可写性检查；附件一致性扫描由维护任务执行，不通过公开健康接口返回。返回非 200 时优先排查目录权限和卷挂载。直接 HTTP 适合可信局域网，公网部署必须在反向代理后使用 HTTPS。只有明确配置 `TRUST_PROXY=true` 时，服务才会信任 `X-Forwarded-Proto` 并发放 Secure 会话 Cookie；请确保代理覆盖所有外部入口并重写/清理客户端传入的 `X-Forwarded-*` 头。

   服务端会话保存于 SQLite，容器重启后仍可在 TTL 内继续使用；认证 token 以服务端会话记录管理，不会写入浏览器存储。`AUTH_SESSION_TTL_MS` 同时控制服务端会话和浏览器 Cookie 的有效期。请将 `data/` 视为敏感凭据存储并限制备份访问权限。

   设备接力使用时，请先在设备 A 停止编辑，等待页面显示“已保存到云端”后，再在设备 B 打开根路径或带 `?id=画板ID` 的链接。通过应用内返回主页会等待保存；浏览器强制关闭、崩溃或断网时无法保证异步请求完成，离开前确认状态是最可靠的交接方式。

   > 容器默认以 root 运行是为了兼容不同的 rootless/rootful 挂载映射。若组织安全基线禁止 root，请显式设置 `user: "UID:GID"` 并完成数据目录属主配置。

---

### 方式二：本地直接运行 (使用 Bun)

#### 前置要求

- 安装 [Bun](https://bun.sh/) (v1.4.0+)

#### 操作步骤

1. **安装依赖**

   ```bash
   bun install
   ```

2. **编译核心 Packages**

   ```bash
   bun run build:packages
   ```

   构建不依赖本机未提交的 `.env` 文件；需要启用 Firebase、Sentry 等可选能力时，再按部署环境注入对应的 `VITE_APP_*` 变量。

3. **启动模式**

   - **全栈模式 (推荐，含 SQLite 后端与前端托管)**：

     ```bash
     # 1. 编译前端静态产物
     bun run build

     # 2. 启动服务 (默认端口 8080)
     bun run start:server
     ```

     访问：`http://localhost:8080`

     若需要生成部署域名对应的 sitemap，可在构建前设置 `VITE_APP_SITE_URL=https://whiteboard.example.com`；未设置时不会写入官方域名或生成 sitemap。

   - **前端开发热重载模式**：
     ```bash
     bun run start
     ```

---

## ⚡ 浏览器支持与构建基线

生产构建只面向最新版本的 Chrome、Edge、Firefox、Safari 和 iOS Safari。项目不再提供 IE、旧版 Chromium、旧版 Firefox 或旧版 Safari 的兼容保证，也不应重新引入面向这些浏览器的 polyfill、转译目标或兼容分支。

大型能力会延迟到真正使用时加载：首次打开 Mermaid、AI、代码编辑器或输入 CJK 文本时会产生一次按需请求，后续由浏览器缓存复用。当前构建预算如下，原始体积和 gzip 体积均检查：

| 产物                    |  Raw 上限 | Gzip 上限 |
| :---------------------- | --------: | --------: |
| 主入口 `index-*.js`     | 1,700 KiB |   550 KiB |
| `mermaid-to-excalidraw` |   700 KiB |   200 KiB |
| `codemirror.chunk`      |   600 KiB |   110 KiB |
| `xiaolai-fonts`         |   140 KiB |    55 KiB |
| `lxgw-wenkai-fonts`     |   160 KiB |    60 KiB |
| `pako.esm`              |    70 KiB |    25 KiB |
| `subset-shared.chunk`   | 2,000 KiB |   800 KiB |

查看或校验产物大小：

```bash
bun run build
bun run build:check-size
```

字体选择器新增「霞鹜文楷」。该字体按 Unicode 区间拆分并延迟加载，覆盖中文、日文假名和韩文音节；极少数未收录字符仍会使用系统回退字体。字体按 SIL Open Font License 1.1 发布，授权全文随资源保存在 `packages/excalidraw/fonts/LXGWWenKai/OFL.txt`。

---

## 🔐 安全头与 CSP

服务端默认返回安全响应头和 Content Security Policy。脚本执行策略不允许 `unsafe-inline` 或 `unsafe-eval`，仅保留 `wasm-unsafe-eval` 以支持 WOFF2 字体子集化所需的 WebAssembly；不要在入口 HTML 中重新加入内联脚本。

CSS 目前单独保留 `style-src-elem/style-src-attr 'unsafe-inline'`：React 现有内联样式，以及 Mermaid、CodeMirror 的运行时样式注入仍依赖它。这不是脚本执行许可；若部署基线要求 CSS 也完全禁止 inline，需要另行完成全量样式迁移或隔离第三方编辑器，不能只删除响应头中的两条指令。

公网部署必须在 HTTPS 反向代理后运行，并在代理层保留服务端安全头。只有显式设置 `TRUST_PROXY=true` 且代理清理并重写 `X-Forwarded-*` 头时，服务才会信任转发协议并发放 Secure 会话 Cookie。

---

## 📂 项目结构

```text
├── server/
│   └── server.ts           # Bun.serve + bun:sqlite 后端与静态文件托管服务
├── excalidraw-app/         # Excalidraw 前端主应用 (Vite + React)
│   ├── components/
│   │   ├── CloudScenesDialog.tsx # 多画板管理弹窗
│   │   ├── AuthDialog.tsx        # 密码验证弹窗
│   │   └── ...
│   └── data/
│       ├── cloudStorage.ts  # 前端云端 API 客户端
│       └── cloudSync.ts     # 串行自动保存队列
├── packages/               # Excalidraw 核心内部包 (Monorepo)
│   ├── common/
│   ├── element/
│   ├── excalidraw/
│   ├── fractional-indexing/
│   ├── laser-pointer/
│   ├── math/
│   └── utils/
├── Dockerfile              # Bun 1.4+ 多阶段构建配置
├── docker-compose.yml      # 容器化一键编排配置
└── bun.lock                # Bun 依赖锁定文件
```

---

## 📡 后端 API 接口概览

| Method | Endpoint | 描述 |
| :-- | :-- | :-- |
| `GET` | `/api/auth/status` | 检查是否开启了密码验证及当前登录态 |
| `POST` | `/api/auth/verify` | 提交密码进行验证 |
| `GET` | `/api/scenes` | 获取所有云端画板列表（按更新时间降序） |
| `POST` | `/api/scenes` | 创建新画板 |
| `GET` | `/api/scenes/:id` | 获取指定画板的图元数据与状态 |
| `PATCH` | `/api/scenes/:id` | 只修改画板名称 |
| `PUT` | `/api/scenes/:id` | 保存指定画板，携带 `baseRevision` 做并发校验 |
| `PUT` | `/api/scenes/:id/thumbnail` | 保存画板预览图，可携带 `X-Thumbnail-Version` 丢弃过期上传 |
| `DELETE` | `/api/scenes/:id` | 删除指定画板 |
| `PUT` | `/api/files/:id` | 上传单个二进制图片到本地文件系统 |
| `POST` | `/api/files` | 兼容旧客户端的 JSON data URL 上传入口 |
| `GET` | `/api/files/:id` | 按 `Accept` 返回二进制内容或兼容 JSON |
| `GET` | `/api/backup/full` | 导出包含 SQLite 和图片附件的完整 `.tar` 备份 |
| `GET` | `/api/backup/snapshot` | 兼容接口：仅导出 SQLite 快照 |
| `GET` | `/api/health` | 容器健康检查（数据库与目录可用性） |

### 数据与备份

- 数据目录包含 `excalidraw.db`、SQLite WAL 文件以及 `files/` 图片目录。数据库只保存图片元数据，图片实际位于 `data/files/`。
- 页面中的“导出完整备份”会生成包含 SQLite 一致性快照、`files/` 图片附件和 `manifest.json` 的归档；数据库单独快照接口仅为兼容旧脚本保留。
- 文件级恢复前请先停止容器，再整体复制 `data/` 目录；不要在服务运行时直接复制 SQLite 主文件。
- 使用完整归档恢复时，请先停止容器，将归档中的 `excalidraw.db` 和 `files/` 一起替换宿主机整个 `data/` 目录（不要只替换数据库），再启动容器。
- 恢复时将完整 `data/` 目录挂载回 `/app/data` 后再启动容器。
- 如果显式使用了 `user: "UID:GID"`，恢复数据后请确认目录属主与该 UID/GID 一致；如果宿主机启用了 SELinux，请确保数据卷仍使用 `:Z` 标记。

### 质量检查

```bash
bun run test:all
bun run build
bun run build:app:docker
bun run build:check-size
```

`bun run build` 会生成 `excalidraw-app/build`、更新版本信息并执行 bundle 预算检查；生产服务启动前必须先完成该构建。修改入口脚本、CSP、动态 import、Service Worker 缓存规则或压缩编码逻辑后，至少运行一次全量测试和生产构建。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。原项目由 Excalidraw 团队开发。
