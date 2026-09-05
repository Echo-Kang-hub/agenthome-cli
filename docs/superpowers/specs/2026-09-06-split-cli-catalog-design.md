# AgentHome 拆分设计：公开 CLI + 私有 Skills Catalog

- 日期：2026-09-06
- 状态：已确认（4 节设计逐节经用户确认）
- 实现计划：`docs/superpowers/plans/2026-09-06-split-cli-catalog.md`

## 1. 背景与目标

现状（v5.4.0）：单仓库 `Echo-Kang-hub/agenthome`（已 private）混装 CLI 运行时与 157 个 vendored Skills；分发依赖 GitHub 简写 `npm install -g Echo-Kang-hub/agenthome`；npm 上 `agenthome` 名被占用；本机未执行 npm login。

目标：

1. **公开轻量 CLI**（npm 包 `agenthome-cli`，新 public 仓库）——管理 Skills（双源：私有 catalog + 直接公开源；项目/全局作用域）+ 管理 Agent 运行时（认证作用域、便携会话）。
2. **私有 catalog**（`agenthome-catalog`，由现有仓库改名）——完整 skills/packs/sources.lock，含 Anthropic 受限 Skills，只供授权机器访问。
3. core / CLI / 未来 VS Code 扩展三层架构；CLI 与 catalog 独立升级；跨设备可复现安装。

## 2. 已确认决策

| 决策点 | 选择 |
|---|---|
| 仓库拓扑 | 双仓库 monorepo：现有仓库私有化为 catalog（改名 `agenthome-catalog`）；新建 public `agenthome-cli`（npm workspaces，全新 git 历史，只含 CLI 代码） |
| npm 包名 | `agenthome-cli`（unscoped）。发布动作留给用户（需先 npm login） |
| project auth 桥接 | 本次仅拆仓。保持现有 `throw not implemented` 行为；架构预留 adapter 接口，桥接作为后续独立增量 |
| catalog 传输 | git 拉取 + 全局缓存 + 项目锁固定 commit；认证完全委托 git/gh（HTTPS+credential helper 或 SSH），CLI 不处理 token |
| Skills 双源 | catalog 源（默认）+ 直接公开源（`agent skills add <owner/repo> [skill...]`）；安装作用域默认项目、`-g` 全局，两者可混用 |
| core 提取 | 机械迁移 + 边界清理（同进程调用、统一封装），**不改变行为**；现有 18 项测试作为回归守护 |
| catalog 维护命令 | 随 core 进 CLI 包；catalog 仓库保持纯数据 + CI（CI 安装 CLI 后运行维护命令） |
| bin 名称 | 六件套不变：`agent`、`agenthome`、`agent-skills`、`ac`、`ax`、`ao` |

## 3. 架构

### 3.1 仓库布局

```text
public:  agenthome-cli (全新历史, npm workspaces)
├─ packages/core     ← 纯逻辑库：零 CLI/console 耦合
│  └─ src/  runtime/ (config·gitignore·project-root·process·sessions·agents·adapters)
│           skills/  (catalog·sources·packs·install·vendor)
│           util/    (json·fs·ids)
├─ packages/cli      ← 唯一发布包（bin 六件套）
│  └─ src/  dispatcher.mjs（agent 运行时命令）
│           skills-cli.mjs（skills 命令，原 scripts/skills.mjs 拆分）
│           self-update.mjs
├─ packages/vscode   ← 仅 README 占位，本次不实现
├─ test/  integration/  docs/  README.md
└─ package.json      (private: true 保持，发布时由用户翻转)

private: agenthome-catalog (现有仓库改名, 已 private)
├─ skills/ packs/ sources.lock.json licenses/
├─ package.json      (name: agenthome-catalog, private: true; 迁移 shim bin)
├─ .github/workflows/auto-update-skills.yml（改用 CLI 跑维护命令）
└─ README.md
```

### 3.2 关键架构规则

1. **core 与 UI 解耦**：core 函数接受注入的 `io`（默认 `console`），返回结构化结果；打印全部留在 cli 层。现有输出文案逐字保持。将来 VS Code 扩展直接调用同一份 core。
2. **同进程调用**：`agent skills ...` 不再 spawn 子进程，`dispatcher` 直接调用 `skills-cli`（修复现有进程边界）。
3. **catalog 缓存**：`~/.config/agent-skills/catalog/<owner>-<repo>/`——clone 一次，按 commit 增量 fetch + detach checkout（复用现有 `cloneRevision` 模式）；`.tmp` 暂存目录移到缓存内。
4. **认证委托 git/gh**：HTTPS + credential helper 或 SSH key；CLI 零 token 处理；失败提示 `gh auth login` 等可操作信息。

### 3.3 数据流（安装）

```text
agent skills development research
  → 读项目锁(.agent-skills.lock.json) → catalog spec(URL+commit)
     无锁 → 默认 spec：Echo-Kang-hub/agenthome-catalog#main
             (可被 ~/.config/agent-skills/catalog.json 覆盖)
  → 确保缓存 (clone 或 fetch revision)
  → 读 sources.lock.json + packs/*.json → 解析 Pack → 安装到
     .claude/skills/ + .agents/skills/ → 写锁（含 catalog commit）
```

## 4. 数据模型与兼容

### 4.1 数据文件（全部向后兼容，零破坏）

| 文件 | 归属 | 变更 |
|---|---|---|
| `.agents/runtime.json` / `sessions/` / `local/` | 项目 | 完全不动 |
| `.agent-skills.json` | 项目 | 读 v2、写 v3：新增可选 `direct: []`（直接公开源安装记录），其余字段不变 |
| `.agent-skills.lock.json` | 项目 | 同 v3：`catalog` 对象记录 `{spec, repository, revision}`；新增 `directSources`；`sources`/`packs` 结构不变 |
| `~/.config/agent-skills/` | 机器 | `config.json`/`lock.json`（全局 scope，不变）+ 新增 `catalog/` 缓存 + `catalog.json`（默认 catalog spec 覆盖） |
| `~/.claude/skills/`、`~/.agents/skills/` | 机器 | 全局 scope 安装目标，不变 |

### 4.2 双源模型

1. **catalog 源（私有，默认）**：`agent skills <packs>` 从 `agenthome-catalog` 解析 Packs；项目锁固定 catalog commit，跨设备可复现。
2. **直接公开源**：`agent skills add <owner/repo> [skill...] [-g]`——直接拉公开仓库，锁 commit、存 license、写进 `direct`；可用 `uninstall-skill` 卸载。
3. **作用域**：默认项目（`.claude/skills/` + `.agents/skills/`，锁跟随项目）；`-g` 全局。默认行为不变。

### 4.3 迁移与旧安装过渡

- 现有仓库改名 `agenthome-catalog` 后，GitHub 会重定向旧 URL（`Echo-Kang-hub/agenthome` → `agenthome-catalog`）。
- 旧安装的 `agent update` 会拉到 catalog 包 → catalog 包内置**迁移 shim bin**：运行 `agent` 时打印迁移指引（`npm install -g Echo-Kang-hub/agenthome-cli#main`），优雅降级。
- 已装 Skills、`.agents/` 数据、会话全部原样保留——迁移不动任何项目文件。
- `skills-lock.json`（未跟踪、无代码引用）确认为外部工具产物，不进任何仓库，留在本机。

## 5. 命令面、错误处理、自更新

### 5.1 命令面（用户可见行为不变，内部重组）

Agent 运行时命令逐字不变：`agent claude|codex|opencode init/deinit/auth/sessions/status`、`ac/ax/ao` 简写、`agent status/doctor`、`agent sessions git on|off|status`。

Skills 现有 UX 逐字不变（实现改走 core + catalog 缓存）：`agent skills [pack...] [-g]`、`uninstall [pack...] [-g]`、`uninstall-skill <...> [-g]`、`tree/packs/status [-g]`。

新增：

```text
agent skills add <owner/repo> [skill...] [-g]   直接公开源安装（用户级新能力）
agent catalog sync                              确保缓存与默认 spec 一致
agent catalog use <spec>                        切换默认 catalog（写 ~/.config/...）
agent catalog add/remove/update/pack-add/pack-remove/source-add/doctor
                                                维护命令，仅在 catalog clone 内可运行
```

### 5.2 错误处理

- 沿用现有模式：命令抛错 → `Error: <message>` 到 stderr、exit 1；无部分写入（`replaceStagedFiles` 备份/回滚逻辑随 vendor 模块保留）。
- catalog 拉取认证失败输出可操作提示（`gh auth login` / SSH key / credential helper），不暴露任何凭据。

### 5.3 自更新

- 新 CLI：`agent update` → `npm install -g agenthome-cli@latest`（registry）；发布前临时指向 `Echo-Kang-hub/agenthome-cli#main`。
- 自更新源（`agentHome.packageSpec`）与 catalog 默认 spec 在代码中彻底分离（修复现有 `agentSkills.packageSpec` 字段双重含义）。

## 6. 测试、CI、npm 发布结构

### 6.1 测试（TDD）

- 迁移：现有 18 项测试原样搬入新仓库（runtime 测试改 import 到 `packages/core`），作为回归守护。
- 改造：skills 测试改用**本地 fixture catalog**（测试内用 git 建临时仓库充当 catalog，无网络依赖）。
- 新增（先写测试后实现）：catalog 缓存（clone→fetch revision→复用；锁固定 commit 可复现；认证失败提示）、`skills add` 直接公开源（本地 fixture 模拟）、v2→v3 锁迁移读取、`catalog use/sync`。

### 6.2 CI

- public agenthome-cli：`npm test` + `integration/global-install.mjs`（打包→全局安装→init→deinit→卸载）+ `npm pack --dry-run`。
- private agenthome-catalog：安装 CLI（发布前从 public 仓库装，pin commit）→ `agent catalog update` → doctor → 提交。每日调度保持。

### 6.3 npm 发布结构

- 唯一发布物：`packages/cli`（包名 `agenthome-cli`）。
- **core 同步拷贝（主方案）**：`packages/cli/vendor/core-src/` 是 `packages/core/src/` 的同步副本（**提交进 git**），cli 通过 package.json `imports`（`#core` → `./vendor/core-src/index.mjs`）引用；`sync-core` 脚本在 `pretest`/`prepack` 时刷新，并有测试守护新旧一致。原因：GitHub 简写安装安装的是仓库根 package，workspace 裸模块名解析在全局安装下不可靠；相对 vendor 路径在「GitHub 根安装」与「registry tarball 安装」两种模式下都成立。
- 仓库根 package.json（`agenthome-cli-monorepo`，private）持有同样六件套 bin 指向 `packages/cli/...`，支持发布前的 GitHub 安装；`files: ["packages/", "README.md"]`。
- `private: true` 保持到发布时翻转；发布前需 `npm login`（均为用户操作）。
- bin 六件套全保留。

## 7. 执行顺序（迁移 runbook）

1. **本地**：当前仓库写 spec/plan 并提交 → 脚手架新本地仓库 `D:\FileDownload\Projects\agenthome-cli`（git init）→ 机械迁移代码+测试（TDD 全绿）。
2. **远程（gh 已授权）**：当前仓库改名 `agenthome-catalog`；创建 public `agenthome-cli` 并 push。
3. **当前仓库改为 catalog 形态**：删除 CLI 代码（src/bin/scripts/test/integration），保留 skills/packs/sources.lock/licenses + 新 package.json（含迁移 shim）+ 更新 CI + README，push。
4. **本机验证**：`npm install -g Echo-Kang-hub/agenthome-cli#main` → `agent doctor` / `agent skills status` / 会话完好 / catalog 缓存自动建立。
5. **多机**：其他机器重装 CLI + `gh auth login`，按项目锁重建 Skills。

## 8. 约束

**不执行**：`npm publish`；删除任何 Codex/Claude/OpenCode 会话；删除认证数据；删除用户文件；修改全局 NVM link/shim 模式；随意修改系统 PATH；force push；删除远程仓库。

**已授权**：gh 改名当前仓库、创建 public 仓库、设置 remote、push、检查 GitHub 状态。

**npm publish 最后只给出准确命令，由用户自己执行。**

## 9. 范围外（后续增量）

- project auth 桥接实现（独立 spec→plan→TDD 循环）。
- VS Code 扩展（packages/vscode 仅占位）。
- npm 正式发布。
