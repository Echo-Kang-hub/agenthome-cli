# AgentHome CLI

一个命令行工具，统一管理编码 Agent 的**运行时**（Claude Code / Codex / OpenCode）与 **Skills**，支持 Windows、Ubuntu 和 macOS。

主命令是 `agenthome`，简写 `ah`——只有这两个单词，且不与任何 shell 内置命令或别名冲突。

## 功能

- **多 Agent 运行时管理**：同一项目内为 Claude Code、Codex、OpenCode 独立初始化、查看状态、卸载。
- **认证作用域可选**：`--auth global`（本机共享凭据，默认）或 `--auth project`（凭据与配置保存在项目 `.agents/local/`，自动 gitignore，每个项目可用不同账号）。
- **会话记录可选**：`--sessions project`（默认，便携会话存 `.agents/sessions/`，可随项目迁移、可开关 Git 同步）或 `--sessions global`（使用 Agent 的原生全局存储）。
- **Skills 双源**：
  - **Catalog**：Skills 组织成 Packs 批量安装；catalog 是任意 git 仓库（公开或私有），`agenthome catalog use` 一行切换；commit 锁定，跨设备可复现。
  - **直接源**：`agenthome skills add <owner/repo>` 从任意 GitHub 仓库（公开或私有）直接安装 Skill，许可证自动保存。
- **安装作用域可选**：默认安装到项目（`.claude/skills/` + `.agents/skills/`），`-g` 安装到全局用户目录。
- **认证完全委托 git**：CLI 不接触任何 token；私有仓库走 gh、SSH 或 credential helper。
- **可重复执行、可撤回**：`init` 幂等——结构已符合时不做任何修改，缺什么只补什么；每个操作都有对应的撤回命令（见下文）。
- **自更新**：`agenthome self-update` 从 npm 更新。

## 安装

要求 Node.js ≥ 18.17。

```bash
npm install -g agenthome-cli
```

安装后可用两个命令：`agenthome`（主）与 `ah`（简写）。AgentHome 只使用 npm 标准 `bin`，不修改 NVM、Node、npm 或 PATH。

卸载：`npm uninstall -g agenthome-cli`

## 快速开始

```bash
agenthome claude init                            # 初始化 Claude Code（默认全局认证 + 项目便携会话）
agenthome claude init --auth project             # 项目级认证（凭据随项目，不进 Git）
agenthome codex init --sessions global           # Codex 会话留在全局原生存储
agenthome claude sessions import                 # 把本机会话复制进项目便携存储
agenthome sessions git off                       # 会话不进 Git
agenthome catalog use <owner/repo>               # 指向你自己的 Skills catalog（任何 git 仓库）
agenthome skills                                 # 安装/同步默认 Pack（common）
agenthome skills add <owner/repo>                # 从任意 GitHub 仓库直接安装 Skills
```

## Agent 运行时

| Agent | 全写 | 简写 |
|---|---|---|
| Claude Code | `agenthome claude` | `ah claude` |
| Codex | `agenthome codex` | `ah codex` |
| OpenCode | `agenthome opencode` | `ah opencode` |

```bash
agenthome claude init [--auth global|project] [--sessions global|project]
agenthome claude status                          # 该 Agent 的配置与状态
agenthome status                                 # 三个 Agent 一览
agenthome doctor                                 # 环境自检
agenthome claude deinit                          # 卸载运行时；--purge 一并删除数据
agenthome claude                                 # 直接启动 Claude Code
```

`init` 输出会列出**实际创建/修改了什么**（`.agents/runtime.json`、`.agents/sessions/<agent>/`、`.agents/local/<agent>/`、`.gitignore`）以及使用方法；可以放心重复执行：结构已符合 → `Already up to date`，有缺失 → 只增量补齐。

### 认证作用域

- `global`（默认）：使用 Agent 在本机的全局凭据（如 `~/.claude`、`~/.codex`）。
- `project`：凭据与配置全部保存在项目 `.agents/local/<agent>/`（自动 gitignore）。同一个 Agent 在不同项目可以用不同账号，项目拷走即带走配置。

```bash
agenthome claude auth project        # 切换到项目认证
agenthome claude auth global         # 切回全局
agenthome claude auth reset          # 清除本项目覆盖，恢复默认
agenthome claude auth                # 查看当前生效的认证作用域
```

### 会话记录

- `project`（默认）：每次启动前恢复、结束后捕获，会话保存在 `.agents/sessions/<agent>/`，可跨设备迁移；`agenthome sessions git off` 可禁止提交。
- `global`：会话直接留在 Agent 的原生全局存储，AgentHome 不做拷贝。

```bash
agenthome codex sessions import      # 全局会话 → 项目便携存储（复制不删除）
agenthome codex sessions restore     # 便携存储 → 原生存储
agenthome codex sessions status
agenthome sessions git on|off|status # 便携会话的 Git 同步开关
```

> 项目会话可能包含提示词、源码、命令输出、路径与密钥，只在你信任的仓库提交会话。

## 撤回操作

每个操作都有对应的撤回方式：

| 操作 | 撤回 |
|---|---|
| `agenthome claude init` | `agenthome claude deinit`（加 `--purge` 连会话数据一起删） |
| `agenthome claude auth project` / `auth global` | `agenthome claude auth global` / `auth project`（切回），或 `auth reset`（恢复默认） |
| `agenthome claude sessions import` | 只复制不删除，原生会话不受影响；想清掉项目里的便携副本：`agenthome claude deinit --purge` 后重新 `init` |
| `agenthome sessions git off` | `agenthome sessions git on` |
| `agenthome skills` / `agenthome skills <pack>` | `agenthome skills uninstall`（全部）或 `agenthome skills uninstall <pack>` |
| `agenthome skills add <owner/repo>` | `agenthome skills uninstall-skill <skill...>` |
| `agenthome catalog use <spec>` | 再执行一次 `agenthome catalog use <原 spec>` 换回 |
| `agenthome self-update` | `npm install -g agenthome-cli@<旧版本>` |

## Skills

### Catalog（批量管理，可私有）

Catalog 就是一个 git 仓库：`skills/<source-id>/<skill-name>/SKILL.md` + `packs/*.json` 定义 Pack + `sources.lock.json` 锁定上游 commit。公开或私有均可；私有仓库访问由你本机的 git 认证（gh / SSH / credential helper）负责。

### 连接私有 Skills 仓库

私有仓库不需要任何特殊配置：CLI 不接触任何 token，clone 与 fetch 全部交给本机 git——git 能访问的仓库，AgentHome 就能用。以连接你自己的私有 catalog（如 `Echo-Kang-hub/agenthome-catalog`）为例：

```bash
# 1. 确保 git 能访问你的私有仓库（只需做一次，二选一）
gh auth login                                            # GitHub CLI 登录（推荐，三平台通用）
# 或：ssh -T git@github.com                              # 配置好 SSH key 即可，无需 gh

# 2. 一行指向你的 catalog
agenthome catalog use Echo-Kang-hub/agenthome-catalog    # 换成 <你的用户名>/<你的仓库>

# 3. 验证能拉取（输出 40 位 commit 即成功）
agenthome catalog sync

# 4. 安装 Skills
agenthome skills                                         # 安装默认 Pack（common）

agenthome catalog default                                # 随时查看当前指向
```

- HTTPS 方式在 Windows 上默认走 Git Credential Manager（首次自动弹窗登录）；也可以直接用 SSH 地址：`agenthome catalog use git@github.com:Echo-Kang-hub/agenthome-catalog.git`
- `agenthome skills add <owner/repo>` 从单个私有仓库直接安装 Skill，同样走这套本机 git 认证

常见问题：

| 现象 | 处理 |
|---|---|
| `schannel: failed to receive handshake / SSL/TLS connection failed` | 网络或代理阻断了到 github.com 的 TLS 连接，与认证无关；检查代理/VPN，或改用 SSH 地址 |
| `Unable to fetch catalog` + `Check your GitHub authentication` | git 没有该私有仓库的访问权限；先跑 `gh auth status` 或 `ssh -T git@github.com` |
| 想换回别的 catalog | 再执行一次 `agenthome catalog use <原 spec>` 即可（见「撤回操作」表） |

```bash
agenthome catalog use <owner/repo>    # 或完整 URL、本地路径；私有仓库同样支持
agenthome catalog sync                # 拉取/更新缓存（~/.config/agent-skills/catalog/）
agenthome catalog default             # 查看当前 catalog

agenthome skills                      # 安装/同步配置的 Packs（默认 common）
agenthome skills development research # 安装多个 Pack；common 自动包含
agenthome skills -g development       # 安装到全局作用域
agenthome skills uninstall development
agenthome skills uninstall            # 移除全部受管理 Skills
agenthome skills uninstall-skill <name...>
agenthome skills tree [pack...]       # 查看 catalog 内容树
agenthome skills packs                # 列出可用 Packs
agenthome skills status [-g]          # 当前安装状态
```

每次安装会把 catalog commit 写入项目锁 `.agent-skills.lock.json`，跨设备可复现。

> 出厂默认指向维护者的示例 catalog；请先用 `agenthome catalog use <owner/repo>` 指向你自己的 catalog。

把上游 Skill 仓库纳入自己的 catalog（在 catalog 克隆内运行）：

```bash
agenthome catalog source-add <id> <repo> [--name <name>] [--skill-root <path>]
agenthome catalog add <owner/repo> [skill...] [--pack <pack>]   # 登记上游、固定 commit、保存许可证
agenthome catalog update [source] [--check]                     # 跟进上游更新
agenthome catalog doctor                                        # 校验 catalog
```

### 直接源（单仓库快速安装）

```bash
agenthome skills add <owner/repo> [skill...] [-g]
```

从任意 GitHub 仓库直接安装 Skill（递归发现），锁 commit、保存许可证。公开仓库直接可用；**私有仓库同样支持**——使用你本机的 git 认证（`gh auth login` 或 SSH）。与 Pack 管理的 Skill 重名会被拒绝；`uninstall-skill` 同步清理。

## 开发者

构建、测试与发布流程见 [docs/development.md](docs/development.md)。
