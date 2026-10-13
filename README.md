# 狐涂画板（Bun + Cloudflare Workers）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![Bun Version](https://img.shields.io/badge/Bun-1.4%2B-black?logo=bun)](https://bun.sh) [![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/)

一个使用 **Bun 1.4+** 构建、部署在 **Cloudflare Workers** 的虚拟手绘风格白板。D1 保存画板和应用数据，R2 保存图片附件，Durable Objects 提供实时变更通知。支持多画板管理、30s 防抖自动保存、HttpOnly 密码保护和 MCP 接入。

---

## ⚖️ 与原版 Excalidraw 的核心区别与优化

| 对比维度 | 官方 / 社区原版 Excalidraw | 本项目（狐涂画板，Bun + Cloudflare） |
| :-- | :-- | :-- |
| **运行时与架构** | Node.js + Yarn，微服务或多容器配置 | **Bun 工具链 + Cloudflare Workers**，用 D1 保存画板数据，R2 保存附件 |
| **数据持久化** | 仅保存在浏览器 localStorage（易丢失）或需付费订阅官方云端 | **Cloudflare D1** 保存画板、文件索引与会话数据，支持摘要列、索引与 keyset 分页 |
| **多画板管理** | 单画板模式，需手动导出/导入 `.excalidraw` 文件 | **内置画板工作台**：列表/网格浏览、搜索、新建、重命名、文件夹分类、回收站与 URL 直达 |
| **图元统计** | 无图元数量感知 | **内置图元数量统计**：保存时维护去 JSON 扫描的 `element_count` / `content_bytes` 摘要列并在卡片展示 |
| **静态附件与缓存** | 外部 S3/第三方存储依赖，缺少协商缓存 | **Cloudflare R2 独立存储 + SHA-256 ETag / 304 + 分批垃圾回收** |
| **数据隐私与遥测** | 包含 Google Analytics、Sentry 遥测、Google Fonts 与官方外链 | **无第三方外链打点**：业务数据存储在部署者配置的 Cloudflare D1/R2 资源，霞鹜文楷与思源黑体使用版本化 CDN |
| **中文字体支持** | 默认依赖外部在线 Google Fonts 或英文字体 | **通过 jsDelivr 加载「霞鹜文楷」与「思源黑体」CJK 字体**（Unicode 子集化拆分按需加载） |
| **身份认证安全** | 无或 Token 明文保存在浏览器本地存储 | **轻量密码保护 + HttpOnly 服务端 Session Cookie**，绝不暴露明文凭据 |
| **浏览器与构建** | 包含大量旧版浏览器兼容层与 Webpack/Vite 复杂配置 | **原生 Bun HTML Bundler（现代浏览器目标）**，零 Vite/Rollup/Webpack，极速秒级打包，Mermaid/CodeMirror/字体按需加载 |
| **多端同步** | 依赖手动刷新或高频轮询 | **Durable Objects WebSocket 广播 + 自动重连 + revision 条件拉取** |
| **前端现代体验** | 传统弹窗布局与全局媒体查询 | **原生 `<dialog>` 无障碍模型（`aria-modal`） + CSS `@container` 容器查询与 `:has()` 现代选择器** |
| **代码工程质量** | 多套分散的编译器依赖 | **TypeScript 6.0+ 全 Monorepo 统一驱动** |
| **全栈开发体验** | 需分别启动前端开发服务与后端 API，跨端口代理 | **`bun run dev` 一体化本地开发**，由 Wrangler 提供 Worker、D1、R2 和 Durable Objects |

---

## ✨ 核心特性详解

### 1. 🚀 Bun 构建与 Cloudflare Workers 运行

- Bun 用于 Monorepo 依赖管理、前端打包、开发和测试；生产 API 与静态资源运行于 Cloudflare Workers。
- Wrangler 本地环境提供与生产一致的 D1、R2 和 Durable Objects 接口。

### 2. 💾 D1 画板持久化与 R2 附件归档

- **画板保存**：画板正文、应用状态和元数据存储在 Cloudflare D1；单画板请求体默认限制为 1,900,000 字节，以适配 D1 单行大小限制。
- **查询优化**：画板摘要列避免列表页扫描 `elements` JSON；有效画板、回收站、文件夹场景分别使用索引，列表支持 keyset 分页。
- **自动防抖同步**：画布修改后防抖约 30 秒自动同步至云端，并使用 `revision` 乐观锁机制防止并发快照覆盖。
- **纯净持久化与防膨胀**：前后端协同在持久化保存前自动过滤剔除已擦除/删除（`isDeleted`）图元，杜绝反复绘图擦除后场景 JSON 无节制膨胀。
- **多端实时同步**：同源 `/api/realtime` 使用 Durable Objects WebSocket；服务端只广播场景 ID、revision 和变更类型，客户端收到后按 ETag/revision 拉取内容。
- **离开保护**：离开画板或返回工作台主页时，前端会主动等待队列保存完毕再跳转。
- **附件独立存储**：图片和媒体文件存储于 Cloudflare R2，D1 保存文件元数据与 SHA-256 哈希。
- **附件生命周期**：上传、替换与回收遵循版本一致性，读接口支持 SHA-256 ETag 和 `304 Not Modified`。

### 3. 🗂️ 完善的多画板与工作台系统

- **画板管理**：工作台支持网格与列表视图切换、实时搜索、画板重命名、一键复制画板。
- **图元数量统计**：画板卡片直观显示 `🎨 10 个图元 • 更新于 今天 17:30`，方便掌握画板内容规模。
- **文件夹与分类**：支持创建文件夹、归类画板与收藏常用画板。
- **回收站与生命周期保护**：支持画板软删除至回收站、一键还原与彻底清空；支持可配置的超期自动清理机制（默认 30 天 TTL），超期自动物理删除并级联触发孤立附件 GC。
- **URL 直达与设备接力**：支持 `?id=xxx` 自动识别与加载指定画板，局域网多设备无缝接力。

### 4. 🧼 极致纯净私有化 (Privacy First)

- 彻底剔除所有外部跟踪分析打点代码与 Sentry 上报；字体不直连 Google Fonts，霞鹜文楷与思源黑体使用版本化 jsDelivr CDN，默认 Excalifont 保持本地。
- 业务数据由部署者 Cloudflare 账号中的 Worker、D1 和 R2 处理；字体 CDN、Mermaid 或外部嵌入属于明确的静态资源依赖。

### 5. ⚡ 现代浏览器性能基线

- 生产构建面向现代浏览器（支持最新 Chrome、Edge、Firefox、Safari、iOS Safari），去除过时 polyfill。Bun 1.4 使用 `target: "browser"` 表达该目标。
- **按需动态加载**：Mermaid 图表引擎、CodeMirror 代码编辑器与 CJK「霞鹜文楷」「思源黑体」（通过版本化 CDN 样式表）、pako 压缩回退均延迟至使用时加载；默认 Excalifont 保留本地，首屏极速秒开。
- **原生压缩流**：优先使用现代浏览器原生 `CompressionStream` 与 `DecompressionStream`。

### 6. 🔐 企业级轻量鉴权与安全响应头

- 通过环境变量 `AUTH_PASSWORD` 开启密码保护。
- Worker 签发安全 `HttpOnly` 会话 Cookie，会话记录持久化于 D1，浏览器端不存放明文凭证。
- 设置 `MCP_TOKEN` 后可通过 MCP Streamable HTTP 接入 Agent，列出/读取/新建画板，并添加或移除 Excalidraw 图元。
- 服务端注入严格的 **Content Security Policy (CSP)**，禁止 `unsafe-inline` 和 `unsafe-eval` 脚本执行。

### 7. 📦 Cloudflare 数据保护

- D1 数据可通过 Cloudflare D1 Time Travel 恢复；Time Travel 不会回滚 R2 对象。R2 对象备份需要由部署方另行配置，本项目不提供一键完整归档或 R2 备份。

---

## 🚀 Cloudflare 部署与本地开发

### 部署前准备

- 安装 Bun 1.4.3+，并准备已启用 Workers、D1 和 R2 的 Cloudflare 账号。
- 安装依赖并登录 Wrangler：

```bash
bun install
bunx wrangler login
```

- `wrangler.jsonc` 只声明代码使用的绑定名 `DB` 和 `ASSETS_BUCKET`，不写入 D1 的数据库名/ID 或 R2 bucket 名。Cloudflare Workers Builds 首次部署时会在账号内自动创建并绑定资源；具体资源名称和标识只保存在 Cloudflare 账号，不回写 GitHub 仓库。[Wrangler 自动创建资源](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)
- 配置进入画板的登录密码和 MCP 访问令牌。两个变量用途不同：

| 变量 | 用途 | 必需性 |
| --- | --- | --- |
| `AUTH_PASSWORD` | 网页登录密码；设置后画板 API 需要登录 | 生产必需，除非明确启用匿名访问 |
| `MCP_TOKEN` | MCP URL 的访问令牌，不是网页登录密码 | 只在启用 MCP 时设置 |

本地 Wrangler 开发使用仓库根目录的 `.dev.vars`。复制示例文件并替换为自己的值；不启用 MCP 时可以删去 `MCP_TOKEN` 行：

```powershell
Copy-Item .dev.vars.example .dev.vars
```

`.dev.vars` 示例内容：

```dotenv
AUTH_PASSWORD="replace-with-a-local-login-password"
MCP_TOKEN="replace-with-a-local-mcp-token"
```

之后运行 `bun run dev` 或 `bun run cf:dev`。`.dev.vars` 只供本地 Wrangler 使用并已加入 Git 忽略规则；不要把密钥写进前端变量或提交到仓库。

生产密钥在 Cloudflare Dashboard 的 Worker **Settings → Variables and Secrets** 中添加为 Secret：`AUTH_PASSWORD` 必需，`MCP_TOKEN` 仅在启用 MCP 时需要。不要将这些值放进 GitHub Actions secrets、`wrangler.jsonc` 或前端构建变量。

### 首次部署与更新

在 Cloudflare Dashboard 进入 **Workers & Pages → Create application → Connect to Git**，选择本仓库并设置：

- 构建命令：`bun install --frozen-lockfile && bun run build:frontend`
- 部署命令：`bunx wrangler deploy`
- 根目录：仓库根目录（包含 `wrangler.jsonc`）
- Build Variables：`BUN_VERSION=1.4.3`（Cloudflare Builds 当前默认 Bun 版本低于项目要求）

首次部署后，Cloudflare 会创建 D1 和 R2 资源并在 Worker 设置中显示绑定。打开 **D1 → 对应数据库 → Console**，执行 [`migrations-d1/0001_baseline.sql`](migrations-d1/0001_baseline.sql) 的 SQL，完成首次 schema 初始化。后续 migration 也在本地验证后，通过对应 D1 Console 执行；GitHub Actions 只做质量检查，不发布。请只从 Cloudflare Dashboard 的 Git Builds 部署，避免本地 `wrangler deploy` 把自动生成的账号资源 ID 写回工作区。

画板登录密码和 MCP token 则在部署后的 Worker **Settings → Variables and Secrets** 中作为 Secret 配置。推送到 Cloudflare Builds 选定的分支后，Cloudflare 会构建和部署 Worker；生产变量和资源绑定由 Cloudflare 账号管理。

### 本地开发

```bash
bun run cf:db:migrate:local
bun run dev
```

`bun run dev` 由 Wrangler 启动本地 Worker、D1、R2 和 Durable Objects，并监听前端源码变化；启动前请按上文配置 `.dev.vars`。也可以单独运行 `bun run cf:dev` 调试 Worker。构建与 Worker dry-run 检查：

```bash
bun run build
```

本地运行数据位于 Wrangler 的 `.wrangler/state` 目录，不会导入旧 SQLite 数据。项目只支持从空 D1 开始的新部署。

### 数据保护边界

画板、应用状态和元数据存储在 D1，附件存储在 R2。Cloudflare D1 Time Travel 可用于 D1 数据恢复，但不会恢复、删除或回滚 R2 对象；本项目不提供应用内完整备份或 R2 备份。需要恢复附件时，部署方必须使用自己配置的 R2 备份方案，并保证 D1 与 R2 的恢复点一致。

---
## 🤖 MCP：让 Agent 读取和绘制画板

MCP 使用标准 Streamable HTTP 传输，生产端点为 `https://<your-worker-domain>/mcp/<URL 编码后的令牌>`；本地 Wrangler 地址默认为 `http://127.0.0.1:8787`。设置高强度随机令牌：

本地测试 MCP 时，将令牌写到 `.dev.vars` 的 `MCP_TOKEN` 项，见上文配置示例。生产环境在 Cloudflare Dashboard 的 Worker **Settings → Variables and Secrets** 中将 `MCP_TOKEN` 添加为 Secret；Worker 部署由 Cloudflare Git Builds 触发。

在支持远程 HTTP MCP 的 Agent 客户端中添加服务：

```json
{
  "mcpServers": {
    "excalidrawsqlite": {
      "type": "http",
      "url": "https://<your-worker-domain>/mcp/replace-with-a-long-random-secret"
    }
  }
}
```

MCP 入口通过路径令牌鉴权；令牌使用 `encodeURIComponent` 编码后放在 `/mcp/` 后面。远程连接使用 HTTPS，并避免在访问日志中记录令牌路径。

Cloudflare 部署时，先按部署章节在 Worker 设置中保存 `MCP_TOKEN` Secret。MCP 客户端地址为 `https://<your-worker-domain>/mcp/<URL 编码后的令牌>`；无需登录网页，也无需 `Authorization` 请求头。生产连接必须使用 HTTPS，并避免在访问日志中记录令牌路径。
网关、WAF 或 OpenResty 的 User-Agent 过滤规则也需放行整个 `/mcp/` 路径，包括 Python SDK 的默认 UA；保留真实 User-Agent，不要靠伪装 curl 解决。若 `initialize` 等带 JSON-RPC `id` 的请求收到 `202` 空响应，应使用同一请求比较不同 UA 的公网响应与本地 Wrangler 响应，并检查各层拦截日志；不能把它当作初始化成功。协议通知（例如 `notifications/initialized`）没有 `id`，正常接受时可以返回 `202` 空响应。需要拒绝时返回明确的 `4xx`，不要用空 `202` 隐藏拦截。本仓库没有线上网关配置，应用更新不会自动解除网关规则。
工具按“尽量一次完成”安排：

| 工具 | 用途 |
| --- | --- |
| `list_boards` | 名称搜索及文件夹、收藏、精确标签筛选；`view=all/recent/trash`，收藏统一使用 `favorite=true/false`（省略不限），支持排序和 `nextCursor` 分页；不存在的文件夹 ID 明确报错。 |
| `get_board` | 默认 `compact` 只读文字、几何与连接，标签折入本体；`elements` 含样式，`summary` 元数据，`full` 内部字段，`input` 可写字段。按 `elementIds`、文字 `query`、`type` 定位，支持 `limit/offset/maxChars`，返回 `nextOffset/truncated`。 |
| `get_boards_batch` | 一次读取最多 20 块画板，共享字符预算，逐条返回错误或分页信息；与单读一样 `maxChars` 最少 1000，连必要元数据也放不下则明确报错；不是跨画板一致快照。 |
| `create_board` | 一次创建并绘制，可同时设置背景、收藏、标签和 `folderId/folderName`；允许同名，省略图元创建空板。 |
| `create_diagram` | 传入节点标题、正文和连接，自动绘制横向或纵向时间线、流程图；支持分支、循环与主题，可同时设置文件夹、标签和收藏。 |
| `update_board` | 一次合并删除、新增、`updates` 原地修改和画板元数据，原子保存一个修订；顺序为删除→新增→原地修改。 |
| `update_element` | 传 `update.id` 与待修改字段，保留图元 ID、连接和其余字段，改颜色无需回传完整 JSON。 |
| `add_elements` / `remove_elements` | 单纯追加或按 ID 移除图元；普通绘图无需先创建空板再调用追加。 |
| `copy_elements` | 按 ID 同板或跨板复制，自动生成新 ID、平移并重连内部箭头；返回旧 ID 到新 ID 的 `idMap`。 |
| `list_folders` / `list_tags` | 分页读取文件夹、标签及画板计数。 |
| `ensure_folder` / `create_folder` | 按精确名称幂等获取或创建，或明确创建新文件夹；同名歧义要求使用 ID。 |
| `update_folder` / `delete_folder` | 修改名称、图标、颜色；删除仅把画板移至根目录，`dryRun=true` 预览，执行需 `confirm=true`，可校验 `expectedBoardCount`。 |
| `manage_board` | 一次合并改名、收藏、移动与标签操作；`tags` 必须与 `tagMode=replace/add/remove` 同传，相同元数据返回 `noop`。 |
| `delete_board` / `restore_board` | 仅软删除或还原，没有永久删除参数；回收站受 `TRASH_RETENTION_DAYS` 保留期限约束。 |
| `batch_manage_boards` | 最多 100 项 `manage/delete/restore`，每项必传 `expectedRevision`；独立执行，返回逐项结果、`noop` 和 `partial`。 |

每次最多传入 1,000 个图元描述，接受矩形、椭圆、菱形、文字、直线和箭头。形状的 `text` 自动生成绑定文字，回执的 `addedCount` 包含这些文字；需要 ID 时传 `responseMode=ids`，按本体与自动文字分别返回。可指定稳定 `id`，新建箭头只传 `startBinding/endBinding.elementId` 即自动连接同批或已有节点，无需计算端点；自连接或同中心节点须显式传坐标。移动/缩放节点时保留连接；`points` 是绝对画布坐标，支持多段折线，不与二点坐标字段混用。删除形状同时删除绑定文字并清理引用。

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

`compact` 保留图元 ID、类型、位置、尺寸、文字、非零旋转、折线点与箭头绑定目标，省略装饰样式；坐标字段仍为 `width/height`，不引入缩写。`compact/input` 视图按绑定标签 ID 筛选会返回其本体；文字搜索和类型筛选针对合并后的对象。需要可写描述请显式选择 `input` 并检查省略警告。

复制优先使用 `copy_elements`，例如 `{"boardId":"来源画板","elementIds":["start","decision","edge"],"dx":300,"dy":0}`。省略 `targetBoardId` 为同板复制，`dx/dy` 默认各为 20；跨板复制时传目标 ID，重叠原位置可设 `dx=dy=0`。形状及标签自动生成新 ID，选中标签会复制其所属形状；选择集内部箭头自动重连，外部绑定默认解绑，只有同板可设 `externalBindings=preserve` 保留。始终返回 `idMap`（含标签）和 `warnings`；省略原生元数据会给出警告，所选图元不能投影则整次拒绝。`expectedRevision` 校验目标修订号，`sourceExpectedRevision` 可校验来源修订号。

`get_board.view=input` 的 `elements` 也可直接作为 `update_board.updates`，或取一个作为 `update_element.update`；`type` 仅核对已有图元类型，不能转换类型。相对移动传 `{"id":"start","dx":100,"dy":20}`，绑定标签和箭头随节点联动；不能在同轴同时传 `dx/x` 或 `dy/y`，也不能把相对位移与折线坐标混用。

单个修改的完整参数是 `{"boardId":"画板ID","update":{"id":"start","dx":100}}`；批量是 `{"boardId":"画板ID","updates":[{"id":"start","dx":100}]}`。两者复用同一修改对象，不提供顶层字段别名；误把 `id/dx` 等放在 `update_element` 顶层时会给出嵌套示例。`update_board` 可以在一次原子保存中同时传 `elements` 新增和 `updates` 修改，顺序为删除→新增→修改；只在 `updates` 传一个不存在的 ID 会失败，新增 ID 放在 `elements` 后可在同次 `updates` 中修改。

`update_element` 成功及无变化回执返回最终 `x/y/width/height`；形状仍有绑定文字时另回 `label:{id,x,y,width,height}`，这些是本次保存的实际几何，不必再读取确认落点。移动/复制/批量新增或修改还会返回非阻断的 `ELEMENT_OVERLAP` 提示（在 `warnings` 内，包含 `elementId/otherElementId/overlapRatio`），不会自动挪位置。检查使用旋转后的轴对齐外接框，较小框重叠比例至少 80%，且覆盖较大框至少 35%；明显面积差的完全包含按容器启发式略过，箭头、直线、绑定文字不单独检测，原有同程度重叠不反复告警。这是近似布局提示，可能误报或漏报。

重叠检查有容量上限：场景 5 万图元、变更 1000 个 ID、空间索引 20 万引用、候选访问 2 万次、提示最多 20 条。`overlapCheck.complete=false` 时 `limitations` 说明截断原因，空警告不表示已验证没有重叠。仅样式更新不建立空间索引；复制的投影警告仍与重叠提示一起保留。

图元读取视图（不含 `summary`）回传 `elementCount`（含绑定标签的原生总数）、`viewElementCount`（当前视图在筛选前的总数）、`matchedCount`（筛选后匹配数）与 `returnedElementCount`（本页实际返回数）。例如原生 5 个图元中含两个绑定标签，`compact` 全读的四个数字是 5、3、3、3；分页只返回一个时最后一个数字为 1。`full/elements` 保留标签为独立图元，因此其视图总数会不同。

跨板复制使用 `get_board.view=input` 或批读的 `input` 视图：返回的 `elements` 严格符合写入 schema，可交给 `create_board` 或其他画板的 `add_elements`。形状标签折叠为 `text/labelId/labelStyle`，保留标签 ID 和独立样式。图元视图（compact/elements/input/full）的 `truncated/nextOffset` 表示分页或字符预算截断；summary 只返回元数据；仅 input 返回的 `unsupportedElementIds/warnings` 表示不可写图元或属性被省略，与分页无关。图片、自由画笔及分组、框架等不能通过这个视图完整复制；跳过图元时警告说明原因，省略不代表空画板，原始内容未删除。向同一画板追加已有 ID 会报冲突，原地修改应使用 `update_element` 或 `update_board.updates`。紧凑视图与 `input` 的折线点均为绝对坐标；`full` 为内部相对坐标，需加图元 `x/y`，返回的 `pointCoordinateSystem` 明确标注。`rotation` 单位为度，input 输出舍入至 10 位小数，文字 `x/y` 是左上角。绑定的 `fixedPoint` 允许越出 `[0,1]`，遵循原生绑定归一化范围，支持回读回写。

绘图回执在 `responseMode=ids` 时返回 `requestedElementIds`（输入图元本体）、`generatedElementIds`（自动生成的绑定文字）和 `elementMap`（按 `inputIndex` 对应本体及 `labelId`），不再提供混合两种角色的 `elementIds` 回执；读取筛选和移除操作的 `elementIds` 入参仍表示待操作的图元。MCP 画板输入和结果统一使用 `boardId`，不提供 `id` 别名，包括列表、单读、批读、创建及管理结果；图元和文件夹各自的 `id` 不变。画板元数据统一为 `elementCount/folderId/folderName/createdAt/updatedAt/lastOpenedAt/deletedAt`；文件夹使用 `boardCount/createdAt/updatedAt`，不透传对应数据库命名字段。省略内部缩略图哈希和存储大小。批读的 `partial` 表示成功与失败混合，`truncated` 仅表示内容或字符预算截断；画板不存在不会触发 `truncated`，无需续读。

图元和嵌套对象严格拒绝未知字段，`strokeColour`、`fillStyles`、`zIndex` 等错误不会写库。颜色接受十六进制、`transparent` 和全部 148 个标准 CSS 命名色（包括 `rebeccapurple`）；`opacity` 为 0–100 百分比，可带小数；`rotation` 以度为单位；`roundness` 支持像素半径或圆角对象；文字可指定 `fontSize/fontFamily/textAlign`。读取或修改已有场景时保留图片及自由画笔图元，但不提供图片上传、自由画笔生成、原始场景覆盖、备份、永久删除或清空回收站工具。

形状及其绑定文字的标签在创建、追加、原地修改时统一最多 2000 字符，直接按绑定文字 ID 修改也遵守此限制；独立文字最多 10000 字符。超限更新返回明确错误，保持原内容和修订号不变。文件夹和图元共用颜色规则，客户端 schema 与服务端均接受大小写并规范为小写，支持 `#RGB/#RGBA/#RRGGBB/#RRGGBBAA`、标准 CSS 命名色和 `transparent`。批量管理的必填参数错误会定位到 `items.0.expectedRevision/action` 等具体字段。

修改形状标签样式可传 `update_element.update.labelStyle`，或通过 `update_board.updates` 一次修改多个标签；只合并传入的标签字段，不改形状样式，不需要删除重建。标签字体字段同时出现于顶层和 `labelStyle` 时，嵌套值优先。已有 `labelId` 只用于核对稳定身份，传不同 ID 明确报错；给无标签形状新增文字时可同时指定 `text/labelId/labelStyle`。绑定标签跟随容器旋转，不支持独立于容器的旋转。

独立 `text` 图元可传 `width` 固定文字框宽度并自动换行，例如 `{"type":"text","x":100,"y":100,"text":"这是一段需要自动换行的文字","width":160,"fontSize":20}`。省略 `width` 时按内容自动计算宽度；`height` 始终按换行后的内容与字号计算，不传 `height`。更新内容或字号会保留固定宽度并重新换行；`update_element.update` 或 `update_board.updates` 中传 `autoResize:true` 可恢复自动宽度（不能同时传 `width`）。`get_board.view=input` 保留独立文字的固定宽度，可直接用于跨画板复制。形状绑定标签的宽度由所属形状决定，需要调整时修改形状 `width`。

创建或移动时 `folderId` 与 `folderName` 二选一，`folderId=null` 表示根目录，`folderName` 自动获取或创建文件夹；已有文件夹不修改外观，同名歧义报错。`create_board/update_board.tags` 表示完整标签列表，增删标签使用 `manage_board`。不修改内容地打开画板、保存或返回主页不再产生内容修订；恢复未保存草稿和真实编辑仍正常保存。

文件夹名称去除首尾空白后按大小写敏感的精确名称匹配；新建或改名不允许重复，并发 `ensure_folder` 也只创建一条记录。历史重名文件夹保留，按名称操作返回歧义错误，需指定 ID。相同画板元数据的 `noop` 同时保持 `revision` 和 `updated_at`，包括 HTTP API 的同内容更新。

软删除和还原的实际状态变化也递增 `revision` 并更新 `updated_at`；重复相同状态返回 `noop`，不递增。删除后还原会使旧的 `expectedRevision` 失效，调用方应使用最新回执版本。`list_tags.nextCursor` 是按标签名排序的边界，SQL 读取名称大于该边界的标签，不要求该标签仍存在；分页不是一致快照，期间改名或新增可能影响后续页，完整重新核对时从第一页读取。

业务结果的完整机器数据仅在 `structuredContent`，成功文本 `content` 给简短说明，不重复传输业务 JSON；客户端应读取结构化结果。客户端须检查 `ok/error.code`，也须处理 SDK 参数校验产生的 `isError=true` 和文本错误，这类错误可能没有 `structuredContent`，客户端本地校验也可能在发请求前拒绝。业务错误的文本保留具体原因。绘图写入默认 `responseMode=minimal`，返回修订号、数量和画板 URL，无需再次读取全文确认成功；`copy_elements` 始终额外返回 `idMap/warnings`。`create_board/add_elements/update_board/create_diagram/copy_elements` 在 `responseMode=ids` 时对新增图元使用同一套 `elementMap` 回执；`addedCount` 是实际创建的本体加绑定文字的数量，`requestedElementIds.length` 是本体数量，`elementCount` 是全画板当前图元数量。

`remove_elements` 和 `update_board` 的删除反馈包含 `notFoundIds`（去重后的缺失请求 ID）、`removedCount`（含绑定文字的实际删除总数）、`requestedRemovedCount`（显式请求且存在的图元数）、`cascadeRemovedCount`（未显式请求的级联删除数）及 `elementCount`（操作后的全板图元数）。缺失 ID 不使整次操作失败，仍返回缺失清单；只删除不存在的 ID 时返回 `noop`，不递增修订号。删除标签 ID 只删除标签，删除形状才联动删除其标签。

批量读取及管理的每项结果都有 `ok:true/false`，仍使用顶层 `partial/truncated` 表示混合结果及截断。`list_boards.view=recent` 只包含打开过的画板，默认按 `lastOpenedAt` 倒序；`view=all,sort=opened` 才包含从未打开的画板并把它们排最后。`create_diagram` 默认生成 `diagram_edge_<从0起序号>` 的边 ID，与用户节点 ID 冲突时会添加后缀；使用 `responseMode=ids` 获取准确的 `elementMap` 后可通过 `update_element` 改箭头样式。

常规阅读使用 `compact`，`full` 仅用于调试或小批量检查原生内部字段。`maxChars` 限制业务结果的字符预算，不是整个 HTTP 报文大小。当前画板图元作为单行 JSON 存储，图元分页、筛选和投影仍需读取整个画板，字符预算不限制数据库读取与解析成本；只需画板概要时使用 `summary`，它不读取图元 JSON。

REST `/api/scenes` 写入使用原生 Excalidraw 元素，MCP 使用简化绘图描述，两种格式不能互换。同一画板可以通过两条通道编辑，但应读取最新版本并使用修订号保护；禁止用 MCP 的可写投影覆盖 REST 原生场景，否则会丢失投影未包含的图片和内部属性。MCP 的增量修改保留这些原有内容。服务初始化的 instructions 会显示实际回收站保留天数；默认 30 天，`TRASH_RETENTION_DAYS=0` 时明确告知自动清理已禁用。

增量修改可传读取时的 `expectedRevision`；省略时服务端读取最新版本并用乐观锁保存。画板写入沿用现有的校验、冲突保护和实时通知，已打开且没有未保存本地修改的画板会自动刷新。发生 `REVISION_CONFLICT` 时重新读取并判断如何合并，不要盲目重试；业务错误返回 `ok=false`，不会标记为工具异常。

工具定义使用 JSON Schema `$defs` 复用公共字段，三种形状共享相同字段结构，仍严格检查每种图元允许的属性。客户端可能再次展开引用，实际模型上下文大小取决于客户端实现。重复批量校验错误按字段与原因聚合，保留前三个具体位置、错误处数，最多展示八类，不回显完整 schema；常见错误提供有界修正提示，如 `strokeColour` 应改为 `strokeColor`、独立文字高度自动计算、`angle` 应使用以度为单位的 `rotation`。实际校验仍检查全部输入。`update_board` 中纯图元修改没有任何实际变化时直接返回 `noop`，不再序列化完整画板并发起保存；仅改元数据应优先使用 `manage_board`。

需要排查写入延迟时，可在 Cloudflare Worker variables 中临时设置 `MCP_TRACE=true`。`[MCP timing]` 记录 `apiReadMs/apiWriteMs`（内部 API 调用全过程，包含路由校验、序列化及存储）、`transformMs`（图元生成、更新或投影）、`responseBuildMs`（业务回执构建）、`handlerMs` 和 `apiReads/apiWrites`。这些不是纯 D1 执行时间；也不包含模型生成、客户端校验、外部网络、令牌鉴权或 SDK 响应传输。计时默认关闭，无常驻历史缓存，不记录参数、正文或令牌。常见绘图工具按工具名记录，管理操作记录为 `management` 类别。

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
│   ├── server.ts           # Bun SQLite 测试服务与兼容性辅助入口，不用于生产部署
│   ├── db.ts               # 异步 D1 接口与 Cloudflare D1 适配器
│   ├── bun-database.ts     # 测试专用 Bun SQLite 适配器
│   ├── mcp.ts              # MCP Streamable HTTP 工具与认证入口
│   ├── routes.ts           # 异步 D1 API 路由，静态资源转交 Workers Assets
│   ├── config.ts           # 环境变量、服务配置与限制常量
│   ├── types.ts            # 后端共享类型
│   ├── errors.ts           # HTTP 错误类型
│   ├── http.ts             # 请求体、响应、安全头与 CORS/CSP
│   ├── validation.ts       # 请求参数与资源 ID 校验
│   ├── auth.ts             # 密码会话、Cookie 与限流
│   ├── database.ts         # 测试专用 SQLite schema 初始化
│   ├── runtime.ts          # 测试专用 Bun SQLite runtime
│   ├── scenes.ts           # 画板、文件夹与场景数据处理
│   ├── files.ts            # 附件、缩略图与存储一致性维护
│   ├── cloudflare-runtime.ts # Worker binding 注入与 D1 runtime
│   ├── cloudflare-realtime.ts # Durable Object WebSocket 与广播
│   ├── files.ts            # R2 附件流、D1 元数据和生命周期维护
│   └── ...                  # 持久化、备份、并发与安全模块
├── scripts/
│   ├── build-frontend.ts   # 纯原生 Bun HTML Bundler 打包引擎
│   ├── dev-cloudflare.ts   # Wrangler Worker 与前端构建监听开发入口
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
│   └── server/              # Bun SQLite/API 回归测试
├── docs/                   # GitHub Pages 介绍落地页 (单文件、现代化动效与手绘 SVG)
├── worker/                 # Cloudflare Workers 入口与运行时适配
├── migrations-d1/           # Cloudflare D1 数据库迁移
├── wrangler.jsonc           # Worker、静态资源与 Cloudflare bindings 配置
├── public/_headers          # Workers Static Assets 安全响应头
└── bun.lock                # Bun 统一依赖锁文件
```

### 后端模块职责

生产环境由 Cloudflare Worker 提供 API，D1 保存画板数据，R2 保存附件；本地通过 Wrangler 模拟 Worker 与 Cloudflare bindings。Bun SQLite 适配器仅供测试使用。

Worker 入口负责注入 D1、R2、Durable Objects、静态资源与 `waitUntil`，业务处理继续使用原生 `Request`/`Response`。D1 结构通过 `migrations-d1/` 管理；项目不提供旧 SQLite 数据导入。

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
| `GET` | `/api/realtime` | Durable Object WebSocket；按 `scene_id` 订阅轻量场景/工作区变更事件 |
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
| `PUT` | `/api/files/:id` | 流式上传图片附件到 R2，D1 原子更新对象指针并计算 SHA-256 哈希 |
| `GET` | `/api/files/:id` | 读取图片附件内容（支持 `ETag` 与 `If-None-Match` 协商缓存，秒级 `304 Not Modified`） |
| `GET` | `/api/health` | D1 连通性健康检查 |

---

## 💾 数据持久化与备份恢复

画板、应用状态和元数据存储在 D1，附件存储在 R2。D1 Time Travel 可恢复 D1 数据，但不会回滚 R2 对象。本项目不提供应用内完整备份或 R2 备份；部署方需自行配置 R2 备份，并确保恢复时 D1 与 R2 数据相互匹配。

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
