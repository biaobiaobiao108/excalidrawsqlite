# Excalidraw (Bun + SQLite 持久化纯净私有化版本)

一个基于 **Bun 1.4+** 与 **原生 SQLite** 驱动的纯净、自托管虚拟手绘风格白板。支持多画板管理、云端自动持久化、图片附件存储、密码保护与极速 Docker 容器化部署。

---

## ✨ 核心特性

- 🚀 **全栈 Bun 驱动**：从 Monorepo 依赖管理、构建编译到生产运行，100% 依赖 Bun，零 Node.js / Yarn 依赖。
- 💾 **SQLite 云端持久化**：
  - 基于 Bun 原生 `bun:sqlite`（开启 WAL 高性能并发模式）；
  - 支持多画板管理（列表浏览、新建、重命名、快速切换、删除）；
  - 画布修改防抖 1000ms 自动同步至 SQLite，并使用 revision 防止旧快照覆盖新快照；
  - 图片/文件附件保存于 `data/files`，SQLite 只保存文件元数据；
  - 支持 URL 参数 `?id=xxx` 自动识别与加载指定画板。
- 🧼 **100% 纯净体验**：
  - 彻底移除 Excalidraw+ 商业广告、试用导流、虚假功能卡片与外部社交链接；
  - 界面简洁高效，专为私有化与局域网部署打造。
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

   Linux 使用宿主机目录挂载时，请先确保容器用户（UID 10001）可以写入数据目录。rootful Podman 或 Docker 可执行：

   ```bash
   mkdir -p ./data
   sudo chown -R 10001:10001 ./data
   ```

   rootless Podman 请在用户命名空间内设置权限：

   ```bash
   mkdir -p ./data
   podman unshare chown -R 10001:10001 ./data
   ```

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

   健康检查会验证 SQLite 数据库目录和 `data/files` 文件目录可读写；返回非 200 时优先排查目录权限和卷挂载。直接 HTTP 适合可信局域网，公网部署必须在反向代理后使用 HTTPS。只有明确配置 `TRUST_PROXY=true` 时，服务才会信任 `X-Forwarded-Proto` 并发放 Secure 会话 Cookie。

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

3. **启动模式**

   - **全栈模式 (推荐，含 SQLite 后端与前端托管)**：

     ```bash
     # 1. 编译前端静态产物
     bun run build

     # 2. 启动服务 (默认端口 8080)
     bun run start:server
     ```

     访问：`http://localhost:8080`

   - **前端开发热重载模式**：
     ```bash
     bun run start
     ```

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

| Method   | Endpoint           | 描述                                         |
| :------- | :----------------- | :------------------------------------------- |
| `GET`    | `/api/auth/status` | 检查是否开启了密码验证及当前登录态           |
| `POST`   | `/api/auth/verify` | 提交密码进行验证                             |
| `GET`    | `/api/scenes`      | 获取所有云端画板列表（按更新时间降序）       |
| `POST`   | `/api/scenes`      | 创建新画板                                   |
| `GET`    | `/api/scenes/:id`  | 获取指定画板的图元数据与状态                 |
| `PATCH`  | `/api/scenes/:id`  | 只修改画板名称                               |
| `PUT`    | `/api/scenes/:id`  | 保存指定画板，携带 `baseRevision` 做并发校验 |
| `DELETE` | `/api/scenes/:id`  | 删除指定画板                                 |
| `PUT`    | `/api/files/:id`   | 上传单个二进制图片到本地文件系统             |
| `POST`   | `/api/files`       | 兼容旧客户端的 JSON data URL 上传入口        |
| `GET`    | `/api/files/:id`   | 按 `Accept` 返回二进制内容或兼容 JSON        |
| `GET`    | `/api/health`      | 容器健康检查                                 |

### 数据与备份

- 数据目录包含 `excalidraw.db`、SQLite WAL 文件以及 `files/` 图片目录。数据库只保存图片元数据，图片实际位于 `data/files/`。
- 备份前请先停止容器，再整体复制 `data/` 目录；不要在服务运行时直接复制 SQLite 主文件。
- 恢复时将完整 `data/` 目录挂载回 `/app/data` 后再启动容器。
- 如果使用 rootless Podman，恢复后再次执行 `podman unshare chown -R 10001:10001 ./data`。

### 质量检查

```bash
bun run test:all
bun run build:app:docker
```

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。原项目由 Excalidraw 团队开发。
