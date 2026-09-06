# AgentHome VS Code 扩展设计

日期：2026-09-06
状态：已确认（修订 2：发布配置、esbuild 构建链、并发边界、VS Code 1.90+、架构不变量）
仓库：Echo-Kang-hub/agenthome-cli（monorepo，新增 `packages/vscode`）

## 1. 背景与目标

基于现有 AgentHome CLI 开发 VS Code 扩展，以图形界面管理编码 Agent（Claude Code / Codex / OpenCode）的运行时与 Skills。

硬约束：

- **CLI 必须继续独立可用**：扩展不依赖 CLI 二进制，CLI 用户零迁移。
- **不复制业务逻辑**：core 是唯一业务逻辑层；CLI 与扩展是平行的两个客户端。
- 扩展用户**不需要安装 CLI**（core 随扩展打包）。

## 2. 架构决策

方案 A（已选定）：公开发布 `@agenthome/core`，扩展以 npm 依赖复用 core。

```
        ┌───────────────  @agenthome/core（公开 npm，.mjs + .d.ts）
        │  import                  │ import
┌───────┴──────┐          ┌────────┴───────┐
│ packages/cli │          │ packages/vscode│   （esbuild 构建时把 core
│ vendor 打包  │          │ 依赖 npm 版本  │     bundle 进 dist/extension.js；
└──────────────┘          └────────────────┘      vsce 负责打包/发布 VSIX）
```

否决的备选：

- 子路径导出 `agenthome-cli/core`：把生成的 vendor 目录暴露为 API，扩展被 CLI 发布节奏绑架，类型声明无处安放。
- spawn `agenthome` 解析文本：解析脆弱、交互命令不可用、要求安装 CLI、每次操作开进程。

### 架构不变量（后续任何迭代不得违反）

- @agenthome/core = 唯一业务逻辑层
- CLI 与 VS Code 扩展 = 两个平行客户端
- CLI 继续 sync-core/vendor，不依赖扩展；扩展不 spawn agenthome CLI、不解析 CLI 文本
- CLI 中 Pack 安装/卸载、直装删除、catalog add 等编排逻辑下沉 core
- packages/vscode 使用 TypeScript
- TreeView 负责快速查看/操作；Webview Dashboard 负责高颜值 Overview
- 单工作区直接使用唯一 Workspace Folder；多工作区 QuickPick 选择，不使用活动文件判断
- services 层保持薄适配，不复制业务逻辑；UI 层不直接读写 AgentHome 状态文件，所有业务状态重新从 core 获取
- MVP 范围保持不变

## 3. core 改动清单

core 是现有业务逻辑层（~70 个导出）。以下改动全部行为保持，CLI 同步改为调用（68 个现有测试把关）。

### 3.1 发布化

`packages/core/package.json` 发布配置（在现有基础上补齐）：

- `private` 移除；`license: "MIT"`；`type: "module"`；`main: "src/index.mjs"`；`engines: { "node": ">=18.17" }`（与 CLI 一致）。
- `"exports": { ".": { "types": "./index.d.ts", "import": "./src/index.mjs", "default": "./src/index.mjs" } }`。
- 顶层 `"types": "./index.d.ts"`（兼容不读 exports 的旧工具链）；不设 `module` 字段（bundler 走 exports，无必要）。
- `files: ["src/", "index.d.ts", "LICENSE"]`；LICENSE 从仓库根复制进包（`packages/core/LICENSE`，当前不存在）。
- 独立 semver。
- 版本纪律写入 `docs/development.md`：core 变更 → bump core → publish（用户执行）→ CLI `sync-core` 照旧。

### 3.2 类型契约

手写 `index.d.ts`（与 `index.mjs` 同目录维护），声明全部导出与关键接口（`InstallContext`、`Pack`、`Source`、`CatalogInfo`、`AdapterResult` 等）。自动生成（JSDoc → d.ts）列为后续优化。

### 3.3 逻辑下沉（CLI 层编排语义 → core）

| 新增 core 函数 | 承载的语义 | CLI 改动 |
|---|---|---|
| `agentExecutableAvailable(agentId)` | 官方 CLI 可用性探测（--version） | `dispatcher.mjs` 的 `executableAvailable` 改用 |
| `skillsInstallationStatus(context)` | `skills status` 数据版（manifest Packs、各 target present/total） | `commandStatus` 改用 |
| `registerCatalog(spec, {io, environment})` | catalog add：spec 先保存、预览失败不致命，返回预览或 `previewFailed` | `commandCatalogAdd` 改用 |
| `resolveInstallSource(options)` | 项目锁 pin catalog commit；裸 `skills` 刷新绕过 pin | `skills-cli.mjs` 私有 `resolveCatalogSource`/`pinnedCatalogSpec` 删除 |
| `installPacks(context, packIds, {io, refresh})` | Pack 安装编排（resolve → installCopies → writeInstallMetadata），返回结构化结果 | `commandInstall` 改用 |
| `uninstallPacks(context, packIds, {io})` | Pack 卸载编排（common 不可卸/总是包含规则、保留 Pack 重装） | `commandUninstall` 改用 |
| `removeExternalSkills(context, names, {io})` | 直装删除编排（受管理 Skill 拒绝删除检查 → 移除直装记录 → 删除目录） | `commandUninstallSkill` 改用 |

下沉后 CLI 各 `command*` 只剩：参数解析 + 呈现（`printTree`/`console`）。直装添加（`addDirectSkills`）、catalog 列表/选择（`loadKnownCatalogs`/`setDefaultCatalogSpec`）、会话与认证（`initializeAgent`/`setLocalAuth`/`clearLocalAuth`/`getSessionAdapter`）等已是 core 结构化接口，零新增。

## 4. packages/vscode 结构

- TypeScript，构建链：**esbuild**（`format: esm`, `platform: node`, `external: ["vscode"]`）把 `src/extension.ts` 及全部运行时依赖（含 `@agenthome/core`）bundle 进 `dist/extension.js`；`tsc --noEmit` 单独做类型检查。`main: ./dist/extension.js`，`type: module`，`engines.vscode: ^1.90.0`（支持 VS Code 1.90+）。
- `@agenthome/core` 放 `devDependencies`（被 bundle 进产物，不再随包分发 node_modules）。
- vsce 只负责生成与发布 VSIX（`vsce package` / `vsce publish`），不承担依赖 bundle 职责。**用户不需要安装 AgentHome CLI 或 @agenthome/core**。

```
packages/vscode/
├── package.json          # main/type/contributes（views、commands、menus）
├── tsconfig.json
├── src/
│   ├── extension.ts      # activate/deactivate，注册视图与命令
│   ├── project.ts        # 项目根解析：单根直接用唯一 Workspace Folder；
│   │                     #   多根 QuickPick 选择（不用活动文件），workspaceState 记忆
│   ├── services/         # 类型化薄封装。铁律：不 import vscode，
│   │   ├── agents.ts     #   只收 (projectRoot, environment, io)，天然可单测
│   │   ├── skills.ts
│   │   └── catalog.ts
│   ├── views/            # TreeDataProvider ×3 + 视图模型纯函数
│   │   ├── agents-view.ts / catalog-view.ts / skills-view.ts
│   │   └── view-models.ts
│   ├── dashboard/        # Overview Webview
│   │   ├── overview.ts   # WebviewViewProvider + postMessage 协议
│   │   └── media/        # 本地 HTML/CSS/JS（CSP nonce，无远程内容）
│   └── ui/               # QuickPick 流程与命令注册
└── test/                 # services + project + 视图模型单测（node --test）
```

### 数据流（单向，无缓存）

```
VS Code 命令 / 树节点点击
  → service（注入项目根 + 作用域）
  → @agenthome/core 函数（唯一业务逻辑，直接读写文件系统）
  → 结构化数据 → 视图模型 → TreeView / Dashboard 渲染
```

- 长操作（catalog sync、clone 发现 Skills、Pack 安装）用 `vscode.window.withProgress` 包裹；core 的 `io` 参数接 progress 适配器（`{ log: msg => progress.report({message}) }`），进度输出与 CLI 终端同源。
- 变更后只刷新对应视图（重读 core），扩展不保存第二份状态。

## 5. UI 设计

目标：**高颜值、低信息密度、VS Code 原生体验**。

### 5.1 侧边栏容器 "AgentHome"（三个 TreeView，极简）

- **Agents 视图**：每 Agent 一行（名称 + 短状态如 `已初始化 · global`）；详情（认证/sessions 模式/CLI 可用性）进 **tooltip**；行内只放 1–2 个最高频 Codicon 图标按钮（未初始化时 init、已初始化时 doctor/刷新），其余操作进右键上下文菜单 + 命令面板。
- **Catalog 视图**：当前 catalog 名 + revision 一行；操作（add/select/sync/default）走标题栏图标 + 上下文菜单；已注册列表默认收起为展开节点。
- **Skills 视图**：两个作用域分组（项目 + 全局，各带路径标注），每组三块：已装 Packs、Catalog Packs（展开看 Skill 清单，含已装标记）、直装 Skills。安装/卸载/删除走 QuickPick 多选，不堆按钮。

### 5.2 Overview：Webview Dashboard

代替原生 Status 树，是 doctor 的图形化：

- 顶部：项目根、当前 catalog、锁定 revision 概览卡片。
- 三 Agent 状态卡：图标、认证/sessions 徽章、CLI 可用性、高频操作按钮（触发与树相同的命令）。
- Skills 健康面板：各 target 的 ✓/! 与 present/total。
- 底部：快捷入口（catalog sync、安装 Pack、doctor 刷新）。
- 技术：codicon + VS Code 主题变量（`--vscode-*`）自动跟随明暗主题；CSP nonce、无远程内容、用户数据（Skill 名等）转义后渲染；postMessage 类型化协议；数据拉取走 services。

### 5.3 QuickPick 流程

| 命令 | 流程 |
|---|---|
| `agenthome.agents.init` | 选 Agent（树节点触发则已知）→ 选 auth（global/project）→ 选 sessions（global/project）→ 执行 |
| `agenthome.agents.switchAuth` | 显示当前生效值，选 global / project / reset |
| `agenthome.agents.switchSessions` | 显示当前值，选 global / project |
| `agenthome.agents.sessionsImport/Writeback` | 确认后执行，显示会话数 |
| `agenthome.catalog.add` | InputBox（owner/repo、URL 或本地路径）→ 保存 + 预览 Pack 树（失败提示"已保存，可 sync 重试"） |
| `agenthome.catalog.select` | QuickPick 已注册列表（> 标记当前） |
| `agenthome.skills.installPacks` | 多选未装 Packs（带 description；无 catalog 时提示先 add） |
| `agenthome.skills.uninstallPacks` | 多选已装 Packs（common 不可选，与 CLI 语义一致） |
| `agenthome.skills.addDirect` | InputBox `owner/repo` → withProgress clone 发现 Skills → 多选（含"全部"）→ 安装 |
| `agenthome.skills.removeDirect` | 多选已装直装 Skills → 删除 |

所有命令同时在命令面板与树上下文菜单可用；Esc 取消静默无操作。

## 6. 错误处理

- core 的 Error message 面向用户可读 → 扩展统一 catch：`showErrorMessage(err.message)`；对应视图节点标错误图标，Dashboard 显示错误条；不做二次文案包装。
- git/网络错误按 core 语义呈现（如 catalog add 预览失败不致命）。
- 并发：服务层 mutation 串行化（进行中时相关命令禁用），避免同时写锁文件。

### 并发边界（MVP 限制）

- 扩展进程内串行化只防护扩展自身的并发，**无法阻止 VS Code 扩展与 agenthome CLI 两个进程同时修改同一项目状态/锁文件**；MVP 接受此限制。
- 真正的跨进程 mutation lock / 原子写入属于 core 层职责，列为后续 core 改进项（CLI 一并受益），MVP 不为此扩大范围。

## 7. 测试

| 层 | 测什么 | 工具 |
|---|---|---|
| core | 已有 68 测试；新增函数各自补测试 | node --test |
| vscode services + project | 真实 core + 临时目录；services 不 import vscode，直接可测 | node --test |
| 视图模型 | core 数据 → 树节点/仪表盘数据（纯函数） | node --test |
| 集成冒烟 | vscode-test 启动开发宿主跑关键命令 | 手动清单；自动 E2E 列 v1.1 |

根 package.json 加 `test:vscode`，CI 一并跑。

## 8. 发布

- Marketplace 公开：扩展名 `AgentHome`，extensionId 拟 `agenthome.agenthome`（依赖 publisher，见开放问题），categories `Other`；README 中文为主（与 CLI 一致）。
- 构建产物 `dist/extension.js` 已由 esbuild 含入全部依赖；`vsce package` 生成 VSIX、`vsce publish` 发布（均由用户执行，同 npm publish 约束）。
- CI（agenthome-cli 新增 workflow）：push 跑 `npm test` + `test:vscode` + 扩展构建；tag `vscode-v*` 触发打包。
- 版本线：core / cli / vscode 三条独立 semver。

## 9. 范围

### MVP（本 spec）

- 三 Agent 初始化/状态/认证切换/sessions 切换（含 sessions import·writeback 按钮）
- Skills Catalog add/select/list/default/sync
- Pack 安装/卸载（项目 + 全局双作用域）
- Skills 浏览（当前 catalog）/ 直装 / 删除
- Overview Webview Dashboard（doctor 图形化）

### 明确排除（v1.1 候选）

- catalog 维护命令 UI（skill-add/remove、pack-add/remove、source-add、update）
- 在 VS Code 终端一键启动 agent（复用 CLI 会话快照/看门狗）
- Webview SKILL.md 预览
- JSDoc 自动生成 d.ts
- 自动 E2E
- core 跨进程 mutation lock / 原子写入（见第 6 节并发边界）

## 10. 里程碑

1. **M1 core 下沉与发布化**：3.3 清单 + d.ts + 发布配置；CLI 测试保持全绿；core 首个公开版本发布。
2. **M2 扩展骨架**：工程搭建、activation、三个 TreeView + services + 单测。
3. **M3 全功能流**：全部 QuickPick 命令、双作用域 Skills 操作、错误处理。
4. **M4 Dashboard**：Overview Webview + 打磨（Codicon、tooltip、上下文菜单）。
5. **M5 打包与发布**：README、vsce、CI workflow、发布。

每个里程碑可独立交付；M1–M4 构成 MVP。

## 11. 开放问题

- Marketplace publisher ID（需 Azure DevOps 组织；CI 发布时创建或提供）。
- 扩展图标（无现成 logo，需设计或暂用默认）。
- 扩展 UI 文案语言：默认中文（与 CLI 一致），是否同步英文待定。
