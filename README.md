# AgentHome CLI

一个命令行工具，统一管理编码 Agent 的**运行时**（Claude Code / Codex / OpenCode）与 **Skills**，支持 Windows、Ubuntu 和 macOS。

## 功能

- **多 Agent 运行时管理**：同一项目内为 Claude Code、Codex、OpenCode 独立初始化、查看状态、卸载；`ahc` / `ahx` / `aho` 简写直达。
- **认证作用域可选**：`--auth global`（本机共享凭据，默认）或 `--auth project`（凭据与配置保存在项目 `.agents/local/`，自动 gitignore，每个项目可用不同账号）。
- **会话记录可选**：`--sessions project`（默认，便携会话存 `.agents/sessions/`，可随项目迁移、可开关 Git 同步）或 `--sessions global`（使用 Agent 的原生全局存储）。
- **Skills 双源**：
  - **Catalog**：Skills 组织成 Packs 批量安装；catalog 是任意 git 仓库（公开或私有），`agent catalog use` 一行切换；commit 锁定，跨设备可复现。
  - **直接源**：`agent skills add <owner/repo>` 从任意 GitHub 仓库（公开或私有）直接安装 Skill，许可证自动保存。
- **安装作用域可选**：默认安装到项目（`.claude/skills/` + `.agents/skills/`），`-g` 安装到全局用户目录。
- **认证完全委托 git**：CLI 不接触任何 token；私有仓库走 gh、SSH 或 credential helper。
- **可重复执行的初始化**：`init` 幂等——项目结构已符合时不做任何修改（提示 Already up to date）；缺什么（目录、gitignore 规则、配置）就只补什么。
- **自更新**：`agenthome self-update` 从 npm 更新。

## 安装

要求 Node.js ≥ 18.17。

```bash
npm install -g agenthome-cli
```

安装后可用 `agent`、`agenthome`、`agent-skills`、`ahc`、`ahx`、`aho`。简写特意避开 PowerShell / cmd / bash 的内置命令与别名（例如 PowerShell 的 `ac` 是 `Add-Content` 的别名）。AgentHome 只使用 npm 标准 `bin`，不修改 NVM、Node、npm 或 PATH。

卸载：`npm uninstall -g agenthome-cli`

## 快速开始

```bash
ahc init                            # 初始化 Claude Code（默认全局认证 + 项目便携会话）
ahc init --auth project             # 项目级认证（凭据随项目，不进 Git）
ahx init --sessions global          # Codex 会话留在全局原生存储
ahc sessions import                 # 把本机会话复制进项目便携存储
agent sessions git off              # 会话不进 Git
agent catalog use <owner/repo>      # 指向你自己的 Skills catalog（任何 git 仓库）
agent skills                        # 安装/同步默认 Pack（common）
agent skills add <owner/repo>       # 从任意 GitHub 仓库直接安装 Skills
```

## Agent 运行时

| Agent | 全写 | 简写 |
|---|---|---|
| Claude Code | `agent claude` | `ahc` |
| Codex | `agent codex` | `ahx` |
| OpenCode | `agent opencode` | `aho` |

```bash
ahc init [--auth global|project] [--sessions global|project]
ahc status                         # 该 Agent 的配置与状态
agent status                       # 三个 Agent 一览
agent doctor                       # 环境自检
ahc deinit                         # 卸载运行时；--purge 一并删除数据
```

`init` 可以放心重复执行：结构已符合 → 不做任何修改；有缺失 → 只增量补齐。

### 认证作用域

- `global`（默认）：使用 Agent 在本机的全局凭据（如 `~/.claude`、`~/.codex`）。
- `project`：凭据与配置全部保存在项目 `.agents/local/<agent>/`（自动 gitignore）。同一个 Agent 在不同项目可以用不同账号，项目拷走即带走配置。

```bash
ahc auth project                   # 切换到项目认证
ahc auth global                    # 切回全局
ahc auth reset                     # 清除本项目覆盖，恢复默认
ahc auth                           # 查看当前生效的认证作用域
```

### 会话记录

- `project`（默认）：每次启动前恢复、结束后捕获，会话保存在 `.agents/sessions/<agent>/`，可跨设备迁移；`agent sessions git off` 可禁止提交。
- `global`：会话直接留在 Agent 的原生全局存储，AgentHome 不做拷贝。

```bash
ahx sessions import                # 全局会话 → 项目便携存储（复制不删除）
ahx sessions restore               # 便携存储 → 原生存储
ahx sessions status
agent sessions git on|off|status   # 便携会话的 Git 同步开关
```

> 项目会话可能包含提示词、源码、命令输出、路径与密钥，只在你信任的仓库提交会话。

## Skills

### Catalog（私有 Skills 库，批量管理）

Catalog 就是一个 git 仓库：`skills/<source-id>/<skill-name>/SKILL.md` + `packs/*.json` 定义 Pack + `sources.lock.json` 锁定上游 commit。公开或私有均可；私有仓库访问由你本机的 git 认证（gh / SSH / credential helper）负责。

```bash
agent catalog use <owner/repo>       # 或完整 URL、本地路径；私有仓库同样支持
agent catalog sync                   # 拉取/更新缓存（~/.config/agent-skills/catalog/）
agent catalog default                # 查看当前 catalog

agent skills                         # 安装/同步配置的 Packs（默认 common）
agent skills development research    # 安装多个 Pack；common 自动包含
agent skills -g development          # 安装到全局作用域
agent skills uninstall development
agent skills uninstall               # 移除全部受管理 Skills
agent skills uninstall-skill <name...>
agent skills tree [pack...]          # 查看 catalog 内容树
agent skills packs                   # 列出可用 Packs
agent skills status [-g]             # 当前安装状态
```

每次安装会把 catalog commit 写入项目锁 `.agent-skills.lock.json`，跨设备可复现。

> 出厂默认指向维护者的示例 catalog；请先用 `agent catalog use <owner/repo>` 指向你自己的 catalog。

把上游 Skill 仓库纳入自己的 catalog（在 catalog 克隆内运行）：

```bash
agent catalog source-add <id> <repo> [--name <name>] [--skill-root <path>]
agent catalog add <owner/repo> [skill...] [--pack <pack>]   # 登记上游、固定 commit、保存许可证
agent catalog update [source] [--check]                     # 跟进上游更新
agent catalog doctor                                        # 校验 catalog
```

### 直接源（单仓库快速安装）

```bash
agent skills add <owner/repo> [skill...] [-g]
```

从任意 GitHub 仓库直接安装 Skill（递归发现），锁 commit、保存许可证。公开仓库直接可用；**私有仓库同样支持**——使用你本机的 git 认证（`gh auth login` 或 SSH）。与 Pack 管理的 Skill 重名会被拒绝；`uninstall-skill` 同步清理。

## 开发者

构建、测试与发布流程见 [docs/development.md](docs/development.md)。
