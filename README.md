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

### 部署与升级边界

当前生产拓扑按**单个服务实例**设计：SQLite 数据库和附件写入同一数据卷，实时通知由服务进程内广播。不要通过启动多个应用副本来共享同一数据目录；多实例部署需要额外的共享存储、跨进程通知和限流协调能力。

服务只初始化当前 SQLite schema，不执行旧版本数据库迁移。涉及数据库结构变化的升级前，请导出并确认一份完整备份，再升级服务。

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
| `MCP_TRACE` | `false` | 否 | 临时启用 MCP 业务处理分段计时；记录内部 API 读写、图元转换、回执构建耗时与读写次数，不记录令牌、参数或画板正文。 |
| `ALLOW_ANONYMOUS` | `false` | **二选一** | 设为 `true` 时显式允许免密匿名直接访问；生产环境未设置密码时必须显式开启。 |
| `TRUST_PROXY` | `false` | 否 | 仅在应用端口被可信反向代理隔离保护时设为 `true`，用于识别 HTTPS 并下发 Secure Cookie。代理需覆盖 `X-Forwarded-For` 为实际客户端 IP，且应用端口不得允许不可信客户端直连；直连部署应保持 `false`，以防伪造转发头绕过登录限流。 |
| `PORT` | `8080` | 否 | 服务端监听端口。 |
| `HOST` | `0.0.0.0` | 否 | 服务监听地址。默认绑定所有网络接口；需要限制为本机访问时可显式设置 `HOST=127.0.0.1`。 |
| `DATA_DIR` | `./data` | 否 | SQLite 数据库文件与图片附件存储目录。 |
| `AUTH_SESSION_TTL_MS` | `604800000` (7 天) | 否 | 登录会话在服务端与浏览器 Cookie 中的有效期（毫秒）。 |
| `TRASH_RETENTION_DAYS` | `30` (30 天) | 否 | 回收站画板保留天数。设为 `0` 禁用自动清理；超期后自动物理删除并回收 SQLite 空间与关联孤立附件。 |
| `MAX_FILE_BYTES` | `4194304` (4MB) | 否 | 单个图片/附件上传大小限制（字节）。 |
| `MAX_SCENE_BODY_BYTES` | `16777216` (16MB) | 否 | 单个画板 JSON 数据最大请求体大小。 |
| `MAX_IN_FLIGHT_BODY_BYTES` | `67108864` (64MB) | 否 | 所有并发请求体的聚合字节预算；不包含 JSON 解析后对象及运行时额外分配。若配置低于单请求上限，会自动提升到安全下限。启用 MCP 时，下限至少为两倍单画板请求上限，为工具内部 API 调用保留预算。 |
| `MAX_BACKUP_BYTES` | `134217728` (128MB) | 否 | 单次数据库快照或完整备份的原始内容大小上限。 |

构建版本标识统一通过 `BUILD_SHA` 注入（Docker 同名 build arg），不接受旧构建环境变量别名。默认静态产物目录仅为 `excalidraw-app/build`，自定义目录需显式指定 `STATIC_DIR`；不会再回退到旧的 `dist/build` 目录。损坏或缺失的修订号、图元数量、场景 JSON 会明确报错，不推测版本或返回空场景。

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

只接受路径令牌，`Authorization: Bearer` 和 `?token=...` 均不生效。令牌使用 `encodeURIComponent` 编码后放在 `/mcp/` 后面；无需额外配置请求头。远程连接使用 HTTPS，并在反向代理访问日志中对 MCP 令牌路径脱敏。

容器经 HTTPS 反代部署时，在 Compose 同目录的 `.env` 设置 `MCP_TOKEN` 和 `TRUST_PROXY=true`，然后执行 `docker compose up -d --build`。默认 Compose 已将这两个变量传给容器，并只把应用端口绑定到 `127.0.0.1`。MCP 客户端填写公网地址 `https://boards.example.com/mcp/<URL 编码后的令牌>`；无需登录网页，也无需 `Authorization` 请求头。建议用独立域名的根路径部署，当前应用不支持通过 `X-Forwarded-Prefix` 挂载到任意子路径。

下面的 Nginx 配置放在已有的 HTTPS `server` 块内，专门代理 MCP；网页仍沿用原有的 `location /` 配置。`proxy_pass` 不添加 URI，保留完整令牌路径；转发实际域名、协议及客户端 IP。启用 `TRUST_PROXY` 后，MCP 回执中的画板链接会使用这个公网 HTTPS 地址。

```nginx
location ^~ /mcp/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    access_log off;
}
```

MCP 使用 HTTP JSON/SSE，不需要 WebSocket Upgrade。代理需放行 `GET/POST/DELETE/OPTIONS`，保留 `Accept`、`Content-Type`、`Mcp-*`、`Last-Event-Id` 请求头；不要套用网页登录跳转或验证码。关闭响应缓冲让 SSE 及时送达，设置适当读超时避免代理提前断开连接（[Nginx 代理模块文档](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering)）。示例关闭该路径的访问日志以避免记录令牌；如需日志，使用脱敏格式。若反代也运行在容器中，应在私有容器网络中转发到应用服务名及端口，而非代理容器自身的 `127.0.0.1`。

网关、WAF 或 OpenResty 的 User-Agent 过滤规则也需放行整个 `/mcp/` 路径，包括 Python SDK 的默认 UA；保留真实 User-Agent，不要靠伪装 curl 解决。若 `initialize` 等带 JSON-RPC `id` 的请求收到 `202` 空响应，应使用同一请求比较不同 UA 的公网响应与直连 Bun 响应，并检查各层拦截日志；不能把它当作初始化成功。协议通知（例如 `notifications/initialized`）没有 `id`，正常接受时可以返回 `202` 空响应。需要拒绝时返回明确的 `4xx`，不要用空 `202` 隐藏拦截。本仓库没有线上网关配置，应用更新不会自动解除网关规则。

工具按“尽量一次完成”安排：

| 工具 | 用途 |
| --- | --- |
| `list_boards` | 名称搜索及文件夹、收藏、精确标签筛选；`view=all/recent/trash`，收藏统一使用 `favorite=true/false`（省略不限），支持排序和 `nextCursor` 分页；不存在的文件夹 ID 明确报错。 |
| `get_board` | 默认 `compact` 只读文字、几何与连接，标签折入本体；`elements` 含样式，`summary` 元数据，`full` 内部字段，`input` 可写字段。按 `elementIds`、文字 `query`、`type` 定位，支持 `limit/offset/maxChars`，返回 `nextOffset/truncated`。 |
| `inspect_layout` | 只读检查文字重叠、容器文字溢出、可能的元素碰撞与已绑定箭头异常；返回问题图元 ID、严重程度、建议和检测完整性，便于修改后复查。 |
| `get_boards_batch` | 一次读取最多 20 块画板，共享字符预算，逐条返回错误或分页信息；与单读一样 `maxChars` 最少 1000，连必要元数据也放不下则明确报错；不是跨画板一致快照。 |
| `create_board` | 一次创建并绘制，可同时设置背景、收藏、标签和 `folderId/folderName`；允许同名，省略图元创建空板。 |
| `create_diagram` | 自动绘制流程图、时间线、分层架构箱体或多泳道关系图；支持区域、原生分组与真实绑定连线，可同时设置文件夹、标签和收藏。 |
| `create_layout` | 创建卡片网格，指定列数、卡片宽度、间距与内边距；按内容估算行高，每张卡片使用原生分组。 |
| `measure_text` | 创建前估算文字宽高、换行和行数，与 MCP 绘制使用同一估算器，返回 `estimated=true`。 |
| `update_board` | 一次合并删除、新增、`updates` 原地修改和画板元数据，原子保存一个修订；顺序为删除→新增→原地修改。 |
| `update_element` | 传 `update.id` 与待修改字段，保留图元 ID、连接和其余字段，改颜色无需回传完整 JSON。 |
| `add_elements` / `remove_elements` | 单纯追加或按 ID 移除图元；普通绘图无需先创建空板再调用追加。 |
| `copy_elements` | 按 ID 同板或跨板复制，自动生成新 ID、平移并重连内部箭头；返回旧 ID 到新 ID 的 `idMap`。 |
| `list_folders` / `list_tags` | 分页读取文件夹、标签及画板计数。 |
| `ensure_folder` / `create_folder` | 按精确名称幂等获取或创建，或明确创建新文件夹；同名歧义要求使用 ID。 |
| `update_folder` / `delete_folder` | 修改名称、图标、颜色；删除仅把画板移至根目录，`dryRun=true` 预览，执行需 `confirm=true`，可校验 `expectedBoardCount`。 |
| `manage_board` | 一次合并改名、收藏、移动与标签操作；单传 `tags` 默认替换，`tagMode=add/remove` 显式追加/移除，相同元数据返回 `noop`。 |
| `delete_board` / `restore_board` | 仅软删除或还原，没有永久删除参数；回收站受 `TRASH_RETENTION_DAYS` 保留期限约束。 |
| `batch_manage_boards` | 最多 100 项 `manage/delete/restore`，每项必传 `expectedRevision`；独立执行，返回逐项结果、`noop` 和 `partial`。 |

每次最多传入 1,000 个图元描述，接受矩形、椭圆、菱形、文字、直线和箭头。形状的 `text` 自动生成绑定文字，回执的 `addedCount` 包含这些文字；需要 ID 时传 `responseMode=ids`，按本体与自动文字分别返回。可指定稳定 `id`，新建箭头只传 `startBinding/endBinding.elementId` 即自动连接同批或已有节点，无需计算端点；自连接或同中心节点须显式传坐标。移动/缩放节点时保留连接；显式路径统一为 `x/y` 原点加相对 `points`，支持多段折线。删除形状同时删除绑定文字并清理引用。

`line/arrow` 显式路径须提供 `x/y + points`，例如 `{"type":"line","x":100,"y":200,"points":[[0,0],[80,40]]}` 表示从 (100,200) 到 (180,240)。不接受起终点字段或省略原点的路径。所有全局点坐标仍受范围校验。更新路径时同样须提供 `x/y + points`；仅传 `x` 或 `y` 则平移原有路径。所有读取视图统一返回图元 `x/y` 与相对 `points`，`input` 可直接写回。

`manage_board` 和批量 `action=manage` 单传 `tags` 时默认 `tagMode="replace"`，与创建和更新画板的完整标签列表语义一致，`tags:[]` 清空标签。只想追加或移除时须显式使用 `add/remove`；单独传 `tagMode` 而没有 `tags` 仍会明确报错。

无箭头但需要随节点移动的连线使用 `{"type":"arrow","startBinding":{"elementId":"parent"},"endBinding":{"elementId":"child"},"endArrowhead":null}`；`startArrowhead` 默认也为 `null`。`line` 是固定坐标线段，原生编辑器的绑定跟随逻辑只处理 `arrow`，因此不为 `line` 添加另一套绑定语义。自动布局时 `create_diagram.edges` 也可传 `{"from":"parent","to":"child","endArrowhead":null}`，适用于思维导图或组织结构，省略则保留默认箭头。

流程图与时间线优先 `create_diagram`，只需表达内容与关系，不需要计算坐标。最多 100 个节点、200 条连接，默认 `layout=flowchart`、`direction=vertical`、`theme=forest`；可选 `timeline`、`horizontal` 和 `paper/ocean`。节点 `id` 可直接用于后续原地修改；省略 `edges` 自动依节点顺序连接，显式 `[]` 则不连线。分支按关系分层，循环节点同层，返回连线在外侧绕行；自动测量文字高度，所有箭头真实绑定到节点。最终仍使用普通 Excalidraw 图元并一次保存，不构成另一套数据模型。示例：

```json
{
  "name": "事件时间线",
  "layout": "timeline",
  "nodes": [
    { "id": "early", "title": "2022 年", "body": "发布早期作品" },
    { "id": "later", "title": "2025 年", "body": "新的发展阶段" }
  ]
}
```

高级布局使用同一个 `create_diagram`，选择 `layout="architecture"` 或 `layout="swimlane"`，新增 `regions` 和 `nodes[].regionId`。最多 24 个区域、100 个节点、200 条边；每个节点必须属于有效叶区域，重复 ID、空区域、循环父级、超深嵌套和无效引用会明确报错。高级模式省略 `edges` 时不自动连接；流程图与时间线保留原来的顺序连接默认值。

分层架构支持两级箱体，外层按输入顺序沿主方向排列，子箱体沿交叉方向排列；叶区域内节点按输入顺序分行，每行最多三列。默认纵向，也支持 `direction="horizontal"`。以下调用创建接入层和包含计算、数据模块的双层平台箱体：

```json
{
  "name": "服务架构全景",
  "layout": "architecture",
  "regions": [
    { "id": "access", "title": "接入层" },
    { "id": "platform", "title": "平台层" },
    { "id": "compute", "title": "计算模块", "parentId": "platform" },
    { "id": "data", "title": "数据模块", "parentId": "platform" }
  ],
  "nodes": [
    { "id": "gateway", "title": "API 网关", "body": "统一鉴权与限流", "regionId": "access" },
    { "id": "worker", "title": "任务服务", "body": "处理业务任务", "regionId": "compute" },
    { "id": "cache", "title": "缓存服务", "body": "共享结果缓存", "regionId": "data" }
  ],
  "edges": [{ "from": "gateway", "to": "worker" }, { "from": "worker", "to": "cache" }]
}
```

泳道使用平级区域，按连接关系分层，所有泳道共享阶段位置。默认横向推进、泳道上下排列；`direction="vertical"` 时上下推进、泳道左右排列。支持分支、回路和自连接，以下调用创建跨系统泳道：

```json
{
  "name": "订单跨系统流程",
  "layout": "swimlane",
  "regions": [{ "id": "web", "title": "客户端" }, { "id": "service", "title": "业务服务" }, { "id": "storage", "title": "数据存储" }],
  "nodes": [
    { "id": "submit", "title": "提交订单", "regionId": "web" },
    { "id": "validate", "title": "校验库存", "body": "库存不足时返回客户端", "regionId": "service" },
    { "id": "persist", "title": "保存订单", "regionId": "storage" },
    { "id": "notify", "title": "显示结果", "regionId": "web" }
  ],
  "edges": [{ "from": "submit", "to": "validate" }, { "from": "validate", "to": "persist" }, { "from": "persist", "to": "notify" }]
}
```

区域背景、标题和节点共享原生嵌套分组；跨区域连线不归入任一区域的分组，但两端真实绑定节点，移动节点时连接跟随。返回 `regions` 中的 `regionId/backgroundId/titleId/groupId/nodeIds/elementIds/bounds`、`nodeRegions` 和全图 `bounds`；按 ID 的 MCP 操作仍需显式传要修改或复制的 ID。布局复用文字估算器并返回 `estimated=true`，不会把结果宣称为浏览器字体测量。连线通过节点及区域标题之间的留白通道或外围绕行，复杂关系仍可能交叉，生成后可以用 `inspect_layout` 复查。

复杂卡片排版可使用 `create_layout`，当前支持 `mode="grid"`。例如：

```json
{"name":"知识卡片","columns":2,"cardWidth":320,"gap":24,"padding":20,"cards":[{"id":"first","title":"概念","body":"固定宽度换行，按内容估算高度。"},{"id":"second","title":"实践","body":"背景、标题和正文共享原生分组。"}]}
```

每行高度以该行最高卡片计算，返回 `cards` 中每张卡片的 `groupId/elementIds` 与几何位置。独立绘制也可在图元描述中传 `groupId`，或用 `groupIds` 指定最多 8 层原生嵌套分组；相同分组在编辑器中可整体拖动。更新 `groupId:null` 或 `groupIds:[]` 解除分组，二者不能同时传。绑定文字继承所属形状的分组。`copy_elements` 为副本生成新分组，返回 `groupIdMap`，避免副本与原件联动；按 ID 的 MCP 修改与复制不会自动扩展到整个分组，需要整体移动时传卡片的全部 `elementIds`。

卡片扣除两侧 `padding` 后的文字宽度，至少需要容纳一个对应字号的字符；过窄时会要求增大 `cardWidth`、减小内边距或字号。

`measure_text` 接受 `text/fontFamily/fontSize/width`，返回 `width/height/text/originalText/lineCount`；`width` 固定换行宽度，省略时估算自然宽度。测量与网格使用现有 MCP 文字估算器，明确返回 `estimated=true`，不宣称浏览器字体测量精度，实际显示仍需打开画板确认。

`create_board/create_diagram/create_layout` 可传 `idempotencyKey`（1–128 字符），记录有效期 24 小时。同一 key、相同创建参数重试，返回原画板当前摘要和 `idempotentReplay:true/addedCount:0`；不会重新创建，也不重复首次生成的图元 ID 或卡片映射，需要时用 `get_board` 读取。`responseMode` 不影响幂等参数判断；同一 key 改动业务参数返回冲突，应为新操作换 key。画板已删除时保留幂等墓碑并报冲突，记录过期后才能复用。记录有容量上限，满时明确报错，保持现有有效记录。

自由绘图可在 `create_board/add_elements/update_board` 显式设 `autoBind:true`，对本次新增箭头尚未绑定的端点尝试连接 24 个画布单位以内的最近矩形、椭圆或菱形。默认关闭，保留显式绑定和箭头路径，距离接近的多个候选或推断自连接时不猜测。只检查新箭头，不修改已有装饰箭头；返回 `autoBinding` 的绑定列表、提示和 `complete`，超过容量时保持未处理端点，需改用显式绑定。

创建复杂画板后，可以先检查几何布局，再按问题图元 ID 修改并复查：

```json
{"boardId":"画板ID","checks":["text_overlap","text_overflow","element_collision","arrow_connection"]}
```

调用 `inspect_layout` 时省略 `checks` 会检查全部四项。返回 `boardId/revision`、`summary.errors/warnings` 和 `issues`，每条问题包含 `type/severity/elementIds/message`，并可包含 `suggestion`。将涉及的 ID 用于 `update_board.updates`，保存时使用检查结果的 `revision` 作为 `expectedRevision`，再调用检查确认。检查本身不改变图元或修订号，text 摘要显示错误、警告、完成情况及容器跳过数量，不重复业务 JSON。

重叠提示的 `metrics.overlapRatio/overlapArea` 提供相交比例与面积，箭头距离提示的 `metrics.distance` 为端点到目标轮廓的距离，单位均基于画布坐标。独立文字重叠可返回 `suggestedUpdate:{id,dx,dy}`，可直接放入 `update_board.updates`；这只提供分离当前两个图元的候选方案，不保证整体布局合理，也不会自动执行。绑定文字和形状碰撞不提供独立平移建议，避免破坏标签、阴影与背景叠层。大小接近且偏移很小的实心矩形标为 `metrics.possibleLayering=true`，仍保留确认提示，不断言设计错误。透明图元和空白文字不参与视觉碰撞检查，断开的绑定仍可报告数据问题。

`text_overflow` 同时检查原生绑定标签和明确结构的分组卡片：`create_layout` 的背景与标题/正文通过分组及图元角色名称关联，即使文字完全移出卡片也能找到背景，并按固定文字宽度恢复可确定的内边距。普通分组只有唯一实心矩形候选时才作结构推断，多个背景无法确定则不猜测。`checks.text_overflow.checkedContainers/checkedPairs` 表示实际检查的容器关系，`skippedNoContainer` 表示未找到容器的文字数，`skippedAmbiguousContainer` 表示容器歧义；任一未覆盖、异常或预算截断都会令 `complete=false`。`status` 明确区分 `completed`（覆盖完成）、`partial`（只检查了部分）、`not_executed`（没有执行可确认的容器边界检查）和 `not_applicable`（没有适用文字，例如只有合法箭头标签），不应把零问题或零容器视为无溢出。分组索引和候选比较都有上限，统计分别见 `groupReferences/groupCandidatePairs`。

手工卡片优先给背景和独立文字设置相同 `groupId`，或使用形状绑定标签。未分组文字默认不凭位置猜容器；需要时显式传 `inspect_layout({boardId,checks:["text_overflow"],inferTextContainers:true})`，只对无绑定、无分组文字按旋转后的文字起点推断唯一实心矩形，并将结果标为几何启发式。多个候选仍会跳过，几何索引及比较有容量上限；独立文字完全移出所有候选后无法恢复其原归属，不能替代分组或绑定。

文字重叠按几何相交面积比例至少 0.08 且面积大于 1 检测。每项 `severityHint` 根据比例分为 `negligible`（小于 0.1）、`minor`（0.1 至小于 0.5）和 `major`（至少 0.5），`metrics.overlapDepth` 为沿旋转多边形分离轴的最小脱离平移深度，单位为画布单位。它们描述几何程度，不保证实际文字可读性，低比例也不自动忽略。诊断 text 另列问题类型计数、最多 3 项图元 ID/严重性示例和最大几何重叠，保持两行及 1024 字符上限。

箭头绑定标签的重叠检查使用原生路径计算显示位置，支持多段和旋转箭头，不依赖标签可能过时的存储坐标。异常路径、非原生水平标签或检查预算超限仍会明确返回检查未完成及原因。

检测复用图元已存储的文字尺寸与换行结果，不重新测量中文或 Excalifont 字体像素；可能的几何遮挡会标记为 warning。正常的容器包含、背景叠放和箭头穿过背景不直接视为错误，没有绑定的装饰箭头也不报连接异常。无限画布没有隐含边界，负坐标合法。检测有明确预算，`complete=false` 时检查未完成；没有提示也不保证配色、拥挤程度、视觉层次或实际渲染效果正确。

`compact` 保留图元 ID、类型、位置、尺寸、文字、非零旋转、折线点与箭头绑定目标，省略装饰样式；坐标字段仍为 `width/height`，不引入缩写。`compact/input` 视图按绑定标签 ID 筛选会返回其本体；文字搜索和类型筛选针对合并后的对象。需要可写描述请显式选择 `input` 并检查省略警告。

`input.elements` 保持严格可写：独立文字的派生高度不混入写入描述。新增同页只读 `elementGeometry:[{elementId,height,lineHeight,lineHeightPx,lineCount}]` 提供修复布局需要的高度和行高，按 `elementId` 与独立文字对应，参与 `maxChars` 预算、筛选和分页；批读 `view=input` 同样提供。直接把 `elements` 传入 `updates` 即可，勿把 `elementGeometry` 字段合并进去；文字高度仍由内容重算，手工设置会报错。

`measure_text` 现返回原生 `lineHeight` 倍率和 `lineHeightPx`，行数继续使用已有 `lineCount`，不增加重复的 `lines` 别名。估宽按中日韩宽字符、全角形式及组合 emoji 约 1em、拉丁及半角字符约 0.58em 计算，组合附加符号不重复计宽；常用模糊宽度标点在整行有中日韩语境时按 1em 估算，西文语境保留窄估算。此规则复用于创建与布局，仍属于估算，无法替代实际字体排版。

单次工具业务失败现在同时标记 `isError:true` 和 `structuredContent.ok:false`，保留 `error.code/message` 与错误 text；参数校验也可仅有 `isError` 和 text。批处理执行完成时，某些或全部条目失败仍通过条目 `ok/error` 和汇总数量表达，不把正常执行的聚合调用标为顶层异常。

复制优先使用 `copy_elements`，例如 `{"boardId":"来源画板","elementIds":["start","decision","edge"],"dx":300,"dy":0}`。省略 `targetBoardId` 为同板复制，`dx/dy` 默认各为 20；跨板复制时传目标 ID，重叠原位置可设 `dx=dy=0`。形状及标签自动生成新 ID，选中标签会复制其所属形状；选择集内部箭头自动重连，外部绑定默认解绑，只有同板可设 `externalBindings=preserve` 保留。始终返回 `idMap`（含标签）和 `warnings`；省略原生元数据会给出警告，所选图元不能投影则整次拒绝。`expectedRevision` 校验目标修订号，`sourceExpectedRevision` 可校验来源修订号。

`get_board.view=input` 的 `elements` 也可直接作为 `update_board.updates`，或取一个作为 `update_element.update`；`type` 仅核对已有图元类型，不能转换类型。相对移动传 `{"id":"start","dx":100,"dy":20}`，绑定标签和箭头随节点联动；不能在同轴同时传 `dx/x` 或 `dy/y`，也不能把相对位移与折线坐标混用。

单个修改的完整参数是 `{"boardId":"画板ID","update":{"id":"start","dx":100}}`；批量是 `{"boardId":"画板ID","updates":[{"id":"start","dx":100}]}`。两者复用同一修改对象，不提供顶层字段别名；误把 `id/dx` 等放在 `update_element` 顶层时会给出嵌套示例。`update_board` 可以在一次原子保存中同时传 `elements` 新增和 `updates` 修改，顺序为删除→新增→修改；只在 `updates` 传一个不存在的 ID 会失败，新增 ID 放在 `elements` 后可在同次 `updates` 中修改。

`update_element` 成功及无变化回执返回最终 `x/y/width/height`；形状仍有绑定文字时另回 `label:{id,x,y,width,height}`，这些是本次保存的实际几何，不必再读取确认落点。移动/复制/批量新增或修改还会返回非阻断的 `ELEMENT_OVERLAP` 提示（在 `warnings` 内，包含 `elementId/otherElementId/overlapRatio`），不会自动挪位置。检查使用旋转后的轴对齐外接框，较小框重叠比例至少 80%，且覆盖较大框至少 35%；明显面积差的完全包含按容器启发式略过，箭头、直线、绑定文字不单独检测，原有同程度重叠不反复告警。这是近似布局提示，可能误报或漏报。

重叠检查有容量上限：场景 5 万图元、变更 1000 个 ID、空间索引 20 万引用、候选访问 2 万次、提示最多 20 条。`overlapCheck.complete=false` 时 `limitations` 说明截断原因，空警告不表示已验证没有重叠。仅样式更新不建立空间索引；复制的投影警告仍与重叠提示一起保留。

图元读取视图（不含 `summary`）回传 `elementCount`（含绑定标签的原生总数）、`viewElementCount`（当前视图在筛选前的总数）、`matchedCount`（筛选后匹配数）与 `returnedElementCount`（本页实际返回数）。例如原生 5 个图元中含两个绑定标签，`compact` 全读的四个数字是 5、3、3、3；分页只返回一个时最后一个数字为 1。`full/elements` 保留标签为独立图元，因此其视图总数会不同。

跨板复制使用 `get_board.view=input` 或批读的 `input` 视图：返回的 `elements` 严格符合写入 schema，可交给 `create_board` 或其他画板的 `add_elements`。形状标签折叠为 `text/labelId/labelStyle`，保留标签 ID 和独立样式。图元视图（compact/elements/input/full）的 `truncated/nextOffset` 表示分页或字符预算截断；summary 只返回元数据；仅 input 返回的 `unsupportedElementIds/warnings` 表示不可写图元或属性被省略，与分页无关。图片、自由画笔及分组、框架等不能通过这个视图完整复制；跳过图元时警告说明原因，省略不代表空画板，原始内容未删除。向同一画板追加已有 ID 会报冲突，原地修改应使用 `update_element` 或 `update_board.updates`。所有视图的折线点均相对于图元 `x/y`，返回的 `pointCoordinateSystem` 为 `relative`。`rotation` 单位为度，input 输出舍入至 10 位小数，文字 `x/y` 是左上角。绑定的 `fixedPoint` 允许越出 `[0,1]`，遵循原生绑定归一化范围，支持回读回写。

绘图回执在 `responseMode=ids` 时返回 `requestedElementIds`（输入图元本体）、`generatedElementIds`（自动生成的绑定文字）和 `elementMap`（按 `inputIndex` 对应本体及 `labelId`），不再提供混合两种角色的 `elementIds` 回执；读取筛选和移除操作的 `elementIds` 入参仍表示待操作的图元。MCP 画板输入和结果统一使用 `boardId`，不提供 `id` 别名，包括列表、单读、批读、创建及管理结果；图元和文件夹各自的 `id` 不变。画板元数据统一为 `elementCount/folderId/folderName/createdAt/updatedAt/lastOpenedAt/deletedAt`；文件夹使用 `boardCount/createdAt/updatedAt`，不透传对应数据库命名字段。省略内部缩略图哈希和存储大小。批读的 `partial` 表示成功与失败混合，`truncated` 仅表示内容或字符预算截断；画板不存在不会触发 `truncated`，无需续读。

图元和嵌套对象严格拒绝未知字段，`strokeColour`、`fillStyles`、`zIndex` 等错误不会写库。颜色接受十六进制、`transparent` 和全部 148 个标准 CSS 命名色（包括 `rebeccapurple`）；`opacity` 为 0–100 百分比，可带小数；`rotation` 以度为单位；`roundness` 支持像素半径或圆角对象；文字可指定 `fontSize/fontFamily/textAlign`。读取或修改已有场景时保留图片及自由画笔图元，但不提供图片上传、自由画笔生成、原始场景覆盖、备份、永久删除或清空回收站工具。

形状及其绑定文字的标签在创建、追加、原地修改时统一最多 2000 字符，直接按绑定文字 ID 修改也遵守此限制；独立文字最多 10000 字符。超限更新返回明确错误，保持原内容和修订号不变。文件夹和图元共用颜色规则，客户端 schema 与服务端均接受大小写并规范为小写，支持 `#RGB/#RGBA/#RRGGBB/#RRGGBBAA`、标准 CSS 命名色和 `transparent`。批量管理的必填参数错误会定位到 `items.0.expectedRevision/action` 等具体字段。

修改形状标签样式可传 `update_element.update.labelStyle`，或通过 `update_board.updates` 一次修改多个标签；只合并传入的标签字段，不改形状样式，不需要删除重建。标签字体字段同时出现于顶层和 `labelStyle` 时，嵌套值优先。已有 `labelId` 只用于核对稳定身份，传不同 ID 明确报错；给无标签形状新增文字时可同时指定 `text/labelId/labelStyle`。绑定标签跟随容器旋转，不支持独立于容器的旋转。

绑定标签的文字颜色使用 `strokeColor`，创建时默认继承形状颜色。如果把形状的 `strokeColor` 和 `backgroundColor` 设成相同颜色来隐藏边框，文字也可能与底色同色而不可见；应显式设置对比色，例如浅色胶囊节点使用 `labelStyle:{"strokeColor":"#1f2937"}`，深色底则选择浅色文字。

独立 `text` 图元可传 `width` 固定文字框宽度并自动换行，例如 `{"type":"text","x":100,"y":100,"text":"这是一段需要自动换行的文字","width":160,"fontSize":20}`。省略 `width` 时按内容自动计算宽度；`height` 始终按换行后的内容与字号计算，不传 `height`。更新内容或字号会保留固定宽度并重新换行；`update_element.update` 或 `update_board.updates` 中传 `autoResize:true` 可恢复自动宽度（不能同时传 `width`）。`get_board.view=input` 保留独立文字的固定宽度，可直接用于跨画板复制。形状绑定标签的宽度由所属形状决定，需要调整时修改形状 `width`。

创建或移动时 `folderId` 与 `folderName` 二选一，`folderId=null` 表示根目录，`folderName` 自动获取或创建文件夹；已有文件夹不修改外观，同名歧义报错。`create_board/update_board.tags` 表示完整标签列表，增删标签使用 `manage_board`。不修改内容地打开画板、保存或返回主页不再产生内容修订；恢复未保存草稿和真实编辑仍正常保存。

文件夹名称去除首尾空白后按大小写敏感的精确名称匹配；新建或改名不允许重复，并发 `ensure_folder` 也只创建一条记录。历史重名文件夹保留，按名称操作返回歧义错误，需指定 ID。相同画板元数据的 `noop` 同时保持 `revision` 和 `updated_at`，包括 HTTP API 的同内容更新。

软删除和还原的实际状态变化也递增 `revision` 并更新 `updated_at`；重复相同状态返回 `noop`，不递增。删除后还原会使旧的 `expectedRevision` 失效，调用方应使用最新回执版本。`list_tags.nextCursor` 是按标签名排序的边界，SQL 读取名称大于该边界的标签，不要求该标签仍存在；分页不是一致快照，期间改名或新增可能影响后续页，完整重新核对时从第一页读取。

业务结果的完整机器数据仅在 `structuredContent`，成功文本 `content` 为按工具生成的极简中文摘要，不重复业务 JSON、图元或列表正文。通常一至两行，最长 1024 字符；单画板操作附 `boardId`，新建或幂等返回已有画板时再附完整直达链接。摘要显示实际数量、无变化、分页或截断、批量成功与失败、检查未完成等状态；文字测量明确标为估算。超长名称优先缩短，直达链接不会被截断成不可用 URL，无法容纳时提示按 `boardId` 定位。客户端仍应读取结构化结果并检查 `ok/error.code`，也须处理 SDK 参数校验产生的 `isError=true` 和文本错误，这类错误可能没有 `structuredContent`，客户端本地校验也可能在发请求前拒绝。业务错误的文本保留具体原因。绘图写入默认 `responseMode=minimal`，返回修订号、数量和画板 URL，无需再次读取全文确认成功；`copy_elements` 始终额外返回 `idMap/warnings`。`create_board/add_elements/update_board/create_diagram/copy_elements` 在 `responseMode=ids` 时对新增图元使用同一套 `elementMap` 回执；`addedCount` 是实际创建的本体加绑定文字的数量，`requestedElementIds.length` 是本体数量，`elementCount` 是全画板当前图元数量。

`remove_elements` 和 `update_board` 的删除反馈包含 `notFoundIds`（去重后的缺失请求 ID）、`removedCount`（含绑定文字的实际删除总数）、`requestedRemovedCount`（显式请求且存在的图元数）、`cascadeRemovedCount`（未显式请求的级联删除数）及 `elementCount`（操作后的全板图元数）。缺失 ID 不使整次操作失败，仍返回缺失清单；只删除不存在的 ID 时返回 `noop`，不递增修订号。删除标签 ID 只删除标签，删除形状才联动删除其标签。

批量读取及管理的每项结果都有 `ok:true/false`，仍使用顶层 `partial/truncated` 表示混合结果及截断。`list_boards.view=recent` 只包含打开过的画板，默认按 `lastOpenedAt` 倒序；`view=all,sort=opened` 才包含从未打开的画板并把它们排最后。`create_diagram` 默认生成 `diagram_edge_<从0起序号>` 的边 ID，与用户节点 ID 冲突时会添加后缀；使用 `responseMode=ids` 获取准确的 `elementMap` 后可通过 `update_element` 改箭头样式。

常规阅读使用 `compact`，`full` 仅用于调试或小批量检查原生内部字段。`maxChars` 限制业务结果的字符预算，不是整个 HTTP 报文大小。当前画板图元作为单行 JSON 存储，图元分页、筛选和投影仍需读取整个画板，字符预算不限制数据库读取与解析成本；只需画板概要时使用 `summary`，它不读取图元 JSON。

REST `/api/scenes` 写入使用原生 Excalidraw 元素，MCP 使用简化绘图描述，两种格式不能互换。同一画板可以通过两条通道编辑，但应读取最新版本并使用修订号保护；禁止用 MCP 的可写投影覆盖 REST 原生场景，否则会丢失投影未包含的图片和内部属性。MCP 的增量修改保留这些原有内容。服务初始化的 instructions 会显示实际回收站保留天数；默认 30 天，`TRASH_RETENTION_DAYS=0` 时明确告知自动清理已禁用。

增量修改可传读取时的 `expectedRevision`；省略时服务端读取最新版本并用乐观锁保存。画板写入沿用现有的校验、冲突保护和实时通知，已打开且没有未保存本地修改的画板会自动刷新。发生 `REVISION_CONFLICT` 时重新读取并判断如何合并，不要盲目重试；业务错误返回 `ok=false`，不会标记为工具异常。

工具定义使用 JSON Schema `$defs` 复用公共字段，三种形状共享相同字段结构，仍严格检查每种图元允许的属性。客户端可能再次展开引用，实际模型上下文大小取决于客户端实现。重复批量校验错误按字段与原因聚合，保留前三个具体位置、错误处数，最多展示八类，不回显完整 schema；常见错误提供有界修正提示，如 `strokeColour` 应改为 `strokeColor`、独立文字高度自动计算、`angle` 应使用以度为单位的 `rotation`。实际校验仍检查全部输入。`update_board` 中纯图元修改没有任何实际变化时直接返回 `noop`，不再序列化完整画板并发起保存；仅改元数据应优先使用 `manage_board`。

需要排查写入延迟时临时设置 `MCP_TRACE=true`，Compose 已转发该变量。`[MCP timing]` 记录 `apiReadMs/apiWriteMs`（内部 API 调用全过程，包含路由校验、序列化及存储）、`transformMs`（图元生成、更新或投影）、`responseBuildMs`（业务回执构建）、`handlerMs` 和 `apiReads/apiWrites`。这些不是纯 SQLite 执行时间；也不包含模型生成、客户端校验、外部网络、令牌鉴权或 SDK 响应传输。计时默认关闭，无常驻历史缓存，不记录参数、正文或令牌。常见绘图工具按工具名记录，管理操作记录为 `management` 类别。

运行固定性能基准：

```bash
bun scripts/benchmark-mcp.ts
```

脚本通过真实 MCP SDK、路由和临时 SQLite，比较读取视图、工具定义与回执字符数；创建 100 张卡片、追加 100 张卡片、修改 20 个图元、无变化修改、修订冲突及 8 节点时间线各执行 30 次，输出 P50/P95，结束后清理临时数据库和附件。基准隔离写入频控；属于本机进程内测量，不代表 VPS 反代、多人并发或模型思考耗时，不设容易波动的绝对耗时门禁。

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
    { "type": "arrow",
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
