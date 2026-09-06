# AgentHome CLI

AgentHome 的公开 CLI 与运行时：统一管理 **Skills、项目 Runtime、认证作用域与可迁移会话**，支持 Windows、Ubuntu 和 macOS。

- Claude Code、Codex、OpenCode 可在同一项目中独立初始化。
- Skills 双源：私有 Catalog（默认，按 Pack 安装，锁定 commit）＋ 直接公开源（`agent skills add <owner/repo>`）。
- Skills 作用域默认跟随项目，`-g` 安装到全局用户目录。
- 会话属于项目；认证默认属于当前电脑，也可配置为项目作用域。
- CLI 与 Catalog 独立升级；Catalog 通过 git 拉取并全局缓存，不随 CLI 发布。
- 所有终端输出使用英文；安装、初始化和同步均可重复执行。

## 安装

```bash
npm install -g agenthome-cli
```

开发/预发布版本从 GitHub 安装：

```bash
npm install -g Echo-Kang-hub/agenthome-cli#main
```

安装后可直接运行 `agent`、`agenthome`、`ac`、`ax`、`ao`。AgentHome 使用 npm 标准 `bin`，不修改 NVM、Node、npm 或 PATH。

卸载与更新：

```bash
npm uninstall -g agenthome-cli
agent update
```

## Agent Runtime

| Agent | 全写 | 简写 |
|---|---|---|
| Claude Code | `agent claude` | `ac` |
| Codex | `agent codex` | `ax` |
| OpenCode | `agent opencode` | `ao` |

```bash
ac init                        # 默认 --auth global
ax init --auth global
ao init --auth project
ac status
agent status                   # 三个 Agent 一览
agent doctor
ax sessions import             # 迁移全局会话到项目（复制而不删除）
ax sessions status
agent sessions git off         # 会话不进 Git
ax deinit                      # 保留会话；--purge 一并删除
```

Project Auth 的认证桥接仍在开发中；`auth project` 会提示未实现。初始化会确保 `.gitignore` 忽略 `.claude/skills/`、`.agents/skills/`、`.agents/local/`、`.agents/tmp/`、`.agents/direct/`、`.agents/licenses/`；可以提交 `.agents/runtime.json` 与 `.agents/sessions/`，绝不要提交 `.agents/local/`。

## Skills

### 私有 Catalog（默认）

```bash
agent skills                        # 安装/同步配置的 Packs（默认 common）
agent skills development            # 安装一个或多个 Pack；common 自动包含
agent skills -g development         # 全局作用域
agent skills uninstall development
agent skills uninstall              # 移除全部受管理 Skills，保留外部手工安装的
agent skills uninstall-skill <name...>
agent skills tree [pack...]
agent skills status [-g]
agent skills packs
```

Catalog 默认 `Echo-Kang-hub/agenthome-catalog#main`（私有仓库）。CLI 通过 git 拉取并缓存到 `~/.config/agent-skills/catalog/<owner>-<repo>/`，重复使用不重新 clone；`.agent-skills.lock.json` 锁定 catalog commit，跨设备可复现。

认证：CLI 不处理任何 token，完全委托 git 凭据助手或 SSH。私有仓库访问失败时先运行：

```bash
gh auth login
```

Catalog 配置：

```bash
agent catalog use <owner/repo[#ref]>   # 或完整 URL、本地路径
agent catalog sync                     # 拉取或更新缓存
agent catalog default                  # 查看当前 spec
```

### 直接公开源

```bash
agent skills add <owner/repo> [skill...] [-g]
```

从任意公开仓库直接安装 Skill（递归发现 Skill 目录），克隆保存在 `.agents/direct/`，许可证保存在 `.agents/licenses/`（均已 gitignore）。与 Pack 管理的 Skill 重名会被拒绝；`uninstall-skill` 会同步清理直接源状态。

## 维护 Catalog

以下命令只在私有 catalog 仓库（agenthome-catalog）的 clone 内执行：

```bash
agent catalog doctor
agent catalog update [source] [--check]
agent catalog add <source|owner/repo> [skill...] [--pack <pack,pack>]
agent catalog remove <source|owner/repo> <skill...> [--pack <pack,pack>]
agent catalog pack-add <id> [--name <name>] [--description <text>]
agent catalog pack-remove <pack...>
agent catalog source-add <id> <repo> [--name <name>] [--skill-root <path>]
```

Catalog 命令会登记来源、固定 commit 并保存许可证；失败自动回滚；重复执行不产生变更。

## 迁移：旧安装

- 最老的 `agenthome` 安装（该仓库已改名为私有 catalog 仓库 `agenthome-catalog`）：旧 bin 仍可运行但只显示迁移指引。

```bash
npm uninstall -g agenthome
npm install -g agenthome-cli
```

- 发布前的 GitHub 根包安装（`agenthome-cli-monorepo`）：它与 registry 包同名 bin 冲突，先卸载再装：

```bash
npm uninstall -g agenthome-cli-monorepo
npm install -g agenthome-cli
```

Skills 数据（`.claude/skills/`、`.agents/skills/`、`.agent-skills.json`、`.agent-skills.lock.json`）无需迁移，新 CLI 兼容读取。

## 开发

```bash
npm install
npm test               # node --test；pretest 自动同步 vendor core
npm run test:install   # 双模式全局安装集成测试（registry 包 + GitHub 根包）
npm run pack:cli       # npm pack --dry-run
```

结构：

```text
packages/core/       平台无关核心（runtime、sessions、skills、catalog、direct）
packages/cli/        命令行层（dispatcher、skills-cli）；vendor/core-src 为发布用同步副本
integration/         全局安装集成测试
test/                单元与 fixture 测试（catalog 用例全部本地 git fixture，不联网）
```

## 发布

`agenthome-cli` 已发布到 npm（MIT）。发布新版本：

```bash
npm login   # 已登录则跳过
# 编辑 packages/cli/package.json（及 packages/core/package.json）：提升 version
cd packages/cli && npm publish
```

> `agentHome.packageSpec` 保持 `agenthome-cli@latest`，`private` 保持 `false`（已发布包）。
>
> 仓库根 package.json 故意**不带 `workspaces` 字段，也没有任何 install 生命周期脚本**（postinstall/build/preinstall/install/prepack/prepare）：npm 11 对 git 简写安装会把 node_modules 链接到 pacote 解包临时目录，`workspaces` 或这些脚本会让 pacote 在该目录里再跑一次嵌套 `npm install`，Windows 上两者竞争会把解包目录改残（bin 报 MODULE_NOT_FOUND）。本包零依赖，无需 workspaces（`test/packaging.test.mjs` 守护此约束）。

## 安全边界

- 新增或更新 Skill 后仍需审核脚本、网络请求和依赖安装。
- `.agents/local/` 永远只保存机器私有状态，不得进入 Git。
- Session 扫描只能降低风险，不能保证对话中没有密钥。
- 上游许可证尽可能保存在各 Skill 目录与 `.agents/licenses/`。
