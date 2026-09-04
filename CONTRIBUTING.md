# Contributing to Excalidraw (Bun + SQLite)

感谢你关注并参与本项目！本项目是基于 **Bun 1.4+** 与 **原生 SQLite** 驱动的纯净、自托管虚拟手绘风格白板，已彻底脱离 Node.js、Vite、Vitest 与 Yarn。

为保证代码质量与项目演进的一致性，请在贡献代码前阅读本指南。

---

## 🛠️ 环境准备与技术栈

- **运行时环境**：必须安装 [Bun](https://bun.sh/) (>= 1.4.1)；
- **包管理器**：统一使用 `bun install`（维护根目录 `bun.lock`），严禁引入 `package-lock.json` 或 `yarn.lock`；
- **前端构建引擎**：纯原生 **Bun HTML Bundler**（配合 Dart Sass 插件直接以 `excalidraw-app/index.html` 为入口进行打包）；
- **后端持久化**：Bun 原生 `bun:sqlite` 与原生 Web 标准 `Request`/`Response` 路由，无第三方 HTTP 框架。

---

## 🚀 本地开发流程

1. **克隆仓库并安装依赖**：
   ```bash
   git clone https://github.com/biaobiaobiao108/excalidrawsqlite.git
   cd excalidrawsqlite
   bun install
   ```

2. **一键启动全栈开发服务**：
   ```bash
   bun run dev
   ```
   - 自动自举初始编译并拉起全栈 HTTP 服务（默认端口 `8080`）；
   - 内置防抖观察器，监视 `excalidraw-app`、`packages` 与 `public` 源码变动；
   - 源码变更时毫秒级增量重新编译，并通过原生 SSE 通道（`GET /__dev_reload`）通知浏览器无感热刷新。

---

## 🧪 质量验证与分级测试规范

提交 Pull Request 或执行代码修改前，请严格按照修改类型执行**分级验证**：

1. **纯文档与注释改动 (免测)**：
   - 范围：`*.md`、`*.mdx`、`docs/`、代码注释；
   - 规则：直接执行 Git 提交，**严禁运行全量测试或构建命令**。

2. **后端与持久化改动 (极速验证)**：
   - 范围：`server/`、数据库迁移逻辑、API 路由；
   - 运行快速测试（耗时 < 1.5s）：
     ```bash
     bun run test:server
     ```

3. **前端局部功能与模块改动 (局部验证)**：
   - 范围：`packages/` 或 `excalidraw-app/` 内局部组件与业务逻辑；
   - 优先运行直接相关的测试或类型检查：
     ```bash
     bun test
     # 或
     bun run test:unit
     # 类型检查可作为补充
     bun run test:typecheck
     ```

4. **全量与发布级验证 (核心改动时执行)**：
   - 范围：修改了 `package.json`、核心打包配置 `scripts/build-frontend.ts`、跨模块接口等；
   - 运行全量流水线：
     ```bash
     bun run test:all
     ```

5. **代码风格与规范检查**：
   ```bash
   bun run test:code
   # 自动修复
   bun run fix
   ```

---

## 📝 提交规范 (Git Commit Convention)

- 遵循 **Conventional Commits** 格式：
  - `feat: ...` 新功能
  - `fix: ...` 缺陷修复
  - `docs: ...` 文档与注释修改
  - `refactor: ...` 代码重构
  - `perf: ...` 性能优化
  - `test: ...` 测试用例新增或调整
  - `chore: ...` 构建或辅助工具配置更新
- **原子提交要求**：每次完成独立功能或修改后立即提交，保持 Git 历史清晰可追溯。

---

## 🤖 AI 智能体协助指南

如果你使用 AI 智能体（如 GitHub Copilot、Antigravity 等）协助开发，请确保智能体遵循 [`AGENTS.md`](./AGENTS.md) 中的核心原则与 CSP 安全规范。
