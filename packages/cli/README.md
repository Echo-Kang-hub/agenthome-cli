# AgentHome CLI

AgentHome 是一个命令行工具，用于统一管理编码 Agent（Claude Code、Codex、OpenCode）的运行时配置与 Skills，支持 Windows、macOS 和 Linux。

## 安装

要求 Node.js ≥ 18.17。

```bash
npm install -g agenthome-cli
```

安装提供两个命令：`agenthome` 与简写 `ah`，二者等价。

卸载：

```bash
npm uninstall -g agenthome-cli
```

## 快速开始

```bash
agenthome claude init                            # 初始化 Claude Code（默认全局认证 + 项目便携会话）
agenthome claude init --auth project             # 项目级认证（凭据随项目，不进 Git）
agenthome codex init --sessions global           # Codex 会话留在全局原生存储
agenthome claude sessions import                 # 把本机会话复制进项目便携存储
agenthome sessions git off                       # 会话不进 Git
agenthome catalog use <owner/repo>               # 指向你自己的 Skills catalog
agenthome skills                                 # 安装默认 Pack（common）
agenthome skills add <owner/repo>                # 从任意 GitHub 仓库直接安装 Skills
```

## Agent 运行时

### 命令

`<agent>` 为 `claude`、`codex`、`opencode` 之一。

| 命令 | 说明 |
|---|---|
| `agenthome <agent> init [--auth global\|project] [--sessions global\|project]` | 初始化运行时 |
| `agenthome <agent> deinit [--purge]` | 移除运行时；`--purge` 一并删除数据 |
| `agenthome <agent> auth [global\|project\|reset]` | 设置认证作用域；不带参数时查看当前状态 |
| `agenthome <agent> status` | 查看该 Agent 的配置与状态 |
| `agenthome <agent> sessions import\|restore\|status` | 管理便携会话 |
| `agenthome <agent> [args...]` | 启动 Agent，其余参数透传给官方 CLI |
| `agenthome status` | 三个 Agent 一览 |
| `agenthome doctor` | 环境自检 |
| `agenthome sessions git on\|off\|status` | 便携会话的 Git 同步开关 |

`init` 的输出会列出实际创建或修改的内容（`.agents/runtime.json`、`.agents/sessions/<agent>/`、`.agents/local/<agent>/`、`.gitignore`）及使用方法。`init` 可重复执行：结构已符合时不作修改，有缺失时只增量补齐。

### 认证作用域

- `global`（默认）：使用 Agent 的本机全局凭据（如 `~/.claude`、`~/.codex`）。
- `project`：凭据与配置保存在项目 `.agents/local/<agent>/`（自动 gitignore）。同一 Agent 在不同项目可使用不同账号。

```bash
agenthome claude auth project        # 切换到项目认证
agenthome claude auth global         # 切回全局
agenthome claude auth reset          # 清除本项目覆盖，恢复默认
agenthome claude auth                # 查看当前生效的认证作用域
```

### 会话记录

- `project`（默认）：启动前恢复、结束后捕获，会话保存在 `.agents/sessions/<agent>/`，可跨设备迁移。
- `global`：会话直接留在 Agent 的原生全局存储。

```bash
agenthome codex sessions import      # 全局会话 → 项目便携存储（复制不删除）
agenthome codex sessions restore     # 便携存储 → 原生存储
agenthome codex sessions status
agenthome sessions git on|off|status # 便携会话的 Git 同步开关
```

若同一会话在本机原生存储与便携存储中都有记录，启动时保留本机版本并提示 `Portable session conflicts skipped`。

> 项目会话可能包含提示词、源码、命令输出、路径与密钥；仅在可信仓库中提交会话。

## Skills

### Catalog

Catalog 是一个 git 仓库：`skills/<source-id>/<skill-name>/SKILL.md` 存放 Skills，`packs/*.json` 定义 Pack，`sources.lock.json` 锁定上游 commit。公开或私有均可；私有仓库的访问使用本机 git 认证（gh、SSH 或 credential helper）。

```bash
agenthome catalog use <owner/repo>    # 设置 catalog 源（owner/repo[#ref]、URL 或本地路径）
agenthome catalog sync                # 拉取或更新缓存（~/.config/agent-skills/catalog/）
agenthome catalog default             # 查看当前 catalog
```

```bash
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

> 默认 catalog 为维护者提供的示例；使用前请通过 `agenthome catalog use <owner/repo>` 指向自己的 catalog。

#### 连接私有 Skills 仓库

私有仓库不需要额外配置：CLI 不接触 token，clone 与 fetch 全部由本机 git 完成。以连接私有 catalog `Echo-Kang-hub/agenthome-catalog` 为例：

```bash
gh auth login                                            # 1. 登录 GitHub（或改用 SSH key，二选一，只需一次）
agenthome catalog use Echo-Kang-hub/agenthome-catalog    # 2. 设置 catalog 源（换成 <你的用户名>/<你的仓库>）
agenthome catalog sync                                   # 3. 验证可拉取（输出 40 位 commit 即成功）
agenthome skills                                         # 4. 安装默认 Pack（common）
```

- Windows 上 HTTPS 方式默认使用 Git Credential Manager（首次自动弹窗登录）；也可以使用 SSH 地址：`agenthome catalog use git@github.com:<owner>/<repo>.git`
- `agenthome skills add <owner/repo>` 从单个私有仓库安装 Skill，认证方式相同

| 现象 | 处理 |
|---|---|
| `schannel: failed to receive handshake / SSL/TLS connection failed` | 网络或代理阻断了到 github.com 的 TLS 连接，与认证无关；检查代理/VPN，或改用 SSH 地址 |
| `Unable to fetch catalog` + `Check your GitHub authentication` | git 没有该私有仓库的访问权限；先运行 `gh auth status` 或 `ssh -T git@github.com` |
| 换回其他 catalog | 再次执行 `agenthome catalog use <原 spec>` |

#### 维护 catalog

在 catalog 克隆内运行：

```bash
agenthome catalog source-add <id> <repo> [--name <name>] [--skill-root <path>]
agenthome catalog add <owner/repo> [skill...] [--pack <pack>]   # 登记上游、固定 commit、保存许可证
agenthome catalog update [source] [--check]                     # 跟进上游更新
agenthome catalog doctor                                        # 校验 catalog
```

### 直接源

```bash
agenthome skills add <owner/repo> [skill...] [-g]
```

从任意 GitHub 仓库直接安装 Skill（递归发现），锁定 commit 并保存许可证。公开仓库直接可用；私有仓库使用本机 git 认证（`gh auth login` 或 SSH）。与 Pack 管理的 Skill 重名会被拒绝。

## 撤回操作

| 操作 | 撤回 |
|---|---|
| `agenthome <agent> init` | `agenthome <agent> deinit`（加 `--purge` 连会话数据一起删除） |
| `agenthome <agent> auth project` / `auth global` | 执行相反设置，或 `auth reset` 恢复默认 |
| `agenthome <agent> sessions import` | 只复制不删除；清除项目副本：`agenthome <agent> deinit --purge` 后重新 `init` |
| `agenthome sessions git off` | `agenthome sessions git on` |
| `agenthome skills` / `agenthome skills <pack>` | `agenthome skills uninstall`（全部）或 `agenthome skills uninstall <pack>` |
| `agenthome skills add <owner/repo>` | `agenthome skills uninstall-skill <skill...>` |
| `agenthome catalog use <spec>` | 再次执行 `agenthome catalog use <原 spec>` 换回 |
| `agenthome self-update` | `npm install -g agenthome-cli@<旧版本>` |

## 自更新

```bash
agenthome self-update
```

从 npm 更新 AgentHome 到最新版本。

## 开发者

构建、测试与发布流程见 [docs/development.md](docs/development.md)。

## License

[MIT](LICENSE)
