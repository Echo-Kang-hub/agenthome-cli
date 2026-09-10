# Skills 单副本共享设计（2026-09-10，修订版 2）

> 修订记录：v2 按用户复审意见重写 §3（link 归属判定）、§5（preflight 迁移顺序）、§6（受管集合）、§7（`sameTree` 精确定义）、§8（状态语义）。v1 的机制选择（canonical `.agents/skills` + 逐技能 link）不变。

## 1. 背景与目标

现状：`installCopies`（`packages/core/src/skills/install.mjs:150-197`）无条件遍历 `context.targets`，对每个 target 执行 `rm` + `cp` 递归拷贝，因此每个 Skill 在每个作用域里都存两份——`.agents/skills/<name>/`（Codex/OpenCode/universal 读取）与 `.claude/skills/<name>/`（Claude Code 读取），两份内容逐字节相同。直接安装（`packages/core/src/skills/direct.mjs:125-140`）同样如此。磁盘占用翻倍，且两份副本会各自漂移（用户只改了其中一份）。

目标：

- 同一作用域内**每个 Skill 只保留一份物理文件**，被 Claude Code、Codex、OpenCode 共用；
- Claude Code 照常能发现并使用项目/全局 Skill，Codex/OpenCode 行为不变；
- 不引入新的 Git 策略（两个 skills 目录本就都在 `.gitignore` 中，见 `packages/core/src/runtime/gitignore.mjs:5-12`）；
- 任何环节失败都能降级回当前行为，不阻断安装、不丢数据；
- **绝不删除/改写任何不是 Avenic 自己创建的内容**（§3、§7 是这条的具体化）。

作用域：**项目 + 全局都改**（2026-09-10 用户确认）。

## 2. 已实测事实（2026-09-10 本机验证）

| 结论 | 验证方式 |
|---|---|
| Claude Code 2.1.238 **没有**"原生读 `.agents/skills`"的能力 | 二进制字符串统计：`.claude/skills` 出现 78 次，`.agents/skills` 出现 0 次 |
| Claude Code **跟随目录级 junction** | 隔离环境（临时 `CLAUDE_CONFIG_DIR` + 本地假 endpoint 截获请求体），系统提示的可用技能列表中出现仅存在于 `.agents/skills`、经 `.claude/skills` junction 暴露的技能 |
| Claude Code **跟随逐技能 junction**，且未链接的对照技能不出现 | 同上 |
| Node 无需管理员即可创建 junction | `fs.symlinkSync(target, link, "junction")`（Node v24.20.0 / Windows 11）成功并可直接读取 |
| 链接的判定 | `lstatSync(junction).isSymbolicLink() === true`、`.isDirectory() === false`；悬空链接 `lstatSync` 仍可用而 `existsSync` 返回 `false` |
| 删除链接**只删链接** | `rmSync(link, {recursive:true, force:true})`、`unlinkSync(link)`、`rmdirSync(link)` 三种方式实测真身文件均存活 |
| 删除链接**内部**的条目会删到真身 | `rmSync(link/<name>, {recursive:true})` 实测真身被删除 → 必须用 lstat 守卫（§9） |

## 3. 设计决策

### 3.1 机制

- **真实文件唯一存放地（canonical）**：`.agents/skills/<name>/`（全局为 `~/.agents/skills/<name>/`）。这是 Codex/OpenCode/universal 的原生读取目标，无需任何链接即可工作。
- **`.claude/skills/<name>` 改为指向 canonical 的链接**：
  - Windows：`fs.symlinkSync(canonical, link, "junction")`（junction 要求绝对路径）；
  - macOS/Linux：相对符号链接，`relative = path.relative(path.dirname(link), canonical)`，随项目整体移动仍有效。
- 逐技能链接，不做整目录链接（§3.3）。
- 链接是**本地派生物**：两个 skills 目录都在 `.gitignore` 中，链接不进 Git。

### 3.2 链接归属判定（A2：绝不误删用户的 link）

对 `.claude/skills/<name>` 执行 `lstat` → `isSymbolicLink()` 为真时，按**它实际指向哪里**分类，而不是按文件名猜：

| 判定 | 条件 | 动作 |
|---|---|---|
| `linked` | 原始 target（`readlink` 结果去掉 Windows `\\?\` 前缀后）与 canonical 经 `samePath` 相等；**或** `realpath(link)` 与 `realpath(canonical)` 经 `samePath` 相等 | 不动 |
| `repair` | 原始 target 与 canonical 相等（`samePath`），但链接已悬空（`existsSync` 为假 / `realpath` 抛错） | 解除该 link 后重建（视为 Avenic 布局：指向 canonical 的悬空链接只可能由 canonical 被外部删除造成） |
| `conflict` | 链接指向任何**其他**路径（含相对路径解析后不等于 canonical 的情形） | **不动、不 unlink**，报告 conflict |
| 未知 | `readlink` 抛错、或路径比较所需的两种判定都失败 | 按 `conflict` 处理（保守） |

- 判定一律走 `samePath`（`packages/core/src/runtime/sessions.mjs:18-27`，win32 下大小写不敏感 + `path.resolve` 归一化），**不做字符串裸 `===`**。
- Windows 上 `fs.readlinkSync` 对 junction 返回带 `\\?\` 前缀的绝对路径（例如 `\\?\C:\proj\.agents\skills\foo`），比较前必须剥前缀；POSIX 上相对 target 先 `path.resolve(path.dirname(link), raw)` 再比较。
- 仓库当前**没有**任何 link ownership 元数据（`lock.json` 只有 `sources/adopted/directSources/agents`，`install.mjs:119-141`）。本设计**不引入**"记录谁创建了链接"的字段：目标判定已经足够，且"记录过的链接被用户替换成别的目标"仍应报 conflict 而不是夺回控制权。

### 3.3 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 整目录链接（`.claude/skills` → `.agents/skills`） | 要求该目录被 avenic 独占；Claude Code 自身会往 skills 目录写内容（`/plugin new` 脚手架），用户的既有技能也在其中 |
| 硬链接 | 文件级、跨卷失败；编辑器保存即断开；Git 里仍是两份 |
| 反向：canonical = `.claude/skills` | Codex/OpenCode 是否跟随链接未验证；`.agents/` 才是跨 agent 约定目录 |
| 让 Claude Code 原生读 `.agents/skills` | 该能力不存在（§2） |
| 链接创建失败时把副本改名为 `.bak` 再重建 | 只是把"删除用户内容"推迟一步，且留下垃圾目录；改为保持现状 + 报告 fallback（§8） |

## 4. 目标模型

```js
// packages/core/src/skills/paths.mjs
export const PROJECT_TARGETS = [
  { id: "agents", agents: ["codex", "opencode", "universal"], label: "Codex / OpenCode / universal agents", relativePath: [".agents", "skills"] },
  { id: "claude", agents: ["claude-code"], label: "Claude Code", relativePath: [".claude", "skills"], shareFrom: "agents" },
];
export const GLOBAL_TARGETS = [
  { id: "agents", ...destination: ~/.agents/skills },                                  // canonical
  { id: "claude", ...destination: ~/.claude/skills, shareFrom: "agents" },
];
```

- `shareFrom` 指向同表内另一个 target 的 `id`。**表顺序仍是"Claude Code 先"**（不动现有顺序，避免无谓 diff）；canonical 与 link 的处理顺序由代码显式分两趟决定（§5.1），不依赖表顺序。
- `createInstallContext`（`install.mjs:33-61`）为每个 target 计算 `destination`；项目侧在有 `shareFrom` 时解析出 `shareDestination`（canonical 的绝对路径），解析不到则 `fail`。
- `writeInstallMetadata`（`install.mjs:133`）的 `agents` 字段今天由 `targets.flatMap(t => t.agents).filter(a => a !== "universal")` 得出，**依赖表顺序**；改为按显式常量 `MANAGED_AGENT_ORDER = ["claude-code", "codex", "opencode"]` 输出（不用 `Array#sort` 的字典序，避免偶然正确）。表顺序与 agents 字段从此解耦，锁文件字节与今天一致。
- 新增 core 导出 `managedSkillNames(context)`（§6），供链接与清理共用。

## 5. 关键流程

### 5.1 安装 / 更新（`installCopies`）

顺序是本次修订的核心（A1）：

```
1) 预检 + 迁移：ensureSkillLinks(context, selectedNames)      ← 在 canonical 被改动之前
2) canonical 安装：现有逻辑（unchanged 快速路径 / rm + cp / 陈旧清理）
3) 补链：ensureSkillLinks(context, selectedNames)             ← 幂等第二次，为第 1 步时尚不存在的 canonical 建链
4) 陈旧清理：shareFrom target 只 unlink，真身由 canonical 那轮删除
```

**为什么必须第 1 步先做**（原设计会误报 conflict 的 bug）：

1. 上一次安装时建链失败 → `.claude/skills/foo` 是 `cp` 出来的真实副本；
2. 当时它与 `.agents/skills/foo` 完全一致（fallback 路径总是 `cp` 最新内容，见 §8）；
3. 下一次 `foo` 升级：若先覆盖 canonical，再比较，则必然"不一致"；
4. 于是 Avenic 会把自己上次生成的 fallback 副本当成"用户手改的 conflict"。

先预检再改 canonical，第 2 步比较的是"**旧 canonical**"，fallback 副本与它一致 → 判定为可安全迁移：删除副本、建立链接；随后 canonical 升级，链接自动指向新版本（零拷贝完成升级）。

`ensureSkillLinks` 的逐技能判定（`lstat` + §3.2）：

| 现场状态 | 动作 | 计数 |
|---|---|---|
| 不存在 | 建链（canonical 存在时）；canonical 不存在则跳过 | `linked` / 跳过 |
| 链接且指向 canonical | 不动 | `unchanged` |
| 链接悬空但 target 等于 canonical | 重建 | `repair` |
| 链接指向别处 | 不动作 | `conflict` |
| 真实目录，与 canonical 递归一致（`sameTree`，§7） | 删副本 + 建链（**迁移**） | `migrated` |
| 真实目录，与 canonical 不一致 | **不动** | `conflict` |
| 真实目录，但 canonical 不存在该技能 | 不动（保留可用副本） | `fallback` |
| 建链失败（§9） | `cp` 一份（保持可用），记录 fallback | `fallback` |

- "unchanged" 快速路径对 shareFrom target **必须校验链接存在且指向正确**，不能只看 `SKILL.md` 存在——否则 `git clone` 后（只有 canonical、没有链接）永远修不出来。
- 陈旧清理（`staleNames`，当前 `install.mjs:182-190`）对 shareFrom target 只解除链接；真身由 canonical 那轮删除；`.agents/skills` 中不受管的同名外来技能不受影响（§6）。

### 5.2 卸载 / 清理（`removeAllManagedSkills`、`removeSkillDirectories`）

**处理顺序：shareFrom target 先于 canonical target**（顺序由代码显式决定，不依赖表顺序）——否则 canonical 先被删除后就再也无法用 `sameTree` 判断副本是不是我们自己的。

| shareFrom 中的现场 | 动作 |
|---|---|
| 链接指向 canonical（含悬空，target 仍等于 canonical） | `unlink`（**只删链接**，真身由 canonical 轮删除） |
| 真实目录 | 删除（用户已按名要求移除；今天的行为就是 `rm -rf`，保持不变） |
| 链接指向别处 | **保留**并报告 conflict（§3.2 在卸载路径上同样生效：我们从不 unlink 别人的链接） |

- 区分两类语义：**自动流程**（安装预检 / 启动补齐，§5.1、§5.5）只删 `sameTree === true` 的真实副本；**用户按名显式移除**（`removeAllManagedSkills`、`removeSkillDirectories`、`removeExternalSkills`）保留今天的删除语义——名字本身就是授权，删除范围只在 shareFrom target 内，真身由 canonical 轮处理。
- 既有 `existsSync` 判断对悬空链接返回 `false`，必须换成 `lstat`，否则会残留悬空链接。
- 目标目录清空后沿用 `removeEmptyDirectory` 移除空目录（非空则保留）。

### 5.3 接管（`adoptSkills` / `adoptPackedSkills`）

- host 探测逻辑不变（`install.mjs:260-267`）：按名字去重，链接与真身同路径，天然不重复。
- 补齐缺失 target 时，shareFrom target **建链接**而非拷贝；`placed` 语义保持"补齐的 target 数"。
- 真实目录已存在的 shareFrom target（用户手放在 `.claude/skills` 的那一份）：走 §3.2/§5.1 的判定，一致则迁移为链接，不一致则 conflict 且**不覆盖**（`adoptSkills` 现有"已存在即不覆盖"的语义保持不变）。
- `adoptPackedSkills` 内部调用 `installCopies(..., {removeStale:false})`，自动获得 §5.1 的三趟顺序。
- 返回值增加 `linked` 计数，供调用方展示。

### 5.4 直装 Skill（`direct.mjs`）

`addDirectSkills`（`direct.mjs:125-140`）与 `removeExternalSkills` 按同一套语义分流：

- 真身仍落在 `.agents/skills/<name>`；`.claude/skills/<name>` 建链接；
- **`rm` + `cp` 之前先调用 `ensureSkillLinks`**（同 §5.1 的顺序理由：上游新版本还没落地时比较才有意义）；
- clone 与许可证目录（`.agents/direct/<sourceId>`、`.agents/licenses/`）保持单副本现状不变。

### 5.5 启动补齐

- CLI：`dispatchAgent`（`packages/cli/src/cli/dispatcher.mjs:238-297`）在 `launchExecutable` 之前、会话适配器收尾之后调用 `ensureSkillLinks(context, await managedSkillNames(context), { silent: true })`。
- 插件：`prepareAgentLaunch`（`packages/vscode/src/services/agents.ts:97-163`）同样调用。
- **触发条件**：canonical 目录存在且受管集合非空；未安装 Skills 的项目不产生任何副作用（不创建 `.claude/skills`、不写任何文件）。
- 发生修复时打印一行说明（CLI）或状态栏提示（插件）；**失败绝不影响启动**。

### 5.6 状态与修复

见 §8。

## 6. 受管集合（A4：启动补齐不得接管外来 Skill）

`.agents/skills/` 里可能存在四类内容：

| 类别 | 记录位置 | 是否受管 |
|---|---|---|
| Pack 安装 | `lock.sources[].skills`（`install.mjs:134-140`） | 是 |
| adopted 接管 | `lock.adopted`（`install.mjs:286-290`） | 是 |
| 直装 | `lock.directSources[].skills`（`direct.mjs:33-48`） | 是 |
| 用户手工放入 | 无任何记录 | **否** |

新增 core 函数（`install.mjs`，复用既有读锁代码）：

```js
export async function managedSkillNames(context) {
  const pack = await previousManagedState(context);                 // lock.sources[].skills
  const lock = existsSync(context.lockFile) ? await readJson(context.lockFile) : {};
  return new Set([
    ...pack.keys(),
    ...(lock.adopted ?? []),
    ...(lock.directSources ?? []).flatMap((source) => source.skills ?? []),
  ]);
}
```

- `ensureSkillLinks` **只处理传入的受管名字**，绝不枚举目录后全量链接；安装路径传本次安装的技能名，启动补齐传 `managedSkillNames()`。
- 未受管条目：既不建链接也不删除。状态里单独给出计数（`unmanaged`）与"为什么没被共享"的提示（可执行 `avenic skills adopt` 接管）。
- 锁文件不存在 ⇒ 受管集合为空 ⇒ 启动补齐不动作（未安装过 Skills 的项目零副作用）。

## 7. `sameTree` 精确定义（A5）

只用于一个判断：`shareFrom` target 下的**真实目录**是否可以安全地当作 canonical 的副本删除并换成链接。任何不确定都返回 `false`（→ conflict，不删）。

```js
// packages/core/src/skills/links.mjs
async function sameTree(left, right) → boolean
```

规则：

1. 两侧 `lstat`：类型必须相同（都是目录才继续；一侧缺失/一侧非目录 → `false`）。
2. 逐层 `readdir(..., { withFileTypes: true })`，比较**排序后的条目名集合**；集合不同 → `false`。
3. 逐条目比较 **entry type**：
   - 两侧都是目录 → 递归；
   - 两侧都是文件 → 先比 `size`，不同即 `false`；相同再比 `hashContent`（`sessions.mjs:166`，sha256）；
   - 两侧都是链接 → 比较 `readlink` 结果（各自的 target 解析后经 `samePath`）；一侧链接一侧不是 → `false`；
   - 其他类型（FIFO/设备/未知）→ `false`。
4. **不跟随**内部链接递归：链接只比较 target 字符串，因此比较过程不可能逃逸出 Skill 根目录（也避免 link 环导致的无限递归）。
5. 任何异常（`EACCES`/`EPERM`/`ENOENT`/`EIO`/`ELOOP`）→ `false`。
6. 路径比较一律用 `samePath`（win32 大小写不敏感），**不做字符串裸 `===`**；比较链接 target 前同样剥 Windows `\\?\` 前缀、相对 target 先 `path.resolve`。
7. 文件内容相同的两个真实目录（哪怕一个是硬链接）判为相同——这正是我们要的语义（内容一致 ⇒ 可无损换成链接）。

## 8. 状态语义（A3：fallback 是合法降级，不是失败）

`skillsInstallationStatus`（`install.mjs:420-437`）返回值扩展（保留现有字段以免大面积破坏调用方）：

| 字段 | 含义 |
|---|---|
| `targets[].present` / `total` | 该 target 下"可用"的技能数（链接可用或真实副本可用都计入） |
| `targets[].state` | shareFrom：`linked` / `fallback` / `missing` / `conflict`（多数决：只要有一个 conflict 即 `conflict`，否则全 linked 即 `linked`，否则有 fallback 即 `fallback`）；canonical：`canonical` |
| `targets[].counts` | shareFrom 下 `{linked, fallback, missing, conflict, unmanaged}`；canonical 下 `{present, total}`。**`migrated` 只是安装期动作计数**（§5.1），状态查询不做 `sameTree` 内容比较（只读、廉价），因此"真实目录"在状态里一律记 `fallback`（可用但未共享）——内容是否一致由下一次安装判定（一致→迁移，不一致→conflict） |
| `targets[].complete` | **operational**：canonical 完整，且 shareFrom 下每个受管技能都是 `linked` 或 `fallback`（即"能正常工作"） |
| `operational` | 所有 target `complete` |
| `optimized` | operational 且 shareFrom 下受管技能全部 `linked`（磁盘上确实只有一份） |
| `degraded` | operational 但存在 `fallback` |
| `incomplete` | 存在 `missing` 或 `conflict` |

对应文案：

- CLI `avenic skills status`：
  - `linked` → `Claude Code   Shared via .agents/skills (N links)`
  - `fallback` → `Claude Code   Available — copies, not shared (N) · run: avenic skills install`（**不是失败**）
  - `missing` → `⚠ Claude Code   Links missing — run: avenic skills install`
  - `conflict` → 列出冲突技能名与原因（§3.2 / §5.1），提示手工处理
- 插件：`state`/`degraded` 映射为"可用但未共享"的提示样式；新增命令 `avenic.skills.repairLinks`（标题「Avenic: 修复 Skills 链接」）只调用 core 的 `ensureSkillLinks`，插件侧保持零 fs 逻辑。

## 9. 安全不变量（实现必须遵守）

1. 任何对 target 内容的读/写/删之前先 `lstat`；`isSymbolicLink()` 为真即视为链接，**绝不当普通目录递归**。
2. 链接只能用 `unlink` 删除；禁止对链接路径使用 `rm -rf`。
3. 自动流程下删除真实副本只发生在 `sameTree === true` 这一种情况（§5.1 的"迁移"行）；用户按名显式移除时按 §5.2 的表处理（shareFrom target 内、名字即授权）。
4. 写入 canonical 前必须通过 `isInside(canonicalDestination, target)` 校验（沿用 `util/fs.mjs:5-8`）。
5. **绝不递归删除 `.claude/skills` / `.agents/skills` 目录本身**（仅当它是空的普通目录时才可由 `removeEmptyDirectory` 移除）。
6. 创建链接前确认 canonical 存在、是普通目录（`lstat` 非链接）。
7. 链接指向非 canonical 的路径时，任何流程（安装/卸载/接管/启动补齐/状态）都不得动它。
8. 链接操作失败不得中断安装与启动，按 §10 降级。

## 10. 降级与错误处理

| 情况 | 处理 |
|---|---|
| 建链失败（`EPERM` / `ENOTSUP` / `EXDEV` / 网络盘 / 非 NTFS） | 该技能退回拷贝（当前行为），输出 `⚠ Cannot create shared link (reason) — copied instead`，状态标 `fallback` |
| canonical 被外部删除，链接悬空 | 视为 `repair`：重建；canonical 也不存在则解除链接并降级拷贝 |
| 副本内容与 canonical 不一致 | 不阻断其他技能，安装继续，状态标 `conflict` **且保留副本** |
| canonical 目录不存在 | shareFrom target 不做任何事（不创建空目录、不建链接） |
| canonical 存在但缺少某个技能 | 该技能不建链接（避免悬空），不影响其他技能 |
| 启动补齐失败 | 打印一行警告后照常启动 Agent |

## 11. 一致性检查（install / update / migration / fallback / uninstall / direct / adopt / launch repair / status）

同一套语义在九条路径上的落地：

| 路径 | 入口 | 受管集合来源 | 链接判定 | 真实副本删除条件 |
|---|---|---|---|---|
| 安装 | `installPacks` → `installCopies` | 本次选中技能 | §3.2 | `sameTree === true` |
| 更新 | 同上（revision 变化） | 本次选中技能 | §3.2 | 同上（先预检后改 canonical） |
| 迁移（旧双份布局） | 同上，预检趟 | 本次选中技能 | §3.2 | 同上 |
| 降级（fallback） | `ensureSkillLinks` 内 | — | 建链失败 → `cp` | 不删 |
| 卸载 | `removeAllManagedSkills` / `removeSkillDirectories` | 传入的受管名单 | lstat → unlink | 只在 canonical 侧 |
| 直装 | `addDirectSkills` / `removeExternalSkills` | 直装名单 | §3.2（cp 前预检） | `sameTree === true` |
| 接管 | `adoptSkills` / `adoptPackedSkills` | 接管名单 | §3.2（不覆盖已存在） | `sameTree === true` |
| 启动补齐 | `dispatchAgent` / `prepareAgentLaunch` | `managedSkillNames()` | §3.2 | `sameTree === true` |
| 状态 | `skillsInstallationStatus` | 锁文件 | 只读判定 | 不删 |

## 12. 影响面

| 位置 | 改动 |
|---|---|
| `packages/core/src/skills/links.mjs` | **新增**：`ensureSkillLinks`、`classifyShareEntry`、`sameTree`、`removeLinkSafely`、平台分支（junction / relative symlink）、Windows `\\?\` 前缀处理 |
| `packages/core/src/skills/paths.mjs` | targets 表加 `id` + `shareFrom`（顺序不变） |
| `packages/core/src/skills/install.mjs` | `installCopies`（三趟顺序）、`removeAllManagedSkills`、`removeSkillDirectories`、`adoptSkills`、`skillsInstallationStatus`（§8 字段）、`writeInstallMetadata`（agents 排序）、新增 `managedSkillNames` |
| `packages/core/src/skills/direct.mjs` | `addDirectSkills`（cp 前预检 + 建链）、`removeExternalSkills` |
| `packages/core/src/index.mjs`、`packages/core/index.d.ts` | 导出 `ensureSkillLinks`、`managedSkillNames`；`InstallTarget`（`index.d.ts:160-167`）与 `InstallStatus.targets`（`:308-314`）加 `id`/`shareFrom`/`state`/`counts` 可选字段 |
| `packages/cli/src/cli/skills-cli.mjs` | 状态与摘要文案（§8，`commandStatus` 在 `:418-431`）；顺带删除 `:72` 未被调用的 `writeInstallMetadata` 死导入 |
| `packages/cli/src/cli/dispatcher.mjs` | 启动补齐（`:295-297` 之前） |
| `packages/cli/vendor/core-src/**` | `npm run sync-core` 同步（`test/sync.test.mjs:25-31` 守护；`pretest` 会自动跑） |
| `packages/vscode/src/services/skills.ts`、`services/agents.ts:97-163`、`commands/skills-commands.ts`、`dashboard/state.ts:12-29`、`views/view-models.ts:199-207`、`package.json`、`views/**` | 状态映射、启动补齐、新命令 `avenic.skills.repairLinks` |
| `packages/core/src/runtime/gitignore.mjs` | **不改**（两个目录本就忽略；`test/runtime.test.mjs:167-175` 断言 `REQUIRED_RULES` 逐条出现一次，是这条的守卫） |
| `integration/global-install.mjs:107-145` | 项目/全局安装断言从"两处真实拷贝"改为"canonical 真身 + 链接"（经 `npm run test:install` 运行） |
| 文档 | README×2、`packages/cli/README.md`、`docs/development.md`、`packages/vscode/CHANGELOG.md` |
| **不改** | `packages/vscode/.test-out/**`（`build-tests.mjs` 生成的编译镜像，`packages/vscode/.gitignore:2` 已忽略） |

## 13. 测试

新增（TDD）：

- `links` 单元：`classifyShareEntry` 的五种现场（不存在 / 正确链接 / 悬空但 target 正确 / 指向别处 / 真实目录）；`sameTree` 相同、内容不同、多文件不同、空目录、内部链接相同与不同、一侧缺失、权限错误；链接 target 剥离 `\\?\`、相对 target 解析；`removeLinkSafely` 只删链接（真身存活）。
- **A1 回归测试（用户指定）**：`fallback copy from previous install → new version install` —— 先注入建链失败制造 fallback 副本，再升级同一 Skill 到新版本重新安装，断言：结果是链接、`conflict === 0`、canonical 是新版本内容。
- **A2 回归测试（用户指定）**：`.claude/skills/foo` 是用户自建 link 指向 `/some/user/path/foo` → `avenic skills install` 后该链接**原样保留**且状态报 `conflict`。
- 迁移：两份内容相同 → 删副本建链接；内容不同 → 保留 + `conflict`。
- 卸载：链接解除 + 真身删除；同名外来技能（非受管）不受影响。
- 启动补齐：`.agents/skills` 含未受管技能时不被链接（`managedSkillNames` 过滤）；未安装 Skills 的项目零副作用。
- 降级：注入建链失败 → 退回拷贝、不抛错、状态 `fallback` 且 `operational === true` / `degraded === true`。
- 跨平台：Windows 断言 junction、POSIX 断言相对 symlink（`process.platform` 分支）。

需按新语义修改的既有断言（"两个目录都有真实拷贝" → "canonical 有真身、另一处是链接"）。**注意：读取 `.claude/skills/<name>/SKILL.md` 的断言穿透链接后照常通过**，因此要改的是"真实目录 / 删除语义 / target 计数"这三类断言：

| 文件 | 需修改的断言 |
|---|---|
| `test/skills.test.mjs` | `:85,91-93`（安装后目录存在）、`:107-118`（外部技能清理：`rm -rf` → unlink）、`:134-143`、`:189-209`（`targets[0].complete===true`/`targets[1].complete===false` —— 语义变为"canonical 完整 + shareFrom 可用"）、`:253-274`、`:276-305`（`targets[0].destination` 的真身/删除） |
| `test/skills-adopt.test.mjs` | `:18-34`（`placed===1` + `.claude` "真实副本" 内容）、`:37-48`、`:50-62`、`:64-75`（`targets.every(complete)`） |
| `test/skills-detected.test.mjs` | `:17-31`、`:33-42`（同名同时在两个 target → 链接与真身必须去重为 1）、`:44-59` |
| `test/skills-packadopt.test.mjs` | `:89-118`（loop 断言两个 target 都有 `SKILL.md`；读穿透链接仍通过，但"真实目录"判定要改）、`:120-144`、`:146-158` |
| `test/skills-direct-add.test.mjs` | `:74-99`、`:101-119`、`:167-193`（`targets[0].destination` 真实目录 `d-skill` 由 `removeExternalSkills` 删除 → 改为 unlink 语义） |
| `test/cli-surface.test.mjs` | `:105-124`、`:299-313`、`:343-366`（status 输出文案）、`:544-575`（`Placed targets: 1` + `.claude` 副本）、`:577-605` |
| `test/cli-prompts.test.mjs` | `:250-285`（`.agents/skills` 磁盘断言） |
| `packages/vscode/test/skills-commands.test.ts` | `:214-222`（`expectSkillDirs` 硬编码两个目录都要真实目录）、`:123-146`、`:172-212` |
| `packages/vscode/test/dashboard.test.ts`、`view-models.test.ts` | `dashboard.test.ts:99-117`（4 行 agent 状态、`details==="1/1"`）、`view-models.test.ts:103-131`（`InstallStatus` mock 的 `targets` 形状与"安装目标 N/M"聚合） |
| `integration/global-install.mjs` | `:107-145`（项目/全局安装的双拷贝断言） |

`test/runtime.test.mjs`（gitignore）、`test/sync.test.mjs`、`test/packaging.test.mjs:54-68`（d.ts 符号表）**不需要**改动语义，只在导出名变化时同步。

## 14. 发布

1. bump `packages/core`（新增导出 + 行为变更）→ 发布 `@avenic/core`；
2. `npm run sync-core` → bump `packages/cli` → 发布 `avenic`；
3. bump `packages/vscode`（依赖新 core + 新命令）→ 打包 VSIX（Marketplace 上传按 USER CHECKPOINT 规则）。

## 15. 明确不做

- 不做整目录链接、硬链接 / reflink；
- 不改 `.gitignore` 规则、不引入新的 Git 提交策略；
- 不为 Codex/OpenCode 做链接（它们读 canonical，无需链接）；
- **不接管 `.agents/skills` 中未受管的技能**（可显式 `avenic skills adopt`）；
- 不自动删除内容冲突的用户副本、不动指向别处的用户链接；
- 不做链接 ownership 元数据（§3.2）；
- 不做后台守护或定时修复（仅在安装与启动时补齐）。

## 16. 开放问题

无。§11 的九条路径共用同一套语义；`sameTree` 与链接判定已在本机实测语义上定死（§2/§3.2/§7）。
