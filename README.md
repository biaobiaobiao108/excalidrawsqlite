# Excalidraw (Bun + SQLite 持久化纯净私有化版本)

一个基于 **Bun 1.4+** 与 **原生 SQLite** 驱动的纯净、自托管虚拟手绘风格白板。支持多画板管理、云端自动持久化、图片附件存储、密码保护与极速 Docker 容器化部署。

---

## ✨ 核心特性

- 🚀 **全栈 Bun 驱动**：从 Monorepo 依赖管理、构建编译到生产运行，100% 依赖 Bun，零 Node.js / Yarn 依赖。
- 💾 **SQLite 云端持久化**：
  - 基于 Bun 原生 `bun:sqlite`（开启 WAL 高性能并发模式）；
  - 支持多画板管理（列表浏览、新建、重命名、快速切换、删除）；
  - 画布修改防抖 1000ms 自动同步至 SQLite；
  - 图片/文件附件二进制自动存入 SQLite 数据库；
  - 支持 URL 参数 `?id=xxx` 自动识别与加载指定画板。
- 🧼 **100% 纯净体验**：
  - 彻底移除 Excalidraw+ 商业广告、试用导流、虚假功能卡片与外部社交链接；
  - 界面简洁高效，专为私有化与局域网部署打造。
- 🔐 **轻量鉴权保护**：
  - 支持通过环境变量 `AUTH_PASSWORD` 开启访问密码保护，保障私有化数据安全。
- 🐳 **极致轻量容器化**：
  - 基于 `oven/bun:1.4-alpine` 多阶段构建，**生产镜像仅 ~130MB**；
  - 单一卷挂载 `./data:/app/data` 即可实现全量数据持久化与备份迁移。

---

## 🚀 快速启动

### 方式一：Docker Compose 容器化部署（推荐）

1. **克隆本仓库**
   ```bash
   git clone <your-repo-url>
   cd excalidraw
   ```

2. **配置与启动**
   如需设置访问密码，可编辑 `docker-compose.yml` 中的 `AUTH_PASSWORD`：
   ```yaml
   services:
     excalidraw:
       build: .
       container_name: excalidraw
       restart: unless-stopped
       ports:
         - "8080:8080"
       environment:
         - PORT=8080
         - DB_PATH=/app/data/excalidraw.db
         - AUTH_PASSWORD=your_password  # 留空则不开启密码验证
       volumes:
         - ./data:/app/data
   ```

3. **运行容器**
   ```bash
   docker compose up -d --build
   ```
   打开浏览器访问：`http://localhost:8080`。

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
│       └── cloudStorage.ts # 前端与 SQLite 交互的 API 客户端
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
| :--- | :--- | :--- |
| `GET` | `/api/auth/status` | 检查是否开启了密码验证及当前登录态 |
| `POST` | `/api/auth/verify` | 提交密码进行验证 |
| `GET` | `/api/scenes` | 获取所有云端画板列表（按更新时间降序） |
| `POST` | `/api/scenes` | 创建新画板 |
| `GET` | `/api/scenes/:id` | 获取指定画板的图元数据与状态 |
| `PUT` | `/api/scenes/:id` | 保存/更新指定画板（防抖自动同步） |
| `DELETE` | `/api/scenes/:id` | 删除指定画板 |
| `POST` | `/api/files` | 上传图片等二进制附件 |
| `GET` | `/api/files/:id` | 获取图片附件内容 |

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。原项目由 Excalidraw 团队开发。

