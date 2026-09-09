# Avenic CLI

Avenic 是一个命令行工具，用于统一管理编码 Agent（Claude Code、Codex、OpenCode）的运行时配置与 Skills，支持 Windows、macOS 和 Linux。

## 安装

要求 Node.js ≥ 18.17。

```bash
npm install -g avenic
```

安装提供两个命令：`avenic` 与简写 `ave`，二者等价。

卸载：

```bash
npm uninstall -g avenic
```

## 快速开始

```bash
avenic claude init                            # 初始化 Claude Code（默认全局认证 + 项目便携会话）
avenic claude init --auth project             # 项目级认证（凭据随项目，不进 Git）
avenic codex init --sessions global           # Codex 会话留在全局原生存储
avenic claude sessions import                 # 把本机会话复制进项目便携存储
avenic claude sessions writeback              # 把项目便携会话显式回写本机
avenic sessions git off                       # 会话不进 Git
avenic catalog add <owner/repo>               # 导入 catalog（可导入多个，会打印 Pack 预览树）
avenic catalog select                         # 上下键切换当前 catalog
avenic skills install                         # 安装默认 Pack（common）
avenic skills add <owner/repo>                # 从任意 GitHub 仓库直接安装 Skills
```

## Agent 运行时

### 命令

`<agent>` 为 `claude`、`codex`、`opencode` 之一。

| 命令 | 说明 |
|---|---|
| `avenic <agent> init [--auth global\|project] [--sessions global\|project]` | 初始化运行时 |
| `avenic <agent> deinit [--purge]` | 移除运行时；`--purge` 一并删除数据 |
| `avenic <agent> auth [global\|project\|reset]` | 设置认证作用域；不带参数时查看当前状态 |
| `avenic <agent> status` | 查看该 Agent 的配置与状态 |
| `avenic <agent> sessions import\|writeback\|status` | 管理便携会话 |
| `avenic <agent> [args...]` | 启动 Agent，其余参数透传给官方 CLI |
| `avenic status` | 三个 Agent 一览 |
| `avenic doctor` | 环境自检 |
| `avenic sessions git on\|off\|status` | 便携会话的 Git 同步开关 |

`init` 的输出会列出实际创建或修改的内容（`.agents/runtime.json`、`.agents/sessions/<agent>/`、`.agents/local/<agent>/`、`.gitignore`）及使用方法。`init` 可重复执行：结构已符合时不作修改，有缺失时只增量补齐。

### 认证作用域

- `global`（默认）：使用 Agent 的本机全局凭据（如 `~/.claude`、`~/.codex`）。
- `project`：凭据与配置保存在项目 `.agents/local/<agent>/`（自动 gitignore）。同一 Agent 在不同项目可使用不同账号。

```bash
avenic claude auth project        # 切换到项目认证
avenic claude auth global         # 切回全局
avenic claude auth reset          # 清除本项目覆盖，恢复默认
avenic claude auth                # 查看当前生效的认证作用域
```

### 会话记录

- `project`（默认）：启动前把项目内的会话记录提供给 Agent，退出后把本次会话写回 `.agents/sessions/<agent>/`（可跨设备迁移），并把本机原生存储恢复到启动前的状态。会话只更新在项目里，全局存储完全不受影响；删除项目后，会话随项目消失。
- `global`：会话直接留在 Agent 的原生全局存储，不产生项目副本。

```bash
avenic codex sessions import      # 全局会话 → 项目会话记录（复制不删除）
avenic codex sessions writeback   # 项目会话记录 → 原生存储（显式回写）
avenic codex sessions status
avenic sessions git on|off|status # 项目会话记录的 Git 同步开关
```

若同一会话在本机原生存储与项目内都有记录，`avenic <agent>` 启动时以项目内的会话记录为准（覆盖本机副本）。运行 `avenic claude` 优先使用项目内的会话记录；要用全局会话记录时，直接运行 `claude`（其他 Agent 同理直接运行官方 CLI）即可。

项目内的会话记录不会自动回写本机原生存储；需要回写时显式执行 `avenic <agent> sessions writeback`：原生存储中该项目的会话记录会被项目内记录覆盖；原生存储中没有该项目的会话记录时，则按 Agent 的原生目录结构创建后放入会话，效果与直接用官方 CLI 产生的会话一致。

同一项目同一 Agent 可同时启动多个 `avenic` 会话：第一个启动时保存原生存储快照，最后一个退出时回滚。每次启动还会派一个脱离终端的后台看门狗进程监视本次会话：直接关闭终端、关闭 VS Code、强杀进程都不会影响收尾——看门狗检测到 CLI 进程消失后自动把会话收进项目并恢复原生存储原状。看门狗自身被终止（断电、强制重启）且系统临时目录被清理时无法自动补救，残留会话留在原生存储里，可手动执行 `avenic <agent> sessions import` 收进项目；临时目录还在时，下次启动 `avenic` 会自动补救。

> OpenCode 例外：其会话存储由官方 CLI 自行管理，`avenic opencode` 启动后原生存储仍保留本次运行产生的会话，不受上述回滚保护。

> 项目会话可能包含提示词、源码、命令输出、路径与密钥；仅在可信仓库中提交会话。

## Skills

### Catalog

Catalog 是一个 git 仓库，公开或私有均可；私有仓库使用本机 git 认证（gh、SSH 或 credential helper），CLI 不接触 token。标准结构：

```
my-catalog/
├── sources.lock.json                    # 上游源登记：id、仓库地址、锁定 commit、Skill 根目录、许可证
├── packs/
│   ├── common.json                      # Pack 定义（common 为默认 Pack，安装时自动包含）
│   └── development.json
├── skills/                              # 按源归档的 Skill 副本
│   └── <source-id>/<skill-name>/SKILL.md
└── licenses/                            # 上游许可证（登记源时自动保存）
```

Pack 定义示例（`packs/development.json`）：

```json
{
  "schemaVersion": 1,
  "id": "development",
  "name": "Development",
  "description": "Research, coding, and review workflows.",
  "sources": [{ "source": "example-source", "skills": ["beta", "gamma"] }]
}
```

一个 catalog 可聚合多个上游源；Pack 从这些源挑选 Skill（可跨源），`description` 是 Pack 的用途说明，会显示在 `catalog add` 的预览树中。

#### 使用

```bash
avenic catalog add <owner/repo>         # 导入 catalog（owner/repo[#ref]、URL 或本地路径），成功后打印 Pack 预览树
avenic skills install                   # 安装默认 Pack（common）
avenic skills install development       # 安装多个 Pack；common 自动包含
avenic skills uninstall development     # 卸载 Pack（不带参数移除全部受管理 Skills）
avenic skills -g development            # 安装到全局作用域（skills <pack> 是 install 的简写）
avenic skills tree [pack...]            # 查看 catalog 内容树
avenic skills packs                     # 列出可用 Packs
avenic skills status [-g]               # 当前安装状态
```

`catalog add` 拉取失败不影响源保存，之后 `avenic catalog sync` 重试。可反复 `add` 注册多个 catalog，同一时间生效一个（该 catalog 聚合的多个上游源共享所有 Pack）：

```bash
avenic catalog select [name|spec]       # ↑/↓ 选择当前 catalog（无终端时打印列表）
avenic catalog list                     # 列出已注册 catalog（> 标记当前）
avenic catalog default                  # 查看当前 catalog
avenic catalog sync                     # 拉取或更新缓存（~/.config/avenic/catalog/）
```

每次安装把 catalog commit 写入项目锁 `.avenic.lock.json`，跨设备可复现。

> 默认 catalog 为维护者提供的示例；使用前请通过 `avenic catalog add <owner/repo>` 指向自己的 catalog。

#### 构造与维护 catalog

初始化骨架、登记上游、建 Pack、校验后推送：

```bash
mkdir my-catalog && cd my-catalog
git init
mkdir -p packs skills
echo '{"schemaVersion":1,"sources":[]}' > sources.lock.json
avenic catalog pack-add common --name Common                        # 新建 Pack
avenic catalog skill-add <owner/repo> --pack common                 # 登记第一个上游源并收录其全部 Skill
avenic catalog pack-add development --name Development
avenic catalog skill-add <owner/repo> skill-a skill-b --pack development
avenic catalog doctor                                               # 校验结构
git add -A && git commit -m "catalog" && git push
```

`skill-add` 自动登记未收录的上游源（锁定 commit、保存许可证）；省略 `[skill...]` 收录该源全部 Skill；可反复 `skill-add` 聚合多个上游源。

维护命令（在 catalog 克隆内运行）：

```bash
avenic catalog skill-add <source-id|owner/repo> [skill...] [--pack <pack,pack>]
avenic catalog remove <source-id|owner/repo> <skill...> [--pack <pack,pack>]   # 从 Pack 移除 Skill；无 Pack 引用时删除副本
avenic catalog pack-add <id> [--name <name>] [--description <text>]
avenic catalog pack-remove <pack...>                                          # 删除 Pack（common 不可删），无引用 Skill 一并清理
avenic catalog source-add <id> <repo> [--name <name>] [--skill-root <path>] [--license <path>]
avenic catalog update [source] [--check]                                      # 跟进上游更新，锁定新 commit
avenic catalog doctor                                                         # 校验 catalog
```

#### 连接私有 Skills 仓库

私有仓库不需要额外配置：CLI 不接触 token，clone 与 fetch 全部由本机 git 完成。以连接私有 catalog `Echo-Kang-hub/SkillsHub` 为例：

```bash
gh auth login                                            # 1. 登录 GitHub（或改用 SSH key，二选一，只需一次）
avenic catalog add Echo-Kang-hub/SkillsHub    # 2. 设置 catalog 源（换成 <你的用户名>/<你的仓库>），终端会打印 Pack 预览树
avenic catalog sync                                   # 3. 验证可拉取（输出 40 位 commit 即成功）
avenic skills install                                 # 4. 安装默认 Pack（common）
```

- Windows 上 HTTPS 方式默认使用 Git Credential Manager（首次自动弹窗登录）；也可以使用 SSH 地址：`avenic catalog add git@github.com:<owner>/<repo>.git`
- `avenic skills add <owner/repo>` 从单个私有仓库安装 Skill，认证方式相同

| 现象 | 处理 |
|---|---|
| `schannel: failed to receive handshake / SSL/TLS connection failed` | 网络或代理阻断了到 github.com 的 TLS 连接，与认证无关；检查代理/VPN，或改用 SSH 地址 |
| `Unable to fetch catalog` + `Check your GitHub authentication` | git 没有该私有仓库的访问权限；先运行 `gh auth status` 或 `ssh -T git@github.com` |
| 换回其他 catalog | 已注册的直接 `avenic catalog select` 切换；未注册的再次 `avenic catalog add <spec>` |

### 直接源

```bash
avenic skills add <owner/repo> [skill...] [-g]
avenic skills remove <skill...>   # 撤回：移除通过 add 安装的 Skills
```

从任意 GitHub 仓库直接安装 Skill（递归发现），锁定 commit 并保存许可证。公开仓库直接可用；私有仓库使用本机 git 认证（`gh auth login` 或 SSH）。与 Pack 管理的 Skill 重名会被拒绝。

## 撤回操作

| 操作 | 撤回 |
|---|---|
| `avenic <agent> init` | `avenic <agent> deinit`（加 `--purge` 连会话数据一起删除） |
| `avenic <agent> auth project` / `auth global` | 执行相反设置，或 `auth reset` 恢复默认 |
| `avenic <agent> sessions import` | 只复制不删除；清除项目副本：`avenic <agent> deinit --purge` 后重新 `init` |
| `avenic sessions git off` | `avenic sessions git on` |
| `avenic skills install [pack...]`（简写 `avenic skills [pack...]`） | `avenic skills uninstall`（全部）或 `avenic skills uninstall <pack>` |
| `avenic skills add <owner/repo>` | `avenic skills remove <skill...>` |
| `avenic catalog add <spec>` | `avenic catalog select` 选回已注册 catalog，或再次 `avenic catalog add <原 spec>` |
| `avenic self-update` | `npm install -g avenic@<旧版本>` |

## 自更新

```bash
avenic self-update
```

从 npm 更新 Avenic 到最新版本。

## 开发者

构建、测试与发布流程见 [docs/development.md](docs/development.md)。

## License

[MIT](LICENSE)
