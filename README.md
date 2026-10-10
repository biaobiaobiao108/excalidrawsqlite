# 狐涂画板（Bun + SQLite 自托管版）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![Bun Version](https://img.shields.io/badge/Bun-1.4%2B-black?logo=bun)](https://bun.sh) [![Docker](https://img.shields.io/badge/Docker-Ready-blue?logo=docker)](https://github.com/biaobiaobiao108/excalidrawsqlite/pkgs/container/excalidrawsqlite)

一个基于 **Bun 1.4+** 与 **原生 SQLite** 驱动的纯净、自托管虚拟手绘风格白板。专为注重数据隐私、追求极速体验的个人与团队打造。支持多画板管理、30s 防抖自动云端持久化、画板图元数量统计、图片附件归档、HttpOnly 密码保护与极速 Docker/Podman 容器化部署。

---

## ⚖️ 与原版 Excalidraw 的核心区别与优化

| 对比维度 | 官方 / 社区原版 Excalidraw | 本项目（狐涂画板，Bun + SQLite） |
| :-- | :-- | :-- |
| **运行时与架构** | Node.js + Yarn，微服务或多容器配置 | **100% 全栈 Bun (1.4.3+) 驱动**，单进程一体化极速托管，纯 TypeScript ESM 脚本工具链 |
| **数据持久化** | 仅保存在浏览器 localStorage（易丢失）或需付费订阅官方云端 | **原生 SQLite WAL 高性能持久化**，Prepared Statements、摘要列、部分索引与 keyset 分页，单卷挂载 `./data:/app/data` |
| **多画板管理** | 单画板模式，需手动导出/导入 `.excalidraw` 文件 | **内置画板工作台**：列表/网格浏览、搜索、新建、重命名、文件夹分类、回收站与 URL 直达 |
| **图元统计** | 无图元数量感知 | **内置图元数量统计**：保存时维护去 JSON 扫描的 `element_count` / `content_bytes` 摘要列并在卡片展示 |
| **静态附件与缓存** | 外部 S3/第三方存储依赖，缺少协商缓存 | **本地文件系统独立归档 + SHA-256 ETag / 304 + 隔离式分批垃圾回收** |
| **数据隐私与遥测** | 包含 Google Analytics、Sentry 遥测、Google Fonts 与官方外链 | **无第三方外链打点**：业务数据仍只访问本机/局域网服务，霞鹜文楷与思源黑体使用版本化 CDN |
| **中文字体支持** | 默认依赖外部在线 Google Fonts 或英文字体 | **通过 jsDelivr 加载「霞鹜文楷」与「思源黑体」CJK 字体**（Unicode 子集化拆分按需加载） |
| **身份认证安全** | 无或 Token 明文保存在浏览器本地存储 | **轻量密码保护 + HttpOnly 服务端 Session Cookie**，绝不暴露明文凭据 |
| **浏览器与构建** | 包含大量旧版浏览器兼容层与 Webpack/Vite 复杂配置 | **原生 Bun HTML Bundler（现代浏览器目标）**，零 Vite/Rollup/Webpack，极速秒级打包，Mermaid/CodeMirror/字体按需加载 |
| **多端同步** | 依赖手动刷新或高频轮询 | **Bun 原生 WebSocket topic 广播 + 自动重连 + revision 条件拉取** |
| **前端现代体验** | 传统弹窗布局与全局媒体查询 | **原生 `<dialog>` 无障碍模型（`aria-modal`） + CSS `@container` 容器查询与 `:has()` 现代选择器** |
| **代码工程质量** | 多套分散的编译器依赖 | **TypeScript 6.0+ 全 Monorepo 统一驱动** |
| **全栈开发体验** | 需分别启动前端开发服务与后端 API，跨端口代理 | **`bun run dev` 一体化热重载**，单命令启动前后端，原生 SSE 毫秒级自动热刷新 |
| **资源消耗** | 内存占用 500MB+，冷启动较慢 | **毫秒级冷启动，内存占用低至约 50~80MB** |

---

## ✨ 核心特性详解

### 1. 🚀 全栈 Bun 原生驱动

- 从 Monorepo 依赖管理、TypeScript 编译构建到生产后端服务托管，100% 运行于 Bun 环境。
- 零 Node.js / Yarn 依赖，彻底消除冗余中间层。

### 2. 💾 SQLite WAL 云端自动持久化

- **高性能写入**：基于 Bun 原生 `bun:sqlite`，开启 WAL (Write-Ahead Logging) 模式与高并发事务。
- **查询优化**：画板摘要列避免列表页扫描 `elements` JSON；有效画板、回收站、文件夹场景分别使用复合/部分索引，列表 API 支持 `limit`、`cursor`、`q`、`folder_id` 与 `favorite` 参数的 keyset 分页。
- **自动防抖同步**：画布修改后防抖约 30 秒自动同步至云端，并使用 `revision` 乐观锁机制防止并发快照覆盖。
- **纯净持久化与防膨胀**：前后端协同在持久化保存前自动过滤剔除已擦除/删除（`isDeleted`）图元，杜绝反复绘图擦除后场景 JSON 无节制膨胀。
- **空闲页池化复用**：已删除画板释放的数据库页自动进入 SQLite 原生 Freelist，供后续新增或保存画板直接零开销池化复用，避免频繁申请分配与截断扩容导致的磁盘 IO 抖动与写放大。
- **多端实时同步**：同源 `/api/realtime` 使用 Bun 原生 WebSocket；服务端只广播场景 ID、revision 和变更类型，客户端收到后按 ETag/revision 拉取内容，避免把大画板或附件推入 WebSocket。
- **离开保护**：离开画板或返回工作台主页时，前端会主动等待队列保存完毕再跳转。
- **附件独立存储**：图片/媒体文件存储于本地 `data/files/`，SQLite 仅保存文件元数据与 SHA-256 哈希，避免大文件膨胀数据库。
- **附件生命周期**：上传采用流式写临时文件、增量 SHA-256、原子替换与同内容幂等更新；未引用附件按批次回收，删除前先移动到 `.gc` 隔离文件，启动/维护任务会清理过期临时产物。

### 3. 🗂️ 完善的多画板与工作台系统

- **画板管理**：工作台支持网格与列表视图切换、实时搜索、画板重命名、一键复制画板。
- **图元数量统计**：画板卡片直观显示 `🎨 10 个图元 • 更新于 今天 17:30`，方便掌握画板内容规模。
- **文件夹与分类**：支持创建文件夹、归类画板与收藏常用画板。
- **回收站与生命周期保护**：支持画板软删除至回收站、一键还原与彻底清空；支持可配置的超期自动清理机制（默认 30 天 TTL），超期自动物理删除并级联触发孤立附件 GC。
- **URL 直达与设备接力**：支持 `?id=xxx` 自动识别与加载指定画板，局域网多设备无缝接力。

### 4. 🧼 极致纯净私有化 (Privacy First)

- 彻底剔除所有外部跟踪分析打点代码与 Sentry 上报；字体不直连 Google Fonts，霞鹜文楷与思源黑体使用版本化 jsDelivr CDN，默认 Excalifont 保持本地。
- 默认业务数据路径仅访问本机/局域网服务；字体 CDN、Mermaid 或外部嵌入属于明确的静态资源依赖。

### 5. ⚡ 现代浏览器性能基线

- 生产构建面向现代浏览器（支持最新 Chrome、Edge、Firefox、Safari、iOS Safari），去除过时 polyfill。Bun 1.4 使用 `target: "browser"` 表达该目标。
- **按需动态加载**：Mermaid 图表引擎、CodeMirror 代码编辑器与 CJK「霞鹜文楷」「思源黑体」（通过版本化 CDN 样式表）、pako 压缩回退均延迟至使用时加载；默认 Excalifont 保留本地，首屏极速秒开。
- **原生压缩流**：优先使用现代浏览器原生 `CompressionStream` 与 `DecompressionStream`。

### 6. 🔐 企业级轻量鉴权与安全响应头

- 通过环境变量 `AUTH_PASSWORD` 开启密码保护。
- 服务端签发安全 `HttpOnly` 会话 Cookie，会话记录持久化于 SQLite，浏览器端不存放明文凭证。
- 设置 `MCP_TOKEN` 后可通过 MCP Streamable HTTP 接入 Agent，列出/读取/新建画板，并添加或移除 Excalidraw 图元。
- 服务端注入严格的 **Content Security Policy (CSP)**，禁止 `unsafe-inline` 和 `unsafe-eval` 脚本执行。

### 7. 📦 完整备份与一键归档

- 支持一键导出包含 `excalidraw.db` 数据库、`manifest.json` 与 `files/` 图片附件的完整 `.tar` 归档包；归档先写临时文件并原子改名，再以流式响应返回，避免备份大小翻倍占用内存。

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
      - '127.0.0.1:8080:8080'
    environment:
      - AUTH_PASSWORD=your-strong-password  # 访问密码
      - TRUST_PROXY=false                   # 直连或仅本机反代时保持 false
    volumes:
      - ./data:/app/data
EOF
```

#### 2. 启动服务

```bash
docker compose up -d
```

本机访问 `http://localhost:8080` 即可开始绘制。此示例只绑定本机地址；若需要局域网直连，可将端口改为 `8080:8080`，并保持 `TRUST_PROXY=false`。

若通过 Nginx、Caddy 或 Traefik 提供 HTTPS，应让代理转发到本机 `127.0.0.1:8080`，并将 `TRUST_PROXY` 设为 `true`。此时必须确保只有可信代理能连接应用端口，且代理覆盖客户端传入的 `X-Forwarded-For`，写入实际客户端 IP；不要把启用 `TRUST_PROXY=true` 的应用端口直接暴露到公网，否则客户端可伪造转发地址并绕过登录限流。

Docker 构建上下文会排除本地 `.env.development` 和 `.env.production`。当前唯一的其他公开前端构建选项 `VITE_APP_DISABLE_PREVENT_UNLOAD` 可通过 Compose `.env` 文件或 shell 环境变量传入；不要在 `VITE_*` 配置中放秘密，因为其值会编译到浏览器资源。

---

### 方式二：Docker / Podman CLI 单行启动

**Docker CLI 运行：**

```bash
mkdir -p ./data
docker run -d \
  --name excalidraw \
  -p 127.0.0.1:8080:8080 \
  -e AUTH_PASSWORD=your-strong-password \
  -e TRUST_PROXY=false \
  -v ./data:/app/data \
  --restart unless-stopped \
  ghcr.io/biaobiaobiao108/excalidrawsqlite:latest
```

**Podman 用户（支持 rootless 与 SELinux）：**

```bash
mkdir -p ./data
podman run -d \
  --name excalidraw \
  -p 127.0.0.1:8080:8080 \
  -e AUTH_PASSWORD=your-strong-password \
  -e TRUST_PROXY=false \
  -v ./data:/app/data:Z \
  --userns=keep-id \
  --restart unless-stopped \
  ghcr.io/biaobiaobiao108/excalidrawsqlite:latest
```

---

### 方式三：本地 Bun 源码运行

#### 前置要求

- 安装 [Bun](https://bun.sh/) (v1.4.3+)

#### 操作步骤

```bash
# 1. 克隆仓库
git clone https://github.com/biaobiaobiao108/excalidrawsqlite.git
cd excalidrawsqlite

# 2. 安装依赖 (使用 Bun 维护 bun.lock)
bun install

# 3. 构建生产产物并启动全栈服务 (默认端口 8080)
bun run build
AUTH_PASSWORD=your-password bun run start
```

PowerShell 请先设置当前终端会话的环境变量：

```powershell
$env:AUTH_PASSWORD = "your-password"
bun run build
bun run start
```

如果你明确需要关闭密码保护，请改为设置 `$env:ALLOW_ANONYMOUS = "true"`；生产环境不会默认匿名开放。

如需进行前端热重载开发：

```bash
# 一键启动前后端一体化开发服务器 (内置源码变动监听 + 原生 SSE 浏览器热刷新)
AUTH_PASSWORD=your-password bun run dev
```

打开浏览器访问 `http://localhost:8080`，修改任意 `excalidraw-app` 或 `packages` 源码即可体验毫秒级增量重新编译并自动刷新。

---

## ⚙️ 环境变量速查表

| 环境变量 | 默认值 | 必填项 | 说明 |
| :-- | :-- | :-: | :-- |
| `AUTH_PASSWORD` | _无_ | **二选一** | 访问密码。设置后启用密码验证并下发 HttpOnly 会话 Cookie。 |
| `MCP_TOKEN` | _无_ | 否 | 设置后启用 `/mcp/<URL 编码后的 MCP_TOKEN>` MCP 服务，无需认证请求头。未设置时 MCP 端点关闭。 |
| `ALLOW_ANONYMOUS` | `false` | **二选一** | 设为 `true` 时显式允许免密匿名直接访问；生产环境未设置密码时必须显式开启。 |
| `TRUST_PROXY` | `false` | 否 | 仅在应用端口被可信反向代理隔离保护时设为 `true`，用于识别 HTTPS 并下发 Secure Cookie。代理需覆盖 `X-Forwarded-For` 为实际客户端 IP，且应用端口不得允许不可信客户端直连；直连部署应保持 `false`，以防伪造转发头绕过登录限流。 |
| `PORT` | `8080` | 否 | 服务端监听端口。 |
| `HOST` | `0.0.0.0` | 否 | 服务监听地址。默认绑定所有网络接口；需要限制为本机访问时可显式设置 `HOST=127.0.0.1`。 |
| `DATA_DIR` | `./data` | 否 | SQLite 数据库文件与图片附件存储目录。 |
| `AUTH_SESSION_TTL_MS` | `604800000` (7 天) | 否 | 登录会话在服务端与浏览器 Cookie 中的有效期（毫秒）。 |
| `TRASH_RETENTION_DAYS` | `30` (30 天) | 否 | 回收站画板保留天数。设为 `0` 禁用自动清理；超期后自动物理删除并回收 SQLite 空间与关联孤立附件。 |
| `MAX_FILE_BYTES` | `4194304` (4MB) | 否 | 单个图片/附件上传大小限制（字节）。 |
| `MAX_SCENE_BODY_BYTES` | `16777216` (16MB) | 否 | 单个画板 JSON 数据最大请求体大小。 |
| `MAX_IN_FLIGHT_BODY_BYTES` | `67108864` (64MB) | 否 | 所有并发请求体的聚合内存预算；若配置低于单请求上限，会自动提升到安全下限。 |
| `MAX_BACKUP_BYTES` | `134217728` (128MB) | 否 | 单次数据库快照或完整备份的原始内容大小上限。 |

---

## 🤖 MCP：让 Agent 读取和绘制画板

MCP 使用标准 Streamable HTTP 传输，端点为 `http://你的服务地址:8080/mcp/<URL 编码后的令牌>`。设置高强度随机令牌后重启服务：

```bash
MCP_TOKEN=replace-with-a-long-random-secret bun run dev
```

Windows PowerShell：

```powershell
$env:MCP_TOKEN = "replace-with-a-long-random-secret"
bun run dev
```

在支持远程 HTTP MCP 的 Agent 客户端中添加服务：

```json
{
  "mcpServers": {
    "excalidrawsqlite": {
      "type": "http",
      "url": "http://127.0.0.1:8080/mcp/replace-with-a-long-random-secret"
    }
  }
}
```

只接受路径令牌，旧的 `Authorization: Bearer` 和 `?token=...` 均不生效。令牌使用 `encodeURIComponent` 编码后放在 `/mcp/` 后面；无需额外配置请求头。远程连接使用 HTTPS，并在反向代理访问日志中对 MCP 令牌路径脱敏。

工具按“尽量一次完成”安排：

| 工具 | 用途 |
| --- | --- |
| `list_boards` | 名称搜索及文件夹、收藏、精确标签筛选；`view=all/recent/favorites/trash`，支持排序和 `nextCursor` 分页。 |
| `get_board` | 默认紧凑图元及修订号；`summary` 元数据，`full` 内部字段。按 `elementIds`、文字 `query`、`type` 定位，支持 `limit/offset/maxChars`，返回 `nextOffset/truncated`。 |
| `get_boards_batch` | 一次读取最多 20 块画板，共享字符预算，逐条返回错误或分页信息；不是跨画板一致快照。 |
| `create_board` | 一次创建并绘制，可同时设置背景、收藏、标签和 `folderId/folderName`；允许同名，省略图元创建空板。 |
| `update_board` | 一次合并删除、新增、`updates` 原地修改和画板元数据，原子保存一个修订；顺序为删除→新增→原地修改。 |
| `update_element` | 传 `update.id` 与待修改字段，保留图元 ID、连接和其余字段，改颜色无需回传完整 JSON。 |
| `add_elements` / `remove_elements` | 单纯追加或按 ID 移除图元；普通绘图无需先创建空板再调用追加。 |
| `list_folders` / `list_tags` | 分页读取文件夹、标签及画板计数。 |
| `ensure_folder` / `create_folder` | 按精确名称幂等获取或创建，或明确创建新文件夹；同名歧义要求使用 ID。 |
| `update_folder` / `delete_folder` | 修改名称、图标、颜色；删除仅把画板移至根目录，`dryRun=true` 预览，执行需 `confirm=true`，可校验 `expectedBoardCount`。 |
| `manage_board` | 一次合并改名、收藏、移动与标签操作；`tags` 必须与 `tagMode=replace/add/remove` 同传，相同元数据返回 `noop`。 |
| `delete_board` / `restore_board` | 仅软删除或还原，没有永久删除参数；回收站受 `TRASH_RETENTION_DAYS` 保留期限约束。 |
| `batch_manage_boards` | 最多 100 项 `manage/delete/restore`，每项必传 `expectedRevision`；独立执行，返回逐项结果、`noop` 和 `partial`。 |

每次最多传入 1,000 个图元描述，接受矩形、椭圆、菱形、文字、直线和箭头。形状的 `text` 自动生成绑定文字，回执的 `addedCount` 与 `elementIds` 包含这些文字。可指定稳定 `id`，箭头的 `startBinding/endBinding.elementId` 能引用同批或已有节点，移动/缩放节点时保留连接；`points` 是绝对画布坐标，支持多段折线，不与二点坐标字段混用。删除形状同时删除绑定文字并清理引用。

图元和嵌套对象严格拒绝未知字段，`strokeColour`、`fillStyles`、`zIndex` 等错误不会写库。颜色接受十六进制、`transparent` 和 schema 列出的常见 CSS 颜色名；`opacity` 为 0–100 百分比，可带小数；`rotation` 以度为单位；`roundness` 支持像素半径或圆角对象；文字可指定 `fontSize/fontFamily/textAlign`。读取或修改已有场景时保留图片及自由画笔图元，但不提供图片上传、自由画笔生成、原始场景覆盖、备份、永久删除或清空回收站工具。

创建或移动时 `folderId` 与 `folderName` 二选一，`folderId=null` 表示根目录，`folderName` 自动获取或创建文件夹；已有文件夹不修改外观，同名歧义报错。`create_board/update_board.tags` 表示完整标签列表，增删标签使用 `manage_board`。不修改内容地打开画板、保存或返回主页不再产生内容修订；恢复未保存草稿和真实编辑仍正常保存。

工具结果的完整机器数据在 `structuredContent`，文本 `content` 只给简短说明；客户端须保留结构化结果并检查 `ok`、`error.code`。写入默认返回修订号、数量、生成的 ID 和画板 URL，无需再次读取全文确认成功。旧客户端如只解析文本 JSON，需改为读取 `structuredContent`；需要完整原始场景的调用需显式设置 `get_board.view=full`。

增量修改可传读取时的 `expectedRevision`；省略时服务端读取最新版本并用乐观锁保存。画板写入沿用现有的校验、冲突保护和实时通知，已打开且没有未保存本地修改的画板会自动刷新。发生 `REVISION_CONFLICT` 时重新读取并判断如何合并，不要盲目重试；业务错误返回 `ok=false`，不会标记为工具异常。

例如创建带文字的流程图节点，只需一次调用 `create_board`：

```json
{
  "name": "流程示意",
  "folderName": "工作流",
  "favorite": true,
  "tags": ["流程"],
  "elements": [
    { "id": "start", "type": "rectangle", "x": 0, "y": 0, "width": 180, "height": 80, "text": "开始" },
    { "id": "decision", "type": "diamond", "x": 300, "y": 100, "width": 160, "height": 80, "text": "是否完成" },
    { "type": "arrow", "points": [[180, 40], [240, 40], [240, 140], [300, 140]],
      "startBinding": { "elementId": "start" }, "endBinding": { "elementId": "decision" } }
  ]
}
```

只修改节点颜色时调用 `update_element`，无需删除重建：

```json
{ "boardId": "返回的画板 ID", "update": { "id": "start", "strokeColor": "#315f4c", "opacity": 80.5 } }
```

MCP 令牌拥有画板读写能力，请像密码一样保管；不要把它提交到仓库或暴露在浏览器端代码中。

---

## 📂 项目结构概览

```text
├── server/
│   ├── server.ts           # Bun 服务启动入口与优雅退出处理
│   ├── mcp.ts              # MCP Streamable HTTP 工具与认证入口
│   ├── routes.ts           # 纯原生 API 路由与静态资源/SPA 分发
│   ├── dev-server.ts       # 开发态源码增量监听与热重载编译调度
│   ├── dev-reload.ts       # 基于 Web Streams 的原生 SSE 广播通道
│   ├── config.ts           # 环境变量、服务配置与限制常量
│   ├── types.ts            # 后端共享类型
│   ├── errors.ts           # HTTP 错误类型
│   ├── http.ts             # 请求体、响应、安全头与 CORS/CSP
│   ├── validation.ts       # 请求参数与资源 ID 校验
│   ├── auth.ts             # 密码会话、Cookie 与限流
│   ├── database.ts         # 当前 SQLite schema 初始化与 WAL 配置
│   ├── runtime.ts          # 运行时与持久化目录初始化
│   ├── scenes.ts           # 画板、文件夹与场景数据处理
│   ├── files.ts            # 附件、缩略图与存储一致性维护
│   ├── backup.ts           # SQLite 快照与完整备份
│   ├── realtime.ts         # Bun 原生 WebSocket 鉴权、topic 与变更广播
│   ├── static.ts           # 静态资源路径与 SPA fallback 辅助
│   └── ...                  # 持久化、备份、并发与安全模块
├── scripts/
│   ├── build-frontend.ts   # 纯原生 Bun HTML Bundler 打包引擎 (含 dev/watch)
│   ├── build-version.ts    # 版本号与 Git SHA 元数据生成 (纯 Bun TypeScript ESM)
│   ├── buildPackage.ts     # Packages 子包 ESM 打包工具
│   └── release.ts          # 发布与 Changelog 自动化脚本
├── excalidraw-app/         # Excalidraw 前端主应用 (Bun HTML Bundler + React)
│   ├── components/
│   │   ├── WorkspaceHome.tsx     # 工作台多画板管理、文件夹、回收站与卡片组件
│   │   ├── AuthDialog.tsx        # 密码验证与鉴权弹窗
│   │   └── ...
│   ├── data/
│   │   ├── cloudStorage.ts # 云端 REST API 客户端与数据接口
│   │   └── cloudSync.ts    # 30s 防抖保存队列、分页读取与 WebSocket 自动重连同步
│   └── index.html          # 前端 HTML 入口 (直接由 Bun.build 解析打包)
├── packages/               # Excalidraw 核心内部包 (Monorepo)
│   ├── excalidraw/         # 核心渲染与画布引擎 (Excalifont 本地，霞鹜文楷与思源黑体由 CDN 加载)
│   ├── element/            # 图元数据结构与计算
│   └── ...
├── tests/
│   ├── unit/                # Bun 原生纯逻辑单元测试
│   └── server/              # Bun SQLite/API 集成测试
├── docs/                   # GitHub Pages 介绍落地页 (单文件、现代化动效与手绘 SVG)
├── Dockerfile              # oven/bun:1.4.3-alpine 纯 Bun 多阶段极小容器构建 (零 Node.js)
├── docker-compose.yml      # 容器化编排配置文件
└── bun.lock                # Bun 统一依赖锁文件
```

### 后端模块职责

后端仍由 Bun 单进程提供 API、静态资源和 SQLite 持久化。`server/server.ts` 是启动入口，同时保留现有公共导出，便于测试和外部调用继续使用原有导入路径。新增后端逻辑应放入对应职责模块，不要把业务逻辑重新集中到入口文件。

模块依赖遵循“共享类型与基础能力 → 数据和业务模块 → 路由 → 启动入口”的方向。路由继续使用原生 `Request`/`Response` 和手工路径匹配，不额外引入 HTTP 框架或路由依赖。SQLite 只初始化当前 schema，不维护版本号或旧库迁移；修改 API、鉴权、schema 或附件存储时，保持当前契约和安全边界，并运行后端测试。

---

## 📡 后端 API 接口概览

| 请求方式 | 路由 Endpoint | 描述 |
| :-- | :-- | :-- |
| `GET` | `/api/auth/status` | 查询当前密码保护状态及当前客户端登录态 |
| `POST` | `/api/auth/verify` | 提交密码进行验证，成功后下发 HttpOnly 会话 Cookie |
| `POST` | `/api/auth/logout` | 注销登录并销毁服务端会话 |
| `GET` | `/api/scenes` | 获取有效画板 keyset 分页；`limit` 默认为 50、最大 100，支持 `cursor/q/folder_id/favorite/sort` 筛选与排序 |
| `POST` | `/api/scenes` | 创建新画板 |
| `GET` | `/api/scenes/:id` | 获取指定画板的图元数据与应用状态 |
| `GET` | `/api/realtime` | 同源 Bun 原生 WebSocket；按 `scene_id` 订阅轻量场景/工作区变更事件 |
| `PATCH` | `/api/scenes/:id` | 修改画板元数据（名称、文件夹、标签、收藏状态） |
| `PUT` | `/api/scenes/:id` | 保存画板快照，携带 `baseRevision` 乐观锁校验 |
| `PUT` | `/api/scenes/:id/thumbnail` | 保存画板缩略图预览 |
| `DELETE` | `/api/scenes/:id` | 软删除画板至回收站 |
| `GET` | `/api/scenes/trash` | 获取回收站画板 keyset 分页；支持同样的分页参数 |
| `POST` | `/api/scenes/:id/restore` | 从回收站还原指定画板 |
| `DELETE` | `/api/scenes/trash` | 彻底清空回收站 |
| `GET` | `/api/folders` | 获取文件夹列表及各文件夹画板计数 |
| `POST` | `/api/folders` | 新建文件夹 |
| `PATCH` | `/api/folders/:id` | 重命名文件夹 |
| `DELETE` | `/api/folders/:id` | 删除文件夹 |
| `PUT` | `/api/files/:id` | 上传图片附件到本地文件系统 (`data/files/`)，自动计算 SHA-256 哈希 |
| `GET` | `/api/files/:id` | 读取图片附件内容（支持 `ETag` 与 `If-None-Match` 协商缓存，秒级 `304 Not Modified`） |
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
# 运行带 TypeScript 检查的 Bun 原生单元测试
bun test --check

# 运行后端持久化测试 (基于 Bun 原生测试驱动，耗时 < 1.5s)
bun run test:server

# 全局类型检查（由 Bun 原生 bun check 执行）
bun run test:typecheck

# 运行生产构建
bun run build

# 运行生产构建与压缩后产物体积预算检查
# 首屏 JS 512 KiB、CSS 220 KiB；懒加载 JS 1 MiB、CSS 220 KiB
bun run test:size

# 一键运行全量质量测试 (单元、服务端、类型、构建与体积)
bun run test:all
```

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源发布。原 Excalidraw 项目版权归 Excalidraw 团队所有。
