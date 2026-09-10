# Skills 单副本共享设计（2026-09-10）

## 1. 背景与目标

现状：`installCopies`（`packages/core/src/skills/install.mjs:150-197`）无条件遍历 `context.targets`，对每个 target 执行 `rm` + `cp` 递归拷贝，因此每个 Skill 在每个作用域里都存两份——`.agents/skills/<name>/`（Codex/OpenCode/universal 读取）与 `.claude/skills/<name>/`（Claude Code 读取），两份内容逐字节相同。直接安装（`packages/core/src/skills/direct.mjs:125-140`）同样如此。磁盘占用翻倍，且两份副本会各自漂移（用户只改了其中一份）。

目标：

- 同一作用域内**每个 Skill 只保留一份物理文件**，被 Claude Code、Codex、OpenCode 共用；
- Claude Code 照常能发现并使用项目/全局 Skill，Codex/OpenCode 行为不变；
- 不引入新的 Git 策略（两个 skills 目录本就都在 `.gitignore` 中，见 `packages/core/src/runtime/gitignore.mjs:5-12`）；
- 任何环节失败都能降级回当前行为，不阻断安装、不丢数据；
- 安装 / 卸载 / 接管 / 状态四条路径语义一致。

作用域：**项目 + 全局都改**（2026-09-10 用户确认）。

## 2. 已实测事实（2026-09-10 本机验证）

| 结论 | 验证方式 |
|---|---|
| Claude Code 2.1.238 **没有**"原生读 `.agents/skills`"的能力 | 二进制字符串统计：`.claude/skills` 出现 78 次，`.agents/skills` 出现 0 次（`skillsDirs` 是 memory-store 字段，且 Windows 上明确禁用） |
| Claude Code **跟随目录级 junction** | 隔离环境（临时 `CLAUDE_CONFIG_DIR` + 本地假 endpoint 截获请求体），系统提示的可用技能列表中出现仅存在于 `.agents/skills`、经 `.claude/skills` junction 暴露的技能 |
| Claude Code **跟随逐技能 junction**，且未链接的对照技能不出现 | 同上；`.claude/skills/<name>` 为 junction 时被列出，`.agents/skills/` 下未链接的对照技能未被列出 |
| Node 无需管理员即可创建 junction | `fs.symlinkSync(target, link, "junction")`（Node v24.20.0 / Windows 11）成功并可直接读取 |
| 链接的判定 | `lstatSync(junction).isSymbolicLink() === true`、`.isDirectory() === false`；悬空链接 `lstatSync` 仍可用而 `existsSync` 返回 `false` |
| 删除链接**只删链接** | `rmSync(link, {recursive:true, force:true})`、`unlinkSync(link)`、`rmdirSync(link)` 三种方式实测真身文件均存活 |
| 删除链接**内部**的条目会删到真身 | `rmSync(link/<name>, {recursive:true})` 实测真身被删除 → 必须用 lstat 守卫（§7） |

## 3. 设计决策

### 3.1 机制

- **真实文件唯一存放地（canonical）**：`.agents/skills/<name>/`（全局为 `~/.agents/skills/<name>/`）。这是 Codex/OpenCode/universal 的原生读取目标，无需任何链接即可工作。
- **`.claude/skills/<name>` 改为链接**，指向 canonical：
  - Windows：`fs.symlinkSync(canonical, link, "junction")`（junction 要求绝对路径）；
  - macOS/Linux：`fs.symlinkSync(relative, link)`，`relative = path.relative(path.dirname(link), canonical)`，随项目整体移动仍有效。
- **逐技能链接**，而非把整个 `.claude/skills` 做成链接（对比见 §3.2）。
- 链接是**本地派生物**：两个 skills 目录都在 `.gitignore` 中，链接不进 Git，也不需要新的提交策略。

### 3.2 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 整目录链接（`.claude/skills` → `.agents/skills`） | 要求该目录被 avenic 独占；但 Claude Code 自身会往 skills 目录建内容（如 `/plugin new` 脚手架写 `~/.claude/skills/<name>/`），用户的既有技能也在其中。迁移时必须合并或放弃，风险高 |
| 硬链接（两份目录、共享 inode） | 文件级、跨卷失败；编辑器保存即断开；Git 里仍是两份，不解决"只有一份" |
| 反向：canonical = `.claude/skills`，`.agents/skills` 做链接 | Codex/OpenCode 是否跟随链接未验证；`.agents/` 才是跨 agent 约定目录 |
| 让 Claude Code 原生读 `.agents/skills` | 该能力不存在（§2 实测） |
| 保持两份、仅做内容去重比较 | 不满足"空间上只有一份" |

## 4. 目标模型

```js
// packages/core/src/skills/paths.mjs
export const PROJECT_TARGETS = [
  { agents: ["codex", "opencode", "universal"], label: "Codex / OpenCode / universal agents", relativePath: [".agents", "skills"] },
  { agents: ["claude-code"], label: "Claude Code", relativePath: [".claude", "skills"], shareFrom: [".agents", "skills"] },
];
// GLOBAL_TARGETS 同样两项，destination 落在用户主目录
```

- `shareFrom` 表示：该 target 不落真实文件，只维护指向 canonical target 的链接。**表顺序即处理顺序**（canonical 先、链接后）。
- `createInstallContext`（`install.mjs:56-59`）为每个 target 计算 `destination`；`shareFrom` 为真时再计算 `sharedDestination`（canonical 的绝对路径），缺失或非法则 `fail`。
- 锁文件 `.avenic.lock.json` 的 `agents` 字段仍取所有 target 的 agents（过滤 `universal`），但**按固定顺序输出**（`claude-code, codex, opencode`），避免表顺序调整造成锁文件无意义 diff。schema 版本不变（现有字段无语义变化）。

## 5. 关键流程

### 5.1 安装 / 更新（`installCopies`）

canonical target 保持现有逻辑（`unchanged` 快速路径、`rm` + `cp`、陈旧清理）。

`shareFrom` target 走新增的 `ensureSkillLinks()`：

| 现场状态（lstat） | 动作 | 计数 |
|---|---|---|
| 不存在 | 创建链接 | `shared` |
| 已是链接且解析到 canonical 对应技能 | 不动 | `unchanged` |
| 链接存在但指向别处 / 悬空 | 解除旧链接后重建 | `shared` |
| 真实目录，且与 canonical 递归内容一致 | 删除该副本、建链接（§6 迁移） | `shared` |
| 真实目录，内容不一致 | **不动**，报告冲突 | `conflict` |
| 链接创建失败（§8） | 退回 `cp` 拷贝 | `fallback` |

- "unchanged" 快速路径对 `shareFrom` target **必须校验链接存在且指向正确**，不能只看 `SKILL.md` 存在——否则 `git clone` 后（只有 canonical、没有链接）永远修不出来。
- 陈旧清理（`staleNames`）对 `shareFrom` target 只解除链接，真身由 canonical 那轮删除。
- 输出：canonical 行沿用 `Added/Updated/Unchanged/Removed`；`shareFrom` 行输出 `Shared N · Unchanged N`，`conflict > 0` 或 `fallback > 0` 时追加警告行与处理建议。

### 5.2 卸载 / 清理（`removeAllManagedSkills`、`removeSkillDirectories`）

对 `shareFrom` target：`lstat` 判定后**只解除链接**（`unlink`），绝不递归删除；canonical 轮负责删真身。既有 `existsSync` 判断对悬空链接返回 `false`，必须换成 `lstat`，否则会残留悬空链接。目标目录清空后沿用 `removeEmptyDirectory` 移除空目录（非空则保留）。

### 5.3 接管（`adoptSkills`）

- host 探测逻辑不变：按名字去重（链接与真身同路径，天然不重复）。
- 补齐缺失 target 时，`shareFrom` target 建**链接**而非拷贝；`placed` 语义保持"补齐的 target 数"（既有断言"`.claude/skills` 缺失 → placed 1"继续成立，只是补的是链接）。
- 返回值增加 `linked` 计数，供调用方展示。

### 5.4 直装 Skill（`direct.mjs`）

`addDirectSkills` / `removeExternalSkills` 同样按 target 类型分流：真身仍落在 `.agents/skills/<name>`，`.claude/skills/<name>` 建链接；clone 与许可证目录（`.agents/direct/<sourceId>`、`.agents/licenses/`）保持单副本现状不变。

### 5.5 启动补齐

- CLI：`dispatchAgent`（`packages/cli/src/cli/dispatcher.mjs:116`）的**默认启动分支**在 spawn 官方 CLI 之前调用 `ensureSkillLinks(context, { silent: true })`。
- 插件：`prepareAgentLaunch`（`packages/vscode/src/services/agents.ts`）同样调用，使插件直接启动 agent 也一致。
- **触发条件**：仅当 canonical 目录存在且至少含一个 Skill 时执行；未安装 Skills 的项目不产生任何副作用（不创建 `.claude/skills`、不写任何文件）。
- 发生修复时打印一行说明（CLI）或状态栏提示（插件）。

### 5.6 状态与修复

- `skillsInstallationStatus`（`install.mjs:420-437`）对 `shareFrom` target 返回链接状态：`linked` / `missing` / `conflict` / `fallback`；`complete` 判定 = canonical 完整 **且** 链接齐全。
- CLI `avenic skills status`：
  - 正常：`Claude Code   Shared via .agents/skills (N links)`
  - 缺失：`⚠ Claude Code   Links missing — run: avenic skills install`
  - 冲突：列出冲突技能名，提示手动处理（§6）
- 插件：Skills 视图与 Overview 展示链接状态；新增命令 `avenic.skills.repairLinks`（标题「Avenic: 修复 Skills 链接」），只调用 core 的 `ensureSkillLinks`，插件侧保持零 fs 逻辑。

## 6. 迁移（现有两份拷贝）

触发时机：下次 `skills install` / `add` / `adopt` / 启动补齐（无需单独的迁移命令）。

- `.claude/skills/<name>` 是真实目录且与 `.agents/skills/<name>` **递归内容一致** → 删除该副本、建立链接（计 `shared`）。
- 内容不一致（用户手改过其中一份）→ **不自动删除**：canonical 保留 avenic 版本，用户那份原样保留，计 `conflict` 并在状态中列出名字与建议（手动删除 `.claude/skills/<name>` 后重跑 `avenic skills install`）。
- 全局作用域同理（`~/.claude/skills` ↔ `~/.agents/skills`），不单独提供例外。
- 回退兼容：旧版本 avenic 遇到新布局时，会把 `.claude/skills/<name>`（链接）按老逻辑 `rm` + `cp` 覆盖成真实拷贝——退化为旧行为，不丢数据。

## 7. 安全不变量（实现必须遵守）

1. 任何对 target 内容的读/写/删之前先 `lstat`；`isSymbolicLink()` 为真即视为链接，**绝不当普通目录递归**。
2. 链接只能用 `unlink` 删除；禁止对链接路径使用 `rm -rf`。
3. 写入 canonical 前必须通过 `isInside(canonicalDestination, target)` 校验（沿用现有 `isInside` 守卫）。
4. **绝不递归删除 `.claude/skills` 目录本身**（仅当它是空的普通目录、且不含链接条目时才可由 `removeEmptyDirectory` 移除）。
5. 创建链接前确认 canonical 存在且是普通目录（非链接）。
6. 链接操作失败不得中断安装流程，按 §8 降级。

## 8. 降级与错误处理

| 情况 | 处理 |
|---|---|
| 创建链接失败（`EPERM` / `ENOTSUP` / `EXDEV` / 网络盘 / 非 NTFS） | 该技能退回拷贝（当前行为），输出 `⚠ Cannot create shared link (reason) — copied instead`，状态中标记 `fallback` |
| 悬空链接（canonical 被外部删除） | 视为缺失：优先重建；无法重建则解除链接并降级拷贝 |
| 冲突（内容不一致） | 不阻断其他技能，安装继续，状态与摘要中报告 |
| canonical 目录不存在 | `shareFrom` target 不做任何事（不创建空目录、不建链接） |
| canonical 存在但缺少某个技能 | 该技能不建链接（避免悬空链接），不影响其他技能 |

## 9. 影响面

| 位置 | 改动 |
|---|---|
| `packages/core/src/skills/links.mjs` | **新增**：`ensureSkillLinks`、`readLinkState`、`removeLinkSafely`、`sameTree`、平台分支 |
| `packages/core/src/skills/paths.mjs` | targets 表加 `shareFrom`、顺序调整 |
| `packages/core/src/skills/install.mjs` | `installCopies` / `removeAllManagedSkills` / `removeSkillDirectories` / `adoptSkills` / `skillsInstallationStatus` / `writeInstallMetadata`（agents 顺序） |
| `packages/core/src/skills/direct.mjs` | `addDirectSkills` / `removeExternalSkills` 分流 |
| `packages/core/src/index.mjs` | 导出新函数 |
| `packages/cli/src/cli/skills-cli.mjs` | 状态与摘要文案 |
| `packages/cli/src/cli/dispatcher.mjs` | 启动补齐 |
| `packages/cli/vendor/core-src/**` | `npm run sync-core` 同步（`test/sync.test.mjs` 守护） |
| `packages/vscode/src/services/skills.ts`、`services/agents.ts`、`commands/skills-commands.ts`、`package.json`、`views/**` | 状态映射、启动补齐、新命令 |
| `packages/core/src/runtime/gitignore.mjs` | **不改**（两个目录本就忽略） |
| 文档 | README×2、`docs/development.md`、`packages/vscode/CHANGELOG.md` |

## 10. 测试

新增（TDD）：

- links 单元：创建/识别/重建/悬空/别处指向；`unlink` 只删链接；`sameTree` 相同与不同。
- 安装：安装后 `.claude/skills/<name>` 是链接且解析到 `.agents/skills/<name>`；重复安装 `unchanged`；"只有 canonical、没有链接"（clone 场景）时安装补齐链接。
- 迁移：两份内容相同 → 删副本建链接；内容不同 → 保留 + `conflict` 报告。
- 卸载：链接解除 + 真身删除；同名外来技能（非受管）不受影响。
- 降级：注入链接创建失败 → 退回拷贝且不抛错。
- 跨平台：Windows 断言 junction、POSIX 断言 symlink（`process.platform` 分支）。

需按新语义修改的既有断言（"两个目录都有真实拷贝" → "canonical 有真身、另一处是链接"）：

- `test/skills.test.mjs`（:85、:91-93、:107、:117-118、:134、:142、:199-205、:266、:300-301）
- `test/skills-adopt.test.mjs`（:25-27、:39-46、:58-59、:66-67）
- `test/skills-detected.test.mjs`（:19-29、:33-41、:44-49、:53-54）
- `test/skills-direct-add.test.mjs`（:84-86、:111-115、:183-188）
- `test/skills-packadopt.test.mjs`（:59-62、:101-105、:132-133、:152-153）
- `test/cli-surface.test.mjs`（:308、:548-556）
- `test/cli-prompts.test.mjs`（:271-273）
- `packages/vscode/test/skills-commands.test.ts`（:135、:158-160、:181-186、:204-205、:214-222）
- `integration/global-install.mjs`（项目与 home 两个作用域）

## 11. 发布

1. bump `packages/core`（新增导出 + 行为变更）→ 发布 `@avenic/core`；
2. `npm run sync-core` → bump `packages/cli` → 发布 `avenic`；
3. bump `packages/vscode`（依赖新 core + 新命令）→ 打包 VSIX（Marketplace 上传按既有 USER CHECKPOINT 规则）。

## 12. 明确不做

- 不做整目录链接；
- 不做硬链接 / reflink；
- 不改 `.gitignore` 规则、不引入新的 Git 提交策略；
- 不为 Codex/OpenCode 做链接（它们读 canonical，无需链接）；
- 不自动删除内容冲突的用户副本；
- 不做后台守护或定时修复（仅在安装与启动时补齐）。

## 13. 开放问题

无（机制与作用域均已确认；实现细节在实施计划中展开）。
