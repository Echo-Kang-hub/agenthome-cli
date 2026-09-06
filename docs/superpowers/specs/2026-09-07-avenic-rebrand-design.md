# Avenic 品牌迁移设计（2026-09-07）

## 1. 背景与目标

Avenic 仓库（单一 GitHub 仓库，内含 core / cli / vscode 三个 package）从 AgentHome 完整重塑为 Avenic 品牌。目标：

- 统一品牌，公开名称不残留 AgentHome / agenthome / agenthome-cli / agent-skills 等历史命名；
- 不长期背负旧 CLI 兼容层（无真实外部用户，仅维护者本人使用）；
- 已有用户数据零丢失：旧持久化文件采用兼容读取 + 自动迁移；
- 生态名称（`.agents/`、agent id 等）不动，不做机械替换；
- 已确认的架构不变（见 §6）。

## 2. 术语约定

- 不使用 "monorepo" 表述：称 **Avenic 仓库**、repository、或"单仓库多 package 结构"。
- CLI 与 VS Code Extension 是**同一仓库里的两个客户端 package**，不描述成两个仓库。
- core = 唯一业务逻辑层（公开 npm 包 `@avenic/core`）。

## 3. 目标命名与验证状态（2026-09-07 实测）

| 名称 | 目标值 | 验证结果 |
|---|---|---|
| GitHub 仓库 | `Echo-Kang-hub/avenic` | user `avenic` 被他人占用（2022 休眠账号），但不影响自己账号下的 repo 名 ✅ |
| CLI npm 包 | `avenic` | `npm view avenic` → E404 ✅ 可用 |
| CLI 命令 | `avenic`（别名 `ave`） | 2026-09-07 实测：npm `ave` 是 2015 年死库（URL router，0.0.1-0，非 CLI）；本机 bash/Windows PATH 无 `ave`；PowerShell 无 `ave` 别名/命令；无已知主流 CLI 用 `ave` ✅ |
| core 包 | `@avenic/core` | E404 ✅ 可用；`@avenic` org 端点 HTTP 200 → **org 已存在**（用户已创建）✅ |
| VS Code 扩展 | `Avenic`，ID `<publisher>.avenic` | Marketplace API 无法可靠查询 publisher 可用性 ⚠️ 需用户人工确认 |

**发布前 gate**：实施完成、npm publish 之前重新执行 `npm view avenic` / `npm view @avenic/core` 复验（名字随时可能被抢注）。scope 是否可用以 `npm org ls avenic`（已登录状态下）为准，若实施时发现 org 状态异常，列为"需用户在 npm 网页人工确认/创建"的步骤，不假设 scope 会自动创建。

## 4. 名称三分类

- **A 类（必改）**：公开品牌名称——包名、bin、env、UI 文案、命令/view ID、文档。
- **B 类（改 + 兼容迁移）**：持久化数据路径/文件——先读旧名、自动迁移到新名。
- **C 类（不动）**：生态目录（`.agents/`、`.claude/skills/`）、agent id、无品牌含义的名称。

## 5. 完整映射表

### A 类：必改

| 旧 | 新 | 说明 |
|---|---|---|
| 根 package.json name `agenthome-cli-monorepo` | `avenic-repo` | 内部名，非公开 API，见 §7 |
| 根 bin `agenthome` / `ah` | `avenic` / `ave` | GitHub 根安装模式入口 |
| 根 version `5.7.7` | `1.0.0` | |
| 根 `repository.url` | `git+https://github.com/Echo-Kang-hub/avenic.git` | |
| packages/cli name `agenthome-cli` + bin | `avenic` + bin `avenic` / `ave` | `ah` 废弃 |
| packages/cli version | `1.0.0` | |
| 元数据 `agentHome.packageSpec` | `avenic.packageSpec: "avenic@latest"` | 自更新源 |
| 自更新 fallback `Echo-Kang-hub/agenthome-cli#main` | `Echo-Kang-hub/avenic#main` | GitHub rename 先行（§9）保证地址存在 |
| packages/core name `@agenthome-cli/core` | `@avenic/core`，version `1.0.0` | 从未发布 |
| env `AGENTHOME_STATE_DIR` | `AVENIC_STATE_DIR` | 旧名仅兼容读（§8） |
| env `AGENTHOME_CATALOG_SPEC` | `AVENIC_CATALOG_SPEC` | 旧名仅兼容读（§8） |
| 全局状态目录 `~/.config/agent-skills/` | `~/.config/avenic/` | 一次性迁移（§8） |
| 项目文件 `.agent-skills.json` | `.avenic.json` | 兼容读 + 写时迁移（§8） |
| 项目锁 `.agent-skills.lock.json` | `.avenic.lock.json` | 兼容读 + 写时迁移（§8） |
| 默认 catalog spec 常量 `Echo-Kang-hub/agenthome-catalog#main` | `Echo-Kang-hub/avenic-catalog#main` | 已确认（catalog 仓库随主仓库一并 rename） |
| tmp 锁目录 `agenthome-launch-*` | `avenic-launch-*` | 临时目录，硬切 |
| 函数 `updateAgentHome` / `agentHomePackageSpec` | `updateAvenic` / `avenicPackageSpec` | |
| UI 文案 AgentHome（help/status/doctor/错误信息/watchdog 与 adapter 注释） | Avenic | |
| 测试与 integration：env 名、bin 断言 `agenthome.cmd`/`ah.cmd`、`/shorthand: ah/` | `avenic.cmd`/`ave.cmd`、`/shorthand: ave/` | |
| VS Code 命令 `agenthome.agents.*`、视图 `agenthome.agents` | `avenic.agents.*` / `avenic.agents` | 扩展 ID `<publisher>.avenic`，publisher 待定 |
| 文档 README×2、development.md、VS Code spec | Avenic 化 | 历史归档 spec/plan 保留原样 |
| GitHub 仓库名 `agenthome-cli` | `avenic` | 用户执行 rename（§9） |

catalog 默认 spec 常量的说明：代码中 `DEFAULT_CATALOG_SPEC`（`packages/core/src/skills/catalog.mjs:11`）换成 `Echo-Kang-hub/avenic-catalog#main`（catalog 仓库已确认 rename）。已存在用户锁中的旧 URL **不动**（GitHub redirect 保证有效，刷新后自然换新）。

### C 类：不动

- `.agents/` 全部子路径（`runtime.json`、`sessions/`、`local/`、`tmp/`、`direct/`、`licenses/`、`skills/`）——跨 Agent 生态目录，codex/opencode/universal 的 skills 读取目标；
- `~/.agents/skills`、`.claude/skills`、`~/.claude/skills`——同上；
- agent id `claude` / `codex` / `opencode`、`AGENTS` 表、`getAgent`；
- `.agent-skills-profile`——仅保留**读取**（历史遗留迁移源），不新写、不更名；
- LICENSE 版权行（Echo Kang）、gitignore `# Agent Runtime` 注释——无品牌词。

## 6. 架构不变项

- core = 唯一业务逻辑层；CLI 与 VS Code Extension 为平行客户端；
- VS Code Extension 不 shell CLI；core 独立公开 npm 发布；CLI 可独立使用；
- VS Code：TypeScript + esbuild + TreeView + Webview Dashboard；
- 已下沉 core 的业务逻辑方案继续保留。

## 7. 根 package.json 名称决策：`avenic-repo`

根 manifest 的真实职责：GitHub 根安装模式（`npm i -g Echo-Kang-hub/avenic`）的直接安装物——bin 指向 `packages/cli/scripts/skills.mjs`，`files: ["packages/", "README.md"]`，`private: true` 永不进 registry。同时受 pacote 约束守护（无 workspaces、无 install 生命周期脚本）。

命名选择 `avenic-repo`（已确认）的理由：

- 不叫 `avenic`：避免与正式 CLI npm 包同名（node_modules 身份混淆）；
- 不含 "monorepo" 字样；
- "repo" 精确表达"仓库根安装物"这一内部身份。

**它不是公开品牌，也不是 package API**——仅出现在根 manifest 与 GitHub 根安装模式的安装目录名里。

## 8. 数据兼容与迁移机制

1. **项目文件**（`.avenic.json` / `.avenic.lock.json`）：解析时新名优先；新名缺失且旧名存在 → 读旧名数据，**下次任何写入时**原子 rename 到新名。零数据丢失，旧名自动消失。
2. **全局状态目录**：`stateRoot` 指向 `~/.config/avenic/`；新目录不存在且旧 `~/.config/agent-skills/` 存在 → 首次运行整目录 rename（同盘原子）；rename 失败 → 降级继续读旧目录，不丢数据。
3. **env**：`AVENIC_*` 优先；旧 `AGENTHOME_*` 命中时回退读 + stderr deprecation 提示。回退读长期保留（成本≈0，防老脚本/老 CI 断裂）。
4. **catalog 锁**：用户项目锁中的旧 catalog URL 不动，GitHub redirect 保证继续有效。
5. **测试守护**：新增迁移测试——旧布局 fixture（旧文件名 + 旧全局目录 + 数据）→ 运行新命令 → 断言新名存在、数据完整、旧名已迁移。

## 9. npm/GitHub 操作与安全发布顺序

GitHub 官方文档确认：仓库 rename 后旧 URL 的 clone/fetch/push **永久继续有效**（前提：不在旧名下新建仓库）。因此旧版 `agenthome-cli` 自更新 fallback `Echo-Kang-hub/agenthome-cli#main` 在 rename 后仍可用，且 redirect 到的新仓库已改名——GitHub 根安装模式的旧用户自更新即完成升级。

顺序（rename 先行，保证 `Echo-Kang-hub/avenic#main` 在发布前已存在；标注 🤖=Agent 自动执行，👤=USER CHECKPOINT）：

1. 代码迁移完成 + `npm test` / `npm run test:install` / `npm run pack:cli` 全绿（🤖）；
2. **GitHub 仓库 rename**（🤖，gh CLI 权限不足时 👤）：`agenthome-cli` → `avenic`；**catalog 仓库 rename** `agenthome-catalog` → `avenic-catalog`；
3. 更新本地 remote（🤖）：`git remote set-url origin https://github.com/Echo-Kang-hub/avenic.git`；验证新 URL fetch/push 正常、旧 URL clone/`ls-remote` 仍可用（redirect 生效）；
4. 复验 npm 名称与 `@avenic` org 权限（🤖，§3 发布前 gate）；
5. 发布 `@avenic/core@1.0.0`（🤖；浏览器 2FA → 👤 认证后继续）；
6. 发布 `avenic@1.0.0`（🤖；2FA 同上）；
7. 验证新包（🤖）：`npm i -g avenic`（registry 模式）+ `npm i -g Echo-Kang-hub/avenic`（GitHub 根模式）→ `avenic doctor` / `avenic skills status` / `ave --version` 正常；
8. `npm deprecate agenthome-cli "Renamed to avenic: npm i -g avenic"`（🤖）。

注意：旧名 `agenthome-cli`、`agenthome-catalog` **永不复用**（复用会使 redirect 失效）。

## 9.1 自动化与 USER CHECKPOINT 原则

- **Agent 自动执行**一切 CLI 可完成的操作：改代码/测试/manifest/文档/CI、运行全部测试、git diff 审查、commit、push、gh rename（主仓库与 catalog 仓库）、更新 remote、验证 redirect、npm 名称复验、npm publish、npm deprecate、发布后 `npm view` / 临时安装验证。
- **USER CHECKPOINT 仅限**真正无法自动化的环节：npm 浏览器 2FA 认证、GitHub 网页授权、gh/npm 凭据权限不足、Marketplace publisher 创建。
- 遇到阻塞时：停在具体阻塞点，只告知用户必须人工完成的最少操作；用户完成后从原位置继续，不让用户重复执行 Agent 已完成的步骤。

## 10. VS Code spec 更新要点

架构零改动、全量改名：依赖 `@agenthome/core` → `@avenic/core`；命令/view ID 前缀 `agenthome` → `avenic`；AgentHome 文案 → Avenic；扩展名 Avenic、ID `<publisher>.avenic`。**publisher ID 为 deferred decision**——延后到 VS Code Extension 发布阶段确定，不阻塞本次 rebrand。M2 按更新后的 spec 执行。

## 11. Breaking changes 与决策状态

**Breaking**：npm 包名、bin 名（`ah` 废弃）、env 主名、项目文件名（有兼容读）、全局状态目录（自动迁移）、默认 catalog spec 常量、版本 5.7.7 → 1.0.0。

**决策状态（全部落定，无阻塞项）**：

- CLI 简写 `ave`（已实测低风险，替代存在冲突风险的 `av`）；
- 私有 catalog 仓库 rename 为 `avenic-catalog`（已确认）；
- 根 package.json 内部名 `avenic-repo`（已确认）；
- VS Code Marketplace publisher ID——deferred decision，延后到扩展发布阶段，不阻塞本次 rebrand。

## 12. 明确不做

- 不机械替换生态名称（C 类）；
- 历史归档 spec/plan 不改（保留原始内容）；
- 计划阶段：不修改业务代码、不 npm publish、不 rename GitHub 仓库、不提交 commit。

实施从迁移计划（writing-plans 产物）经用户确认后开始。
