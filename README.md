# Excalidraw (Bun + SQLite 持久化纯净私有化版本)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun Version](https://img.shields.io/badge/Bun-1.4%2B-black?logo=bun)](https://bun.sh)
[![Docker](https://img.shields.io/badge/Docker-Ready-blue?logo=docker)](https://github.com/biaobiaobiao108/excalidrawsqlite/pkgs/container/excalidrawsqlite)

一个基于 **Bun 1.4+** 与 **原生 SQLite** 驱动的纯净、自托管虚拟手绘风格白板。专为注重数据隐私、追求极速体验的个人与团队打造。支持多画板管理、30s 防抖自动云端持久化、画板图元数量统计、图片附件归档、HttpOnly 密码保护与极速 Docker/Podman 容器化部署。

---

## ⚖️ 与原版 Excalidraw 的核心区别与优化

| 对比维度 | 官方 / 社区原版 Excalidraw | 本项目 (Excalidraw Bun + SQLite 纯净版) |
| :--- | :--- | :--- |
| **运行时与架构** | Node.js + Yarn，微服务或多容器配置 | **100% 全栈 Bun (1.4+) 驱动**，单进程一体化极速托管 |
| **数据持久化** | 仅保存在浏览器 localStorage（易丢失）或需付费订阅官方云端 | **原生 SQLite WAL 高性能持久化**，单卷挂载 `./data:/app/data` |
| **多画板管理** | 单画板模式，需手动导出/导入 `.excalidraw` 文件 | **内置画板工作台**：列表浏览、搜索、新建、重命名、文件夹分类、回收站与 URL 直达 |
| **图元统计** | 无图元数量感知 | **内置图元数量统计**：基于 SQLite `json_array_length` 毫秒级统计并在卡片展示 |
| **数据隐私与遥测** | 包含 Google Analytics、Sentry 遥测、Google Fonts 与官方外链 | **100% 纯净私有化**：零第三方外链打点，默认只访问本机/局域网服务 |
| **中文字体支持** | 默认依赖外部在线 Google Fonts 或英文字体 | **内置「霞鹜文楷」CJK 手绘中文字体**（Unicode 子集化拆分按需动态加载） |
| **身份认证安全** | 无或 Token 明文保存在浏览器本地存储 | **轻量密码保护 + HttpOnly 服务端 Session Cookie**，绝不暴露明文凭据 |
| **浏览器与构建** | 包含大量旧版浏览器兼容层与 Polyfill | **面向现代浏览器优化 (`esnext`)**，Mermaid/CodeMirror/字体按需动态加载 |
| **资源消耗** | 内存占用 500MB+，冷启动较慢 | **毫秒级冷启动，内存占用低至约 50~80MB** |

---

## ✨ 核心特性详解

### 1. 🚀 全栈 Bun 原生驱动
- 从 Monorepo 依赖管理、TypeScript 编译构建到生产后端服务托管，100% 运行于 Bun 环境。
- 零 Node.js / Yarn 依赖，彻底消除冗余中间层。

### 2. 💾 SQLite WAL 云端自动持久化
- **高性能写入**：基于 Bun 原生 `bun:sqlite`，开启 WAL (Write-Ahead Logging) 模式与高并发事务。
- **自动防抖同步**：画布修改后防抖约 30 秒自动同步至云端，并使用 `revision` 乐观锁机制防止并发快照覆盖。
- **离开保护**：离开画板或返回工作台主页时，前端会主动等待队列保存完毕再跳转。
- **附件独立存储**：图片/媒体文件存储于本地 `data/files/`，SQLite 仅保存文件元数据与 SHA-256 哈希，避免大文件膨胀数据库。

### 3. 🗂️ 完善的多画板与工作台系统
- **画板管理**：工作台支持网格与列表视图切换、实时搜索、画板重命名、一键复制画板。
- **图元数量统计**：画板卡片直观显示 `🎨 10 个图元 • 更新于 今天 17:30`，方便掌握画板内容规模。
- **文件夹与分类**：支持创建文件夹、归类画板与收藏常用画板。
- **回收站与安全保护**：支持画板软删除至回收站、一键还原与彻底清空，防止误删。
- **URL 直达与设备接力**：支持 `?id=xxx` 自动识别与加载指定画板，局域网多设备无缝接力。

### 4. 🧼 极致纯净私有化 (Privacy First)
- 彻底剔除所有外部跟踪分析打点代码、Sentry 上报和 Google Fonts 外部请求。
- 默认运行路径 100% 仅访问本机/局域网服务；只有主动使用 Mermaid 或外部嵌入时才会发出对应请求。

### 5. ⚡ 现代浏览器性能基线
- 生产构建目标面向 `esnext`（支持最新 Chrome、Edge、Firefox、Safari、iOS Safari），去除过时 polyfill。
- **按需动态加载**：Mermaid 图表引擎、CodeMirror 代码编辑器、CJK「霞鹜文楷」手绘字体、pako 压缩回退均延迟至使用时加载，首屏极速秒开。
- **原生压缩流**：优先使用现代浏览器原生 `CompressionStream` 与 `DecompressionStream`。

### 6. 🔐 企业级轻量鉴权与安全响应头
- 通过环境变量 `AUTH_PASSWORD` 开启密码保护。
- 服务端签发安全 `HttpOnly` 会话 Cookie，会话记录持久化于 SQLite，浏览器端不存放明文凭证。
- 服务端注入严格的 **Content Security Policy (CSP)**，禁止 `unsafe-inline` 和 `unsafe-eval` 脚本执行。

### 7. 📦 完整备份与一键归档
- 支持一键导出包含 `excalidraw.db` 数据库、`manifest.json` 与 `files/` 图片附件的完整 `.tar` 归档包，数据迁移安全无忧。

---

## 🚀 快速启动

### 方式一：Docker Compose 部署（推荐）

#### 1. 创建配置文件
在宿主机创建部署目录与 `docker-compose.yml`：

```bash
mkdir -p ./data
cat << 'EOF' > docker-compose.yml
services:
  excalidraw:
    image: ghcr.io/biaobiaobiao108/excalidrawsqlite:latest
    restart: unless-stopped
    ports:
      - '8080:8080'
    environment:
      - AUTH_PASSWORD=your-strong-password  # 访问密码
      - TRUST_PROXY=true                    # 信任反向代理 (HTTPS/反代环境必填)
    volumes:
      - ./data:/app/data
EOF
```

#### 2. 启动服务
```bash
docker compose up -d
```
打开浏览器访问：`http://localhost:8080` 即可开始绘制！

---

### 方式二：Docker / Podman CLI 单行启动

**Docker CLI 运行：**
```bash
mkdir -p ./data
docker run -d \
  --name excalidraw \
  -p 8080:8080 \
  -e AUTH_PASSWORD=your-strong-password \
  -e TRUST_PROXY=true \
  -v ./data:/app/data \
  --restart unless-stopped \
  ghcr.io/biaobiaobiao108/excalidrawsqlite:latest
```

**Podman 用户（支持 rootless 与 SELinux）：**
```bash
mkdir -p ./data
podman run -d \
  --name excalidraw \
  -p 8080:8080 \
  -e AUTH_PASSWORD=your-strong-password \
  -e TRUST_PROXY=true \
  -v ./data:/app/data:Z \
  --userns=keep-id \
  --restart unless-stopped \
  ghcr.io/biaobiaobiao108/excalidrawsqlite:latest
```

---

### 方式三：本地 Bun 源码运行

#### 前置要求
- 安装 [Bun](https://bun.sh/) (v1.4.0+)

#### 操作步骤
```bash
# 1. 克隆仓库
git clone https://github.com/biaobiaobiao108/excalidrawsqlite.git
cd excalidrawsqlite

# 2. 安装依赖 (使用 Bun 维护 bun.lock)
bun install

# 3. 编译核心 Packages
bun run build:packages

# 4. 构建前端产物并启动全栈服务 (默认端口 8080)
bun run build
AUTH_PASSWORD=your-password bun run start:server
```

如需进行前端热重载开发：
```bash
bun run start
```

---

## ⚙️ 环境变量速查表

| 环境变量 | 默认值 | 必填项 | 说明 |
| :--- | :--- | :---: | :--- |
| `AUTH_PASSWORD` | *无* | **是** | 访问密码。设置后启用密码验证并下发 HttpOnly 会话 Cookie。 |
| `ALLOW_ANONYMOUS` | `false` | 否 | 设为 `true` 时显式允许在局域网内免密匿名直接访问。 |
| `TRUST_PROXY` | `false` | **反代必填** | 信任反向代理。在 Nginx/Caddy/Traefik 等反代后必须开启，用于正确识别协议并下发 Secure Cookie。 |
| `PORT` | `8080` | 否 | 服务端监听端口。 |
| `DATA_DIR` | `./data` | 否 | SQLite 数据库文件与图片附件存储目录。 |
| `AUTH_SESSION_TTL_MS` | `604800000` (7天) | 否 | 登录会话在服务端与浏览器 Cookie 中的有效期（毫秒）。 |
| `MAX_FILE_BYTES` | `4194304` (4MB) | 否 | 单个图片/附件上传大小限制（字节）。 |
| `MAX_SCENE_BODY_BYTES`| `33554432` (32MB) | 否 | 单个画板 JSON 数据最大请求体大小。 |

---

## 📂 项目结构概览

```text
├── server/
│   ├── server.ts           # Bun.serve + bun:sqlite 后端全栈核心逻辑与静态托管
│   └── server.test.ts      # 21 项全覆盖自动化持久化与安全测试
├── excalidraw-app/         # Excalidraw 前端主应用 (Vite + React)
│   ├── components/
│   │   ├── WorkspaceHome.tsx     # 工作台多画板管理、文件夹、回收站与卡片组件
│   │   ├── CloudScenesDialog.tsx # 编辑器内多画板快速切换弹窗
│   │   ├── AuthDialog.tsx        # 密码验证与鉴权弹窗
│   │   └── ...
│   ├── data/
│   │   ├── cloudStorage.ts # 云端 REST API 客户端与数据接口
│   │   └── cloudSync.ts    # 30s 串行防抖自动保存队列与多标签同步
│   └── tests/              # 前端自动化测试集
├── packages/               # Excalidraw 核心内部包 (Monorepo)
│   ├── excalidraw/         # 核心渲染与画布引擎 (包含霞鹜文楷本地子集包)
│   ├── element/            # 图元数据结构与计算
│   └── ...
├── docs/                   # GitHub Pages 介绍落地页 (单文件、现代化动效与手绘 SVG)
├── Dockerfile              # oven/bun:1.4.0-alpine 多阶段极小容器构建
├── docker-compose.yml      # 容器化编排配置文件
└── bun.lock                # Bun 统一依赖锁文件
```

---

## 📡 后端 API 接口概览

| 请求方式 | 路由 Endpoint | 描述 |
| :--- | :--- | :--- |
| `GET` | `/api/auth/status` | 查询当前密码保护状态及当前客户端登录态 |
| `POST` | `/api/auth/verify` | 提交密码进行验证，成功后下发 HttpOnly 会话 Cookie |
| `POST` | `/api/auth/logout` | 注销登录并销毁服务端会话 |
| `GET` | `/api/scenes` | 获取所有有效画板列表（包含名称、更新时间、图元数量 `element_count`） |
| `POST` | `/api/scenes` | 创建新画板 |
| `GET` | `/api/scenes/:id` | 获取指定画板的图元数据与应用状态 |
| `PATCH` | `/api/scenes/:id` | 修改画板元数据（名称、文件夹、标签、收藏状态） |
| `PUT` | `/api/scenes/:id` | 保存画板快照，携带 `baseRevision` 乐观锁校验 |
| `PUT` | `/api/scenes/:id/thumbnail` | 保存画板缩略图预览 |
| `DELETE`| `/api/scenes/:id` | 软删除画板至回收站 |
| `GET` | `/api/scenes/trash` | 获取回收站中的画板列表 |
| `POST` | `/api/scenes/:id/restore` | 从回收站还原指定画板 |
| `DELETE`| `/api/scenes/trash` | 彻底清空回收站 |
| `GET` | `/api/folders` | 获取文件夹列表及各文件夹画板计数 |
| `POST` | `/api/folders` | 新建文件夹 |
| `PATCH` | `/api/folders/:id` | 重命名文件夹 |
| `DELETE`| `/api/folders/:id` | 删除文件夹 |
| `PUT` | `/api/files/:id` | 上传图片附件到本地文件系统 (`data/files/`) |
| `GET` | `/api/files/:id` | 读取图片附件二进制内容 |
| `GET` | `/api/backup/full` | 导出包含 SQLite 数据库与全部图片附件的完整 `.tar` 备份 |
| `GET` | `/api/health` | 容器健康检查（数据库响应性与目录可写性） |

---

## 💾 数据持久化与备份恢复

1. **数据目录组成**：
   - 挂载点 `./data` 包含 `excalidraw.db`、SQLite WAL 文件与 `files/` 实体图片目录。
2. **完整备份**：
   - 可在工作台右上角点击 **“导出完整备份”**，或请求 `/api/backup/full`，获取包含最新数据库快照和全部附件的 `.tar` 压缩包。
3. **数据恢复**：
   - 恢复前先停止容器服务：
     ```bash
     docker compose down
     ```
   - 将备份解压并整体覆盖宿主机的 `./data` 目录（确保包含 `excalidraw.db` 和 `files/`）。
   - 重新启动容器即可完整恢复所有画板与图片资源。

---

## 🧪 自动化测试与质量规范

本仓库遵循严格的代码质量与测试规范：

```bash
# 运行后端持久化测试 (基于 Bun 原生测试驱动)
bun run test:server

# 运行前端应用与工作台测试
bun run test:app

# 运行生产构建与产物体积预算检查
bun run build
```

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源发布。原 Excalidraw 项目版权归 Excalidraw 团队所有。
