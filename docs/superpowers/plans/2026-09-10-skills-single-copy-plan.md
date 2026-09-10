# Skills 单副本共享（A）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让同一个作用域内的每个 Skill 只保留一份物理文件（`.agents/skills/<name>`），`.claude/skills/<name>` 变成指向它的链接，并在安装、更新、迁移、降级、卸载、直装、接管、启动补齐、状态九条路径上共用同一套"链接归属 / 真实副本删除"语义。

**Architecture:** 新增 `packages/core/src/skills/links.mjs` 承载全部链接原语（归属判定 `classifyShareEntry`、内容比较 `sameTree`、建链/解链、`ensureSkillLinks`）。`PROJECT_TARGETS`/`GLOBAL_TARGETS` 增加 `id` 与 `shareFrom`，由 `createInstallContext` 解析出 `shareDestination`。`installCopies` 改为四阶段（预检迁移 → canonical 安装 → 补链 → shareFrom 陈旧解链），使"上一次安装留下的 fallback 副本"能先与**旧 canonical** 比较再被迁移，而不是被误判成用户手改的冲突。CLI 与插件都只调用 core，插件侧零 fs 业务逻辑。

**Tech Stack:** Node ≥18.17（ESM、`node:fs/promises`）、`node --test`、Windows junction / POSIX 相对符号链接、VS Code 扩展（TypeScript + esbuild）。

**Spec:** `docs/superpowers/specs/2026-09-10-skills-single-copy-design.md`（commit `9537202`，修订版 2）

## Global Constraints

- 本计划只做 A（Skills 单副本）。B（本机模型配置库 + 项目绑定）是独立计划，**A/B 绝不混在同一次提交**。
- 平台：Windows（junction）与 POSIX（相对符号链接）都要正确；任何删除操作前先 `lstat`。
- 路径比较一律用 `samePath`（win32 大小写不敏感），**不做裸字符串 `===`**；比较 Windows 链接 target 前剥 `\\?\` 前缀。
- 自动流程只在 `sameTree === true` 时删除真实副本；用户按名显式移除时保留今天的删除语义（详见 spec §5.2）。
- **绝不 unlink 指向别处的链接**（安装、启动补齐、状态、显式移除四条路径一致）。
- 状态查询只读且廉价：不做 `sameTree` 内容比较（真实目录一律记 `fallback`）。
- 版本顺序：`packages/core` bump → 发布 → `npm run sync-core` → `packages/cli` bump → 发布 → `packages/vscode` 依赖提升 + 实现 → 打包 VSIX。**发布 npm 包与上传 Marketplace 都是 USER CHECKPOINT**。
- **`0.1.10` VSIX 已由用户上传 Marketplace，本计划任何步骤都不得再次上传或操作 0.1.10**；新版本号为 `0.1.11`。
- `packages/core/index.d.ts` 与 `packages/core/src/index.mjs` 必须在同一次提交里同步更新（`test/packaging.test.mjs:54-68` 断言符号存在）。
- `packages/cli/vendor/core-src/**` 由 `npm run sync-core` 生成，**不得手工编辑**；根目录 `npm test` 的 `pretest` 会自动同步，`test/sync.test.mjs:25-31` 守护字节一致。
- 不改 `.gitignore` 规则（两个 skills 目录本就忽略），不动 `packages/vscode/.test-out/**`（生成物）。
- 测试一律使用临时目录（`mkdtemp`）与 `AVENIC_STATE_DIR` 隔离，**禁止写入真实用户主目录**。
- 每个 Task 结束时测试套件必须全绿；提交信息使用仓库现有风格（`feat:` / `fix:` / `test:` / `chore:`）。

## 文件结构

| 文件 | 职责 |
|---|---|
| `packages/core/src/skills/links.mjs`（新增） | 链接原语：`normalizeLinkTarget`、`readLinkTarget`、`createSkillLink`、`removeLinkSafely`、`classifyShareEntry`、`sameTree`、`ensureSkillLinks`、`canonicalTargets`、`formatLinkSummary` |
| `packages/core/src/skills/paths.mjs` | targets 表加 `id` / `shareFrom`；新增 `MANAGED_AGENT_ORDER` |
| `packages/core/src/skills/install.mjs` | `createInstallContext` 解析 `shareDestination`；`installCopies` 四阶段；`removeAllManagedSkills`/`removeSkillDirectories` 解链语义；`adoptSkills` 建链；新增 `managedSkillNames`；`skillsInstallationStatus` 新字段 |
| `packages/core/src/skills/direct.mjs` | `addDirectSkills` 预检 + 只写 canonical + 补链 |
| `packages/core/src/index.mjs`、`packages/core/index.d.ts` | 导出与类型 |
| `packages/cli/src/cli/dispatcher.mjs` | 启动补齐（`launchExecutable` 之前） |
| `packages/cli/src/cli/skills-cli.mjs` | `skills status` 文案；清理死导入 |
| `packages/vscode/src/**`（Task 10） | 服务层 `repairLinks`、命令、启动补齐、状态映射 |
| `test/skills-links.test.mjs`、`test/skills-single-copy.test.mjs`（新增） | 链接原语单测、端到端安装/迁移/降级回归 |

---

### Task 1: targets 表加 `id` / `shareFrom`，解析 `shareDestination`，agents 输出用显式常量

**Files:**
- Modify: `packages/core/src/skills/paths.mjs:23-30`、`:69-80`
- Modify: `packages/core/src/skills/install.mjs:33-61`、`:133`
- Modify: `packages/core/index.d.ts:160-167`
- Test: `test/skills-targets.test.mjs`（新增）

**Interfaces:**
- Consumes: 无（本计划第一个任务）
- Produces:
  - `PROJECT_TARGETS: Array<{ id: string; agents: string[]; label: string; relativePath: string[]; shareFrom?: string }>`
  - `GLOBAL_TARGETS: Array<{ id: string; agents: string[]; label: string; destination: string; shareFrom?: string }>`
  - `MANAGED_AGENT_ORDER: string[]`（值为 `["claude-code","codex","opencode"]`）
  - `createInstallContext(...)` 返回的 `targets[]` 上，带 `shareFrom` 的 target 多一个 `shareDestination: string`（canonical 目录的绝对路径）

- [ ] **Step 1: 写失败测试**

创建 `test/skills-targets.test.mjs`：

```js
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MANAGED_AGENT_ORDER,
  createInstallContext,
  readJson,
  writeInstallMetadata,
} from "../packages/core/src/index.mjs";

test("targets carry ids and the claude target shares from agents", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "avenic-targets-"));
  try {
    const context = createInstallContext(false, { cwd, environment: process.env });
    const ids = context.targets.map((target) => target.id);
    assert.deepEqual(ids, ["claude", "agents"]);
    assert.equal(new Set(ids).size, ids.length);
    const claude = context.targets.find((target) => target.id === "claude");
    assert.equal(claude.shareFrom, "agents");
    assert.equal(claude.shareDestination, path.join(cwd, ".agents", "skills"));
    const agents = context.targets.find((target) => target.id === "agents");
    assert.equal(agents.shareFrom, undefined);
    assert.equal(agents.shareDestination, undefined);
    assert.equal(claude.destination, path.join(cwd, ".claude", "skills"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("global context resolves the share destination under the home directory", () => {
  const context = createInstallContext(true, { environment: process.env });
  const claude = context.targets.find((target) => target.id === "claude");
  assert.equal(claude.shareDestination, path.join(os.homedir(), ".agents", "skills"));
});

test("lock agents field uses the managed agent order, not table order", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "avenic-agents-"));
  try {
    const context = createInstallContext(false, { cwd, environment: process.env });
    await writeInstallMetadata(context, { packs: [], groups: [] });
    const lock = await readJson(context.lockFile);
    assert.deepEqual(lock.agents, [...MANAGED_AGENT_ORDER]);
    assert.deepEqual(lock.agents, ["claude-code", "codex", "opencode"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/skills-targets.test.mjs`
Expected: FAIL —`MANAGED_AGENT_ORDER` 未导出（`SyntaxError`/`undefined`），`target.id` 为 `undefined`

- [ ] **Step 3: 实现**

`packages/core/src/skills/paths.mjs` —— 替换两个 targets 表（第 23-30 行、第 69-80 行）：

```js
// 锁文件里 agents 字段的规范顺序：与表顺序解耦，避免调整 targets 顺序时改写锁文件字节。
export const MANAGED_AGENT_ORDER = ["claude-code", "codex", "opencode"];

export const PROJECT_TARGETS = [
  {
    id: "claude",
    agents: ["claude-code"],
    label: "Claude Code",
    relativePath: [".claude", "skills"],
    shareFrom: "agents",
  },
  {
    id: "agents",
    agents: ["codex", "opencode", "universal"],
    label: "Codex / OpenCode / universal agents",
    relativePath: [".agents", "skills"],
  },
];

export const GLOBAL_TARGETS = [
  {
    id: "claude",
    agents: ["claude-code"],
    label: "Claude Code",
    destination: path.join(os.homedir(), ".claude", "skills"),
    shareFrom: "agents",
  },
  {
    id: "agents",
    agents: ["codex", "opencode", "universal"],
    label: "Codex / OpenCode / universal agents",
    destination: path.join(os.homedir(), ".agents", "skills"),
  },
];
```

`packages/core/src/skills/install.mjs` —— 顶部导入加 `MANAGED_AGENT_ORDER`（加进 `./paths.mjs` 的导入列表），在 `createInstallContext` 之前加：

```js
// 解析 shareFrom → shareDestination（同表内另一个 target 的绝对目录）。
// 解析失败直接 fail：表写错是开发期错误，不能静默降级成"每个 target 各存一份"。
function withShareDestinations(targets, label) {
  const byId = new Map(targets.map((target) => [target.id, target]));
  return targets.map((target) => {
    if (!target.shareFrom) {
      return target;
    }
    const canonical = byId.get(target.shareFrom);
    if (!canonical?.destination) {
      fail(`${label} skill target "${target.id}" references an unknown share source "${target.shareFrom}"`);
    }
    return { ...target, shareDestination: canonical.destination };
  });
}
```

`createInstallContext` 里两个分支都走它：

```js
  if (global) {
    return {
      configFile: globalConfigFile(environment),
      environment,
      global: true,
      label: "Global",
      lockFile: globalLockFile(environment),
      root: environment.USERPROFILE || environment.HOME || os.homedir(),
      targets: withShareDestinations(GLOBAL_TARGETS, "Global"),
    };
  }
  migrateLegacyProjectFiles(cwd);
  const projectTargets = PROJECT_TARGETS.map((target) => ({
    ...target,
    destination: path.join(cwd, ...target.relativePath),
  }));
  return {
    configFile: path.join(cwd, PROJECT_CONFIG_FILE),
    environment,
    global: false,
    label: "Project",
    legacyProfileFile: path.join(cwd, LEGACY_PROFILE_FILE),
    lockFile: path.join(cwd, PROJECT_LOCK_FILE),
    root: cwd,
    targets: withShareDestinations(projectTargets, "Project"),
  };
```

`writeInstallMetadata` 第 133 行改为：

```js
    agents: [...MANAGED_AGENT_ORDER],
```

`packages/core/index.d.ts` —— 第 160-167 行改为：

```ts
export interface InstallTarget {
  id: string;
  agents: string[];
  label: string;
  destination: string;
  relativePath?: string[];
  shareFrom?: string;
  shareDestination?: string;
}
export const MANAGED_AGENT_ORDER: string[];
export const PROJECT_TARGETS: Array<{ id: string; agents: string[]; label: string; relativePath: string[]; shareFrom?: string }>;
export const GLOBAL_TARGETS: InstallTarget[];
```

`packages/core/src/index.mjs` —— 在 `./skills/paths.mjs` 的导出块里加 `MANAGED_AGENT_ORDER,`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/skills-targets.test.mjs`
Expected: PASS（3 个用例）

- [ ] **Step 5: 跑全量测试确认没有破坏既有断言**

Run: `npm test`（`pretest` 会先 `sync-core`）
Expected: 全绿。若 `test/packaging.test.mjs` 或 d.ts 相关断言失败，检查符号名拼写。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/skills/paths.mjs packages/core/src/skills/install.mjs packages/core/src/index.mjs packages/core/index.d.ts packages/cli/vendor/core-src test/skills-targets.test.mjs
git commit -m "feat(core): skill targets carry id + shareFrom, resolve shareDestination; fixed agents order in lock"
```

---

### Task 2: `links.mjs` 链接原语（归属判定 / sameTree / 建链 / 解链）

**Files:**
- Create: `packages/core/src/skills/links.mjs`
- Modify: `packages/core/src/index.mjs`、`packages/core/index.d.ts`
- Test: `test/skills-links.test.mjs`（新增）

**Interfaces:**
- Consumes: `samePath`、`hashContent`（`../runtime/sessions.mjs`）；`fail`（`../util/fail.mjs`）；`isInside`（`../util/fs.mjs`）
- Produces:
  - `normalizeLinkTarget(linkPath: string, rawTarget: string): string`
  - `readLinkTarget(linkPath: string): Promise<string | null>`
  - `createSkillLink(canonicalPath: string, linkPath: string): Promise<void>`
  - `removeLinkSafely(linkPath: string): Promise<boolean>`
  - `classifyShareEntry(canonicalPath: string, linkPath: string): Promise<{ state: "absent" | "linked" | "repair" | "real-directory" | "conflict"; reason?: string; target?: string }>`
  - `sameTree(left: string, right: string): Promise<boolean>`
  - `canonicalTargets(context): InstallTarget[]`、`shareTargets(context): InstallTarget[]`

- [ ] **Step 1: 写失败测试**

创建 `test/skills-links.test.mjs`：

```js
import assert from "node:assert/strict";
import { lstatSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalTargets,
  classifyShareEntry,
  createInstallContext,
  createSkillLink,
  removeLinkSafely,
  sameTree,
  shareTargets,
} from "../packages/core/src/index.mjs";

async function withTempDirectory(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeSkill(root, name, content = `# ${name}\n`) {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), content);
  return directory;
}

// 用户自建链接（不是 avenic 建的）：Windows 用 junction（绝对路径），POSIX 用相对符号链接。
async function linkUserSkill(targetPath, linkPath) {
  await mkdir(path.dirname(linkPath), { recursive: true });
  if (process.platform === "win32") {
    await symlink(path.resolve(targetPath), linkPath, "junction");
  } else {
    await symlink(path.relative(path.dirname(linkPath), targetPath), linkPath, "dir");
  }
}

test("canonicalTargets / shareTargets split the table", async () => {
  await withTempDirectory("avenic-split-", async (cwd) => {
    const context = createInstallContext(false, { cwd, environment: process.env });
    assert.deepEqual(canonicalTargets(context).map((t) => t.id), ["agents"]);
    assert.deepEqual(shareTargets(context).map((t) => t.id), ["claude"]);
  });
});

test("createSkillLink produces a link that classifyShareEntry reports as linked", async () => {
  await withTempDirectory("avenic-link-", async (root) => {
    const canonicalRoot = path.join(root, "canonical");
    const shareRoot = path.join(root, "share");
    const canonical = await writeSkill(canonicalRoot, "alpha");
    const linkPath = path.join(shareRoot, "alpha");
    await createSkillLink(canonical, linkPath);
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true);
    assert.equal(readlinkSync(linkPath).length > 0, true);
    assert.deepEqual(await classifyShareEntry(canonical, linkPath), { state: "linked" });
  });
});

test("classifyShareEntry distinguishes foreign links, dangling links, real dirs and absent entries", async () => {
  await withTempDirectory("avenic-classify-", async (root) => {
    const canonicalRoot = path.join(root, "canonical");
    const shareRoot = path.join(root, "share");
    const canonical = await writeSkill(canonicalRoot, "alpha");
    const userTarget = await writeSkill(path.join(root, "user"), "alpha");

    const foreign = path.join(shareRoot, "foreign");
    await linkUserSkill(userTarget, foreign);
    const foreignVerdict = await classifyShareEntry(canonical, foreign);
    assert.equal(foreignVerdict.state, "conflict");
    assert.equal(foreignVerdict.reason, "points-elsewhere");

    const dangling = path.join(shareRoot, "dangling");
    await createSkillLink(canonical, dangling);
    await rm(canonical, { recursive: true, force: true });
    assert.equal((await classifyShareEntry(canonical, dangling)).state, "repair");

    await writeSkill(canonicalRoot, "alpha");
    const real = await writeSkill(shareRoot, "real");
    assert.equal((await classifyShareEntry(canonical, real)).state, "real-directory");

    assert.equal((await classifyShareEntry(canonical, path.join(shareRoot, "nothing"))).state, "absent");
  });
});

test("sameTree compares content, entry types and link targets without following links", async () => {
  await withTempDirectory("avenic-sametree-", async (root) => {
    const left = await writeSkill(path.join(root, "left"), "alpha", "# same\n");
    await mkdir(path.join(left, "nested"), { recursive: true });
    await writeFile(path.join(left, "nested", "extra.md"), "x");
    const right = path.join(root, "right", "alpha");
    await mkdir(path.join(right, "nested"), { recursive: true });
    await writeFile(path.join(right, "SKILL.md"), "# same\n");
    await writeFile(path.join(right, "nested", "extra.md"), "x");
    assert.equal(await sameTree(left, right), true);

    await writeFile(path.join(right, "nested", "extra.md"), "y");
    assert.equal(await sameTree(left, right), false, "same size, different content");

    await writeFile(path.join(right, "nested", "extra.md"), "longer-content");
    assert.equal(await sameTree(left, right), false, "different size");

    await rm(path.join(right, "nested"), { recursive: true, force: true });
    assert.equal(await sameTree(left, right), false, "entry set differs");

    await mkdir(path.join(right, "nested"), { recursive: true });
    await writeFile(path.join(right, "nested", "extra.md"), "x");
    const external = await writeSkill(path.join(root, "external"), "target");
    await linkUserSkill(external, path.join(left, "link-entry"));
    await linkUserSkill(external, path.join(right, "link-entry"));
    assert.equal(await sameTree(left, right), true, "identical internal link targets");

    await rm(path.join(right, "link-entry"));
    await linkUserSkill(path.join(root, "external", "other"), path.join(right, "link-entry"));
    assert.equal(await sameTree(left, right), false, "different internal link target");

    assert.equal(await sameTree(left, path.join(root, "missing")), false);
  });
});

test("removeLinkSafely removes only links and leaves the target intact", async () => {
  await withTempDirectory("avenic-remove-", async (root) => {
    const canonical = await writeSkill(path.join(root, "canonical"), "alpha");
    const linkPath = path.join(root, "share", "alpha");
    await createSkillLink(canonical, linkPath);
    assert.equal(await removeLinkSafely(linkPath), true);
    assert.equal(lstatSync(canonical).isDirectory(), true);
    assert.equal(lstatSync(path.join(canonical, "SKILL.md")).isFile(), true);
    assert.equal(await removeLinkSafely(canonical), false, "real directories are not unlinked");
    await unlink(linkPath).catch(() => {});
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/skills-links.test.mjs`
Expected: FAIL — `packages/core/src/skills/links.mjs` 不存在 / 导出为 `undefined`

- [ ] **Step 3: 实现 `packages/core/src/skills/links.mjs`**

```js
import { existsSync, lstatSync } from "node:fs";
import { cp, mkdir, readFile, readdir, readlink, realpath, rm, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { hashContent, samePath } from "../runtime/sessions.mjs";

// Windows 的 junction 经 readlink 返回带 \\?\ 前缀的绝对路径；比较前必须剥掉。
const WINDOWS_PREFIX = /^\\\\\?\\/;

export function canonicalTargets(context) {
  return context.targets.filter((target) => !target.shareFrom);
}

export function shareTargets(context) {
  return context.targets.filter((target) => Boolean(target.shareFrom));
}

export function normalizeLinkTarget(linkPath, rawTarget) {
  const stripped = rawTarget.replace(WINDOWS_PREFIX, "");
  return path.resolve(path.dirname(linkPath), stripped);
}

export async function readLinkTarget(linkPath) {
  try {
    return normalizeLinkTarget(linkPath, await readlink(linkPath));
  } catch {
    return null;
  }
}

export async function createSkillLink(canonicalPath, linkPath) {
  await mkdir(path.dirname(linkPath), { recursive: true });
  if (process.platform === "win32") {
    // junction 要求绝对路径；不需要管理员权限。
    await symlink(path.resolve(canonicalPath), linkPath, "junction");
    return;
  }
  // 相对符号链接：项目整体移动后仍然有效。
  await symlink(path.relative(path.dirname(linkPath), canonicalPath), linkPath, "dir");
}

export async function removeLinkSafely(linkPath) {
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) {
      return false;
    }
  } catch {
    return false;
  }
  await unlink(linkPath);
  return true;
}

async function realpathOrNull(target) {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

// 只回答一个问题：这个位置上的东西，能不能被当成"avenic 自己的布局"处理。
// 判定一律走 samePath（win32 大小写不敏感），不按文件名猜；不确定就 conflict。
export async function classifyShareEntry(canonicalPath, linkPath) {
  let stats;
  try {
    stats = lstatSync(linkPath);
  } catch {
    return { state: "absent" };
  }
  if (!stats.isSymbolicLink()) {
    return { state: "real-directory" };
  }
  const target = await readLinkTarget(linkPath);
  if (!target) {
    return { state: "conflict", reason: "unreadable-link" };
  }
  if (samePath(target, canonicalPath)) {
    let canonical;
    try {
      canonical = lstatSync(canonicalPath);
    } catch {
      return { state: "repair", reason: "dangling" };
    }
    if (!canonical.isDirectory() || canonical.isSymbolicLink()) {
      return { state: "repair", reason: "canonical-not-directory" };
    }
    return { state: "linked" };
  }
  const [resolvedLink, resolvedCanonical] = [await realpathOrNull(linkPath), await realpathOrNull(canonicalPath)];
  if (resolvedLink && resolvedCanonical && samePath(resolvedLink, resolvedCanonical)) {
    return { state: "linked" };
  }
  return { state: "conflict", reason: "points-elsewhere", target };
}

async function sameEntry(left, right) {
  try {
    const [leftStats, rightStats] = [lstatSync(left), lstatSync(right)];
    if (leftStats.isSymbolicLink() || rightStats.isSymbolicLink()) {
      if (!(leftStats.isSymbolicLink() && rightStats.isSymbolicLink())) {
        return false;
      }
      const [leftTarget, rightTarget] = [await readLinkTarget(left), await readLinkTarget(right)];
      return Boolean(leftTarget && rightTarget && samePath(leftTarget, rightTarget));
    }
    if (leftStats.isDirectory() !== rightStats.isDirectory()) {
      return false;
    }
    if (leftStats.isDirectory()) {
      return sameTree(left, right);
    }
    if (!leftStats.isFile() || !rightStats.isFile()) {
      return false;
    }
    if (leftStats.size !== rightStats.size) {
      return false;
    }
    const [leftContent, rightContent] = await Promise.all([readFile(left), readFile(right)]);
    return hashContent(leftContent) === hashContent(rightContent);
  } catch {
    return false;
  }
}

// 唯一的删除依据：两棵子树逐条一致（条目名集合、条目类型、链接 target、文件 size+sha256）。
// 任何异常（EACCES/ENOENT/EIO/ELOOP）都返回 false → 调用方按 conflict 处理，绝不删。
export async function sameTree(left, right) {
  try {
    const [leftStats, rightStats] = [lstatSync(left), lstatSync(right)];
    if (!leftStats.isDirectory() || !rightStats.isDirectory()) {
      return false;
    }
    if (leftStats.isSymbolicLink() || rightStats.isSymbolicLink()) {
      return false;
    }
    const [leftEntries, rightEntries] = await Promise.all([
      readdir(left, { withFileTypes: true }),
      readdir(right, { withFileTypes: true }),
    ]);
    const leftNames = leftEntries.map((entry) => entry.name).sort();
    const rightNames = rightEntries.map((entry) => entry.name).sort();
    if (leftNames.length !== rightNames.length) {
      return false;
    }
    if (leftNames.some((name, index) => name !== rightNames[index])) {
      return false;
    }
    for (const name of leftNames) {
      if (!(await sameEntry(path.join(left, name), path.join(right, name)))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/skills-links.test.mjs`
Expected: PASS（5 个用例）

- [ ] **Step 5: 补导出与类型**

`packages/core/src/index.mjs` 加：

```js
export {
  canonicalTargets,
  classifyShareEntry,
  createSkillLink,
  normalizeLinkTarget,
  readLinkTarget,
  removeLinkSafely,
  sameTree,
  shareTargets,
} from "./skills/links.mjs";
```

`packages/core/index.d.ts` 在 `// ---- skills: install ----` 附近加：

```ts
export function canonicalTargets(context: InstallContext): InstallTarget[];
export function shareTargets(context: InstallContext): InstallTarget[];
export function normalizeLinkTarget(linkPath: string, rawTarget: string): string;
export function readLinkTarget(linkPath: string): Promise<string | null>;
export function createSkillLink(canonicalPath: string, linkPath: string): Promise<void>;
export function removeLinkSafely(linkPath: string): Promise<boolean>;
export type ShareEntryState = "absent" | "linked" | "repair" | "real-directory" | "conflict";
export interface ShareEntryVerdict {
  state: ShareEntryState;
  reason?: string;
  target?: string;
}
export function classifyShareEntry(canonicalPath: string, linkPath: string): Promise<ShareEntryVerdict>;
export function sameTree(left: string, right: string): Promise<boolean>;
```

- [ ] **Step 6: 跑全量测试并提交**

Run: `npm test`
Expected: 全绿（`pretest` 同步 vendor 后 `test/packaging.test.mjs` 能看到新符号）

```bash
git add packages/core/src/skills/links.mjs packages/core/src/index.mjs packages/core/index.d.ts packages/cli/vendor/core-src test/skills-links.test.mjs
git commit -m "feat(core): link primitives — ownership classification, sameTree, safe link/unlink"
```

---

### Task 3: `ensureSkillLinks`（建链 / 修复 / 迁移 / 降级 / 冲突）

**Files:**
- Modify: `packages/core/src/skills/links.mjs`（追加函数）
- Modify: `packages/core/src/index.mjs`、`packages/core/index.d.ts`
- Test: `test/skills-links.test.mjs`（追加用例）

**Interfaces:**
- Consumes: Task 2 的全部原语；`assertSafeSkillName`（`./ids.mjs`）、`fail`（`../util/fail.mjs`）、`isInside`（`../util/fs.mjs`）、`removeEmptyDirectory`（`../util/fs.mjs`）
- Produces:
  - `ensureSkillLinks(context, names: Iterable<string>, options?: { io?: Io; silent?: boolean; createLink?: (canonicalPath: string, linkPath: string) => Promise<void> }): Promise<{ counts: { linked: number; repaired: number; migrated: number; fallback: number; conflict: number; unchanged: number }; conflicts: Array<{ name: string; targetId: string; reason?: string }>; targets: Record<string, LinkCounts> }>`
    - `linked` 是本轮最终建立起来的链接数（含 `repaired`/`migrated` 的子集）；`createLink` 是平台/测试注入点，默认 `createSkillLink`
  - `formatLinkSummary(counts): string`、`logConflicts(io, conflicts): void`

- [ ] **Step 1: 写失败测试（追加到 `test/skills-links.test.mjs`）**

```js
import { cp, readFile } from "node:fs/promises"; // 与文件顶部导入合并
import { ensureSkillLinks, formatLinkSummary } from "../packages/core/src/index.mjs"; // 合并到既有导入

test("ensureSkillLinks links missing, repairs dangling and migrates identical copies", async () => {
  await withTempDirectory("avenic-ensure-", async (cwd) => {
    const context = createInstallContext(false, { cwd, environment: process.env });
    const canonicalRoot = path.join(cwd, ".agents", "skills");
    const shareRoot = path.join(cwd, ".claude", "skills");
    const canonical = await writeSkill(canonicalRoot, "alpha");

    // 1) canonical 缺失的技能：不建悬空链接
    await writeSkill(canonicalRoot, "known");
    const missingLink = await ensureSkillLinks(context, ["known", "ghost"], { silent: true });
    assert.equal(missingLink.counts.skipped ?? 0, 0);
    assert.equal(existsSync(path.join(shareRoot, "ghost")), false);

    // 2) 悬空链接 → repair
    const dangling = path.join(shareRoot, "dangling");
    await createSkillLink(canonical, dangling);
    await rm(path.join(canonicalRoot, "alpha"), { recursive: true, force: true });
    await writeSkill(canonicalRoot, "alpha");
    const repaired = await ensureSkillLinks(context, ["alpha"], { silent: true });
    assert.equal(repaired.counts.repaired, 1);
    assert.equal(repaired.counts.linked, 1);

    // 3) 真实副本且内容一致 → migrated（删副本 + 建链）
    const copyPath = path.join(shareRoot, "copy");
    await cp(path.join(canonicalRoot, "alpha"), copyPath, { recursive: true });
    const migrated = await ensureSkillLinks(context, ["alpha"], { silent: true, createLink: null });
    assert.equal(migrated.counts.unchanged, 1, "alpha 已经是链接");

    const copied = path.join(canonicalRoot, "copy");
    await mkdir(copied, { recursive: true });
    await writeFile(path.join(copied, "SKILL.md"), "# copy\n");
    await rm(copyPath, { recursive: true, force: true });
    await cp(copied, copyPath, { recursive: true });
    const migrateCopy = await ensureSkillLinks(context, ["copy"], { silent: true });
    assert.equal(migrateCopy.counts.migrated, 1);
    assert.equal(lstatSync(copyPath).isSymbolicLink(), true);
    assert.equal(await readFile(path.join(copyPath, "SKILL.md"), "utf8"), "# copy\n");

    // 4) 真实副本但内容不同 → conflict 且原样保留
    const differs = path.join(shareRoot, "differs");
    const canonicalDiffers = path.join(canonicalRoot, "differs");
    await mkdir(canonicalDiffers, { recursive: true });
    await writeFile(path.join(canonicalDiffers, "SKILL.md"), "# canonical\n");
    await mkdir(differs, { recursive: true });
    await writeFile(path.join(differs, "SKILL.md"), "# user edited\n");
    const conflicted = await ensureSkillLinks(context, ["differs"], { silent: true });
    assert.equal(conflicted.counts.conflict, 1);
    assert.equal(conflicted.conflicts[0].name, "differs");
    assert.equal(conflicted.conflicts[0].reason, "content-differs");
    assert.equal(await readFile(path.join(differs, "SKILL.md"), "utf8"), "# user edited\n");
  });
});

test("ensureSkillLinks never touches a link that points somewhere else", async () => {
  await withTempDirectory("avenic-foreign-", async (cwd) => {
    const context = createInstallContext(false, { cwd, environment: process.env });
    const canonical = await writeSkill(path.join(cwd, ".agents", "skills"), "alpha");
    const userTarget = await writeSkill(path.join(cwd, "user-skills"), "alpha");
    const linkPath = path.join(cwd, ".claude", "skills", "alpha");
    await linkUserSkill(userTarget, linkPath);
    const before = readlinkSync(linkPath);

    const result = await ensureSkillLinks(context, ["alpha"], { silent: true });
    assert.equal(result.counts.conflict, 1);
    assert.equal(result.counts.linked, 0);
    assert.equal(readlinkSync(linkPath), before, "the user's link is untouched");
    assert.equal(existsSync(path.join(userTarget, "SKILL.md")), true);
    assert.equal(existsSync(path.join(canonical, "SKILL.md")), true);
  });
});

test("ensureSkillLinks falls back to a copy when the platform refuses the link", async () => {
  await withTempDirectory("avenic-fallback-", async (cwd) => {
    const context = createInstallContext(false, { cwd, environment: process.env });
    await writeSkill(path.join(cwd, ".agents", "skills"), "alpha");
    const result = await ensureSkillLinks(context, ["alpha"], {
      silent: true,
      createLink: async () => {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      },
    });
    assert.equal(result.counts.fallback, 1);
    assert.equal(result.counts.linked, 0);
    const copyPath = path.join(cwd, ".claude", "skills", "alpha");
    assert.equal(lstatSync(copyPath).isSymbolicLink(), false);
    assert.equal(await readFile(path.join(copyPath, "SKILL.md"), "utf8"), "# alpha\n");
  });
});

test("formatLinkSummary is stable for CLI output", () => {
  assert.equal(
    formatLinkSummary({ linked: 2, migrated: 1, repaired: 0, fallback: 0, conflict: 0 }),
    "Linked 2 · Migrated 1 · Repaired 0 · Fallback 0 · Conflict 0",
  );
});
```

`ensureSkillLinks` 的 `counts` 里还需要 `skipped`（canonical 缺该技能而跳过）——上面第一个用例断言 `skipped ?? 0`，实现里给出准确计数后把断言改成 `assert.equal(missingLink.counts.skipped, 1)`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/skills-links.test.mjs`
Expected: FAIL — `ensureSkillLinks is not a function`

- [ ] **Step 3: 实现（追加到 `links.mjs`）**

```js
export function formatLinkSummary(counts) {
  return `Linked ${counts.linked} · Migrated ${counts.migrated} · Repaired ${counts.repaired} · Fallback ${counts.fallback} · Conflict ${counts.conflict}`;
}

export function logConflicts(io, conflicts) {
  for (const conflict of conflicts) {
    const label = conflict.reason === "content-differs"
      ? "a copy exists and differs from the shared version"
      : "a link points somewhere else";
    io.log(`⚠ ${conflict.name}: ${label} — left untouched`);
  }
}

function emptyCounts() {
  return { linked: 0, repaired: 0, migrated: 0, fallback: 0, conflict: 0, unchanged: 0, skipped: 0 };
}

// 把 shareFrom target 下的受管技能收敛成"指向 canonical 的链接"。
// 幂等；只处理传入的名字，绝不枚举目录（外部/未受管技能永不进入）。
// 失败绝不抛出：建链失败退回拷贝，状态里记 fallback（spec §8/§10）。
export async function ensureSkillLinks(context, names, options = {}) {
  const io = options.io ?? console;
  const silent = options.silent === true;
  const createLink = options.createLink ?? createSkillLink;
  const requested = [...new Set(names)].sort();
  const counts = emptyCounts();
  const conflicts = [];
  const perTarget = {};
  for (const targetConfig of shareTargets(context)) {
    const canonicalRoot = targetConfig.shareDestination;
    const targetCounts = emptyCounts();
    perTarget[targetConfig.id] = targetCounts;
    if (!existsSync(canonicalRoot)) {
      continue; // canonical 不存在：不建空目录、不建链接（spec §10）
    }
    const canonicalStats = lstatSync(canonicalRoot);
    if (!canonicalStats.isDirectory() || canonicalStats.isSymbolicLink()) {
      continue;
    }
    for (const name of requested) {
      assertSafeSkillName(name);
      const canonicalPath = path.join(canonicalRoot, name);
      const linkPath = path.join(targetConfig.destination, name);
      if (!isInside(canonicalRoot, canonicalPath) || !isInside(targetConfig.destination, linkPath)) {
        fail(`Share path escaped its target: ${linkPath}`);
      }
      if (!existsSync(canonicalPath)) {
        counts.skipped += 1;
        targetCounts.skipped += 1;
        continue;
      }
      const verdict = await classifyShareEntry(canonicalPath, linkPath);
      if (verdict.state === "linked") {
        counts.unchanged += 1;
        targetCounts.unchanged += 1;
        continue;
      }
      if (verdict.state === "conflict") {
        counts.conflict += 1;
        targetCounts.conflict += 1;
        conflicts.push({ name, targetId: targetConfig.id, reason: verdict.reason });
        continue;
      }
      if (verdict.state === "real-directory") {
        if (!(await sameTree(canonicalPath, linkPath))) {
          counts.conflict += 1;
          targetCounts.conflict += 1;
          conflicts.push({ name, targetId: targetConfig.id, reason: "content-differs" });
          continue;
        }
        await rm(linkPath, { recursive: true, force: true }); // sameTree 已证明内容一致
        counts.migrated += 1;
        targetCounts.migrated += 1;
      } else if (verdict.state === "repair") {
        await removeLinkSafely(linkPath);
        counts.repaired += 1;
        targetCounts.repaired += 1;
      }
      try {
        await createLink(canonicalPath, linkPath);
        counts.linked += 1;
        targetCounts.linked += 1;
      } catch (error) {
        counts.fallback += 1;
        targetCounts.fallback += 1;
        await mkdir(path.dirname(linkPath), { recursive: true });
        if (!existsSync(path.join(linkPath, "SKILL.md"))) {
          await rm(linkPath, { recursive: true, force: true });
          await cp(canonicalPath, linkPath, { recursive: true });
        }
        if (!silent) {
          io.log(`⚠ Cannot create shared link for ${name} (${error.code ?? error.message}) — copied instead`);
        }
      }
    }
  }
  if (!silent && conflicts.length > 0) {
    logConflicts(io, conflicts);
  }
  return { counts, conflicts, targets: perTarget };
}
```

`links.mjs` 顶部导入补：`import { existsSync, lstatSync } from "node:fs";` 已在；补 `import { fail } from "../util/fail.mjs";`、`import { isInside, removeEmptyDirectory } from "../util/fs.mjs";`、`import { assertSafeSkillName } from "./ids.mjs";`（`removeEmptyDirectory` 在 Task 5 用到，可先不加）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/skills-links.test.mjs`
Expected: PASS（9 个用例）。把第一个用例的 `skipped ?? 0` 断言收紧为 `assert.equal(missingLink.counts.skipped, 1)` 后重跑一次。

- [ ] **Step 5: 补导出与类型**

`packages/core/src/index.mjs` 的 links 导出块加 `ensureSkillLinks, formatLinkSummary, logConflicts,`。
`packages/core/index.d.ts` 加：

```ts
export interface LinkCounts {
  linked: number;
  repaired: number;
  migrated: number;
  fallback: number;
  conflict: number;
  unchanged: number;
  skipped: number;
}
export interface LinkConflict {
  name: string;
  targetId: string;
  reason?: string;
}
export function ensureSkillLinks(
  context: InstallContext,
  names: Iterable<string>,
  options?: { io?: Io; silent?: boolean; createLink?: (canonicalPath: string, linkPath: string) => Promise<void> },
): Promise<{ counts: LinkCounts; conflicts: LinkConflict[]; targets: Record<string, LinkCounts> }>;
export function formatLinkSummary(counts: LinkCounts): string;
export function logConflicts(io: Io, conflicts: LinkConflict[]): void;
```

- [ ] **Step 6: 跑全量测试并提交**

Run: `npm test`
Expected: 全绿

```bash
git add packages/core/src/skills/links.mjs packages/core/src/index.mjs packages/core/index.d.ts packages/cli/vendor/core-src test/skills-links.test.mjs
git commit -m "feat(core): ensureSkillLinks — link, repair, migrate, fallback, conflict with counts"
```

---

### Task 4: `installCopies` 四阶段 + A1 回归 + 迁移

**Files:**
- Modify: `packages/core/src/skills/install.mjs:150-197`
- Test: `test/skills-single-copy.test.mjs`（新增）

**Interfaces:**
- Consumes: `ensureSkillLinks`、`formatLinkSummary`、`canonicalTargets`、`shareTargets`（Task 3）
- Produces: `installCopies` 的新输出行（canonical 行保持原样；shareFrom 行新增 `✓ <label> (shared from <id>)` + `Linked … · Migrated … · Repaired … · Fallback … · Conflict …`）

- [ ] **Step 1: 写失败测试**

创建 `test/skills-single-copy.test.mjs`（复制 `test/skills.test.mjs` 的 fixture 与 runAgent 辅助，并加两个新辅助）：

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentBin = path.join(packageRoot, "packages", "cli", "scripts", "skills.mjs");

function runAgent(cwd, argumentsList, environment = {}) {
  return spawnSync(process.execPath, [agentBin, ...argumentsList], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...environment },
  });
}

function gitQuiet(cwd, argumentsList) {
  const result = spawnSync("git", ["-C", cwd, ...argumentsList], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function withTempDirectory(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function commitAll(root, message) {
  await gitQuiet(root, ["init", "--quiet", "-b", "main"]);
  await gitQuiet(root, ["add", "-A"]);
  await gitQuiet(root, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", message]);
}

async function createCatalogFixture(root) {
  await mkdir(path.join(root, "packs"), { recursive: true });
  await mkdir(path.join(root, "licenses"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "fixture-catalog", version: "1.0.0", private: true, agentSkills: { packageSpec: "fixture#main" } }, null, 2)}\n`,
  );
  await writeFile(
    path.join(root, "sources.lock.json"),
    `${JSON.stringify({ schemaVersion: 1, sources: [{ id: "test-source", name: "Test Source", repository: "https://github.com/example/test.git", skillRoot: "skills", revision: "a".repeat(40), licenseFile: "licenses/test-source-LICENSE" }] }, null, 2)}\n`,
  );
  await writeFile(path.join(root, "licenses", "test-source-LICENSE"), "license\n");
  for (const skillName of ["alpha", "beta", "gamma"]) {
    const directory = path.join(root, "skills", "test-source", skillName);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${skillName}\n---\n# ${skillName} v1\n`);
  }
  const common = { schemaVersion: 1, id: "common", name: "Common", sources: [{ source: "test-source", skills: ["alpha"] }] };
  const development = { schemaVersion: 1, id: "development", name: "Development", sources: [{ source: "test-source", skills: ["beta", "gamma"] }] };
  await writeFile(path.join(root, "packs", "common.json"), `${JSON.stringify(common, null, 2)}\n`);
  await writeFile(path.join(root, "packs", "development.json"), `${JSON.stringify(development, null, 2)}\n`);
  await commitAll(root, "fixture catalog");
}

// 改内容 + 换 revision 并提交：让下一次安装走"更新"路径（而不是 unchanged 快速路径）。
async function publishFixtureUpdate(root, skillName, content, revision) {
  await writeFile(path.join(root, "skills", "test-source", skillName, "SKILL.md"), content);
  const lockPath = path.join(root, "sources.lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.sources[0].revision = revision;
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  await gitQuiet(root, ["add", "-A"]);
  await gitQuiet(root, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", `update ${skillName}`]);
}

function catalogEnvironment(catalogRoot, stateRoot) {
  return { AVENIC_CATALOG_SPEC: catalogRoot, AVENIC_STATE_DIR: stateRoot };
}

async function isLink(target) {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}
```

四个用例：

```js
test("install keeps one physical copy and links the claude target", async () => {
  await withTempDirectory("avenic-single-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);
        const installed = runAgent(projectRoot, ["skills", "install"], environment);
        assert.equal(installed.status, 0, installed.stderr);
        assert.match(installed.stdout, /shared from agents/);

        const canonical = path.join(projectRoot, ".agents", "skills", "alpha", "SKILL.md");
        const shared = path.join(projectRoot, ".claude", "skills", "alpha");
        assert.equal(lstatSync(path.join(projectRoot, ".agents", "skills", "alpha")).isSymbolicLink(), false);
        assert.equal(await isLink(shared), true);
        assert.equal(await readFile(path.join(shared, "SKILL.md"), "utf8"), await readFile(canonical, "utf8"));

        const status = runAgent(projectRoot, ["skills", "status"], environment);
        assert.equal(status.status, 0, status.stderr);
        assert.match(status.stdout, /Claude Code: shared/);
      });
    });
  });
});

test("regression: a fallback copy from a previous install upgrades to a link (no conflict)", async () => {
  await withTempDirectory("avenic-fallback-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);
        assert.equal(runAgent(projectRoot, ["skills", "install", "common"], environment).status, 0);

        // 模拟"上次安装时建链失败"的现场：真身内容 + 一个内容完全一致的真实副本。
        const copyPath = path.join(projectRoot, ".claude", "skills", "alpha");
        await unlink(copyPath);
        await cp(path.join(projectRoot, ".agents", "skills", "alpha"), copyPath, { recursive: true });
        assert.equal(await isLink(copyPath), false);

        await publishFixtureUpdate(catalogRoot, "alpha", "---\nname: alpha\n---\n# alpha v2\n", "b".repeat(40));
        const upgraded = runAgent(projectRoot, ["skills", "install"], environment);
        assert.equal(upgraded.status, 0, upgraded.stderr);
        assert.doesNotMatch(upgraded.stdout, /Conflict [1-9]/);
        assert.doesNotMatch(upgraded.stdout, /differs from the shared version/);

        assert.equal(await isLink(copyPath), true, "the fallback copy became a link");
        assert.equal(
          await readFile(path.join(copyPath, "SKILL.md"), "utf8"),
          await readFile(path.join(projectRoot, ".agents", "skills", "alpha", "SKILL.md"), "utf8"),
        );
        assert.match(await readFile(path.join(copyPath, "SKILL.md"), "utf8"), /alpha v2/);
      });
    });
  });
});

test("migrates a legacy double-copy layout into a link", async () => {
  await withTempDirectory("avenic-migrate-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);
        assert.equal(runAgent(projectRoot, ["skills", "install", "common"], environment).status, 0);
        const copyPath = path.join(projectRoot, ".claude", "skills", "alpha");
        await unlink(copyPath);
        await cp(path.join(projectRoot, ".agents", "skills", "alpha"), copyPath, { recursive: true });

        const reinstalled = runAgent(projectRoot, ["skills", "install"], environment);
        assert.equal(reinstalled.status, 0, reinstalled.stderr);
        assert.equal(await isLink(copyPath), true);
        assert.match(reinstalled.stdout, /Migrated [1-9]/);
      });
    });
  });
});

test("keeps a divergent copy and reports conflict, while still updating the shared copy", async () => {
  await withTempDirectory("avenic-conflict-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);
        assert.equal(runAgent(projectRoot, ["skills", "install", "common"], environment).status, 0);

        const copyPath = path.join(projectRoot, ".claude", "skills", "alpha");
        await unlink(copyPath);
        await cp(path.join(projectRoot, ".agents", "skills", "alpha"), copyPath, { recursive: true });
        await writeFile(path.join(copyPath, "SKILL.md"), "---\nname: alpha\n---\n# user edited\n");

        await publishFixtureUpdate(catalogRoot, "alpha", "---\nname: alpha\n---\n# alpha v3\n", "c".repeat(40));
        const upgraded = runAgent(projectRoot, ["skills", "install"], environment);
        assert.equal(upgraded.status, 0, upgraded.stderr);
        assert.equal(await isLink(copyPath), false);
        assert.equal(await readFile(path.join(copyPath, "SKILL.md"), "utf8"), "---\nname: alpha\n---\n# user edited\n");
        assert.match(await readFile(path.join(projectRoot, ".agents", "skills", "alpha", "SKILL.md"), "utf8"), /alpha v3/);

        const status = runAgent(projectRoot, ["skills", "status"], environment);
        assert.match(status.stdout, /conflict/i);
      });
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/skills-single-copy.test.mjs`
Expected: FAIL — `.claude/skills/alpha` 是真实目录（`isLink === false`），stdout 里没有 `shared from agents`

- [ ] **Step 3: 实现四阶段 `installCopies`**

把 `packages/core/src/skills/install.mjs:150-197` 的 `installCopies` 整体替换为：

```js
export async function installCopies(context, resolvedPacks, io = console, options = {}) {
  const selectedSkills = resolvedPacks.groups.flatMap((group) => group.skills);
  const selectedNames = new Set(selectedSkills.map((skill) => skill.name));
  const previousState = await previousManagedState(context);
  // removeStale === false：接管类操作（adoptPackedSkills）不得按上一记录清理——那会误删
  // 其他来源（旧 Pack/直装）已托管的 Skill；仅覆盖式安装路径才允许陈旧清理。
  const staleNames = options.removeStale === false
    ? []
    : [...previousState.keys()].filter((name) => !selectedNames.has(name));
  // 预检覆盖"本次选中 + 上次受管"：陈旧技能也要先迁移，才能在 canonical 被删前用内容判定副本归属。
  const preflightNames = new Set([...previousState.keys(), ...selectedNames]);

  // 1) 预检 + 迁移：必须在 canonical 被改动之前。上次安装留下的 fallback 副本此刻与
  //    旧 canonical 内容一致 → 安全的迁移（删副本 + 建链）；先改 canonical 会把它误判成冲突。
  await ensureSkillLinks(context, preflightNames, { io, silent: true });

  // 2) canonical 安装：只有非 shareFrom 的 target 落真身。
  for (const targetConfig of canonicalTargets(context)) {
    const destination = targetConfig.destination;
    await mkdir(destination, { recursive: true });
    const result = { added: 0, updated: 0, unchanged: 0, removed: 0 };
    for (const skill of selectedSkills) {
      const target = path.join(destination, skill.name);
      if (!isInside(destination, target)) {
        fail(`Install path escaped its target: ${target}`);
      }
      const previous = previousState.get(skill.name);
      if (
        existsSync(path.join(target, "SKILL.md")) &&
        previous?.sourceId === skill.source.id &&
        previous?.revision === skill.source.revision
      ) {
        result.unchanged += 1;
        continue;
      }
      const existed = existsSync(target);
      await rm(target, { recursive: true, force: true });
      await cp(skill.directory, target, { recursive: true });
      result[existed ? "updated" : "added"] += 1;
    }
    for (const staleName of staleNames) {
      assertSafeSkillName(staleName);
      const target = path.join(destination, staleName);
      if (!isInside(destination, target)) {
        fail(`Cleanup path escaped its target: ${target}`);
      }
      await rm(target, { recursive: true, force: true });
      result.removed += 1;
    }
    io.log(`✓ ${targetConfig.label}`);
    io.log(`  Path: ${destination}`);
    io.log(
      `  Added ${result.added} · Updated ${result.updated} · Unchanged ${result.unchanged} · Removed ${result.removed}`,
    );
  }

  // 3) 补链：为第 1 步时尚不存在的 canonical 建链（首次安装走这条）。
  const linkResult = await ensureSkillLinks(context, selectedNames, { io, silent: true });

  // 4) shareFrom 陈旧清理：只解链，真身已在第 2 步删除。
  for (const targetConfig of shareTargets(context)) {
    await mkdir(targetConfig.destination, { recursive: true });
    let removed = 0;
    for (const staleName of staleNames) {
      assertSafeSkillName(staleName);
      const linkPath = path.join(targetConfig.destination, staleName);
      if (!isInside(targetConfig.destination, linkPath)) {
        fail(`Cleanup path escaped its target: ${linkPath}`);
      }
      if (await removeLinkSafely(linkPath)) {
        removed += 1;
      }
    }
    const targetCounts = linkResult.targets[targetConfig.id] ?? {
      linked: 0, migrated: 0, repaired: 0, fallback: 0, conflict: 0, unchanged: 0, skipped: 0,
    };
    io.log(`✓ ${targetConfig.label} (shared from ${targetConfig.shareFrom})`);
    io.log(`  Path: ${targetConfig.destination}`);
    io.log(`  ${formatLinkSummary(targetCounts)}${removed > 0 ? ` · Unlinked ${removed}` : ""}`);
  }
  logConflicts(io, linkResult.conflicts);
  return linkResult;
}
```

`install.mjs` 顶部导入补：

```js
import {
  canonicalTargets,
  ensureSkillLinks,
  formatLinkSummary,
  logConflicts,
  removeLinkSafely,
  shareTargets,
} from "./links.mjs";
```

- [ ] **Step 4: 运行新测试确认通过**

Run: `node --test test/skills-single-copy.test.mjs`
Expected: PASS（4 个用例）

- [ ] **Step 5: 跑全量测试并修既有断言**

Run: `npm test`
Expected: 大部分通过。按下面的规则处理失败（**读取穿透链接仍会成功**，所以只有"真实目录 / 删除语义 / target 计数"三类断言需要改）：

| 失败断言 | 改法 |
|---|---|
| 断言 `.claude/skills/<name>` 是真实目录 | 改为 `assert.equal(lstatSync(...).isSymbolicLink(), true)`，内容断言保留（穿透链接读取一致） |
| `targets[0].complete` / `targets[1].complete`（`test/skills.test.mjs:189-209` 一带） | 语义变为：canonical 看"真身齐全"，shareFrom 看"链接或降级副本齐全"；按 §8 的 `complete` 定义重写断言 |
| 断言 install 输出行顺序 / `Placed targets: 1` | 输出顺序现在是 canonical 在前、shareFrom 在后；断言按新输出更新 |
| `integration/global-install.mjs` 双拷贝断言 | 改为"canonical 真身 + 另一处是链接"（`npm run test:install` 运行） |

修完再次 Run: `npm test` → 全绿。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/skills/install.mjs packages/cli/vendor/core-src test/ integration/
git commit -m "feat(core): install in four phases — preflight migration before canonical, then link, then unlink stale"
```

---

### Task 5: 卸载 / 按名删除的解链语义

**Files:**
- Modify: `packages/core/src/skills/install.mjs:199-239`
- Test: `test/skills-single-copy.test.mjs`（追加）

**Interfaces:**
- Consumes: `removeLinkSafely`、`classifyShareEntry`（Task 2）、`shareTargets`/`canonicalTargets`
- Produces: `removeAllManagedSkills`、`removeSkillDirectories` 的 shareFrom 行为（先处理 shareFrom target，再处理 canonical）

- [ ] **Step 1: 写失败测试（追加）**

```js
test("uninstall removes the shared copy and unlinks the claude target", async () => {
  await withTempDirectory("avenic-uninstall-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);
        assert.equal(runAgent(projectRoot, ["skills", "install"], environment).status, 0);
        const shared = path.join(projectRoot, ".claude", "skills", "alpha");
        assert.equal(await isLink(shared), true);

        const removed = runAgent(projectRoot, ["skills", "uninstall"], environment);
        assert.equal(removed.status, 0, removed.stderr);
        assert.equal(existsSync(shared), false, "link is gone");
        assert.equal(existsSync(path.join(projectRoot, ".agents", "skills", "alpha")), false);
        assert.equal(existsSync(path.join(projectRoot, ".claude", "skills", "alpha", "SKILL.md")), false);
      });
    });
  });
});

test("a user-owned link to another path survives uninstall and is reported", async () => {
  await withTempDirectory("avenic-foreign-uninstall-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);
        assert.equal(runAgent(projectRoot, ["skills", "install", "common"], environment).status, 0);

        const shared = path.join(projectRoot, ".claude", "skills", "alpha");
        await unlink(shared);
        const userTarget = path.join(projectRoot, "user-skills", "alpha");
        await mkdir(userTarget, { recursive: true });
        await writeFile(path.join(userTarget, "SKILL.md"), "user owned\n");
        if (process.platform === "win32") {
          await symlink(userTarget, shared, "junction");
        } else {
          await symlink(path.relative(path.dirname(shared), userTarget), shared, "dir");
        }

        const removed = runAgent(projectRoot, ["skills", "uninstall"], environment);
        assert.equal(removed.status, 0, removed.stderr);
        assert.equal(await isLink(shared), true, "the user's link is never unlinked");
        assert.equal(await readFile(path.join(userTarget, "SKILL.md"), "utf8"), "user owned\n");
        assert.match(removed.stdout, /points somewhere else/);
      });
    });
  });
});
```

测试文件顶部补 `import { existsSync } from "node:fs";` 与 `symlink`（来自 `node:fs/promises`）。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/skills-single-copy.test.mjs`
Expected: FAIL — 卸载后链接仍存在（`existsSync(shared) === true`）

- [ ] **Step 3: 实现**

`removeAllManagedSkills` 与 `removeSkillDirectories` 共用下面的辅助函数（放在 `install.mjs` 里，`installCopies` 之后）：

```js
// 卸载/按名删除时的 shareFrom 处理：先解链（含悬空链接），真实目录按今天的语义删除，
// 指向别处的链接一律保留并报告（spec §5.2）。必须在 canonical 轮之前调用。
async function removeShareEntries(context, names, io) {
  let removed = 0;
  const conflicts = [];
  for (const targetConfig of shareTargets(context)) {
    for (const name of names) {
      assertSafeSkillName(name);
      const linkPath = path.join(targetConfig.destination, name);
      if (!isInside(targetConfig.destination, linkPath)) {
        fail(`Uninstall path escaped its target: ${linkPath}`);
      }
      if (!existsSync(path.join(targetConfig.destination))) {
        break;
      }
      const verdict = await classifyShareEntry(path.join(targetConfig.shareDestination, name), linkPath);
      if (verdict.state === "absent") {
        continue;
      }
      if (verdict.state === "conflict") {
        conflicts.push({ name, targetId: targetConfig.id, reason: verdict.reason });
        continue;
      }
      if (verdict.state === "linked" || verdict.state === "repair") {
        if (await removeLinkSafely(linkPath)) {
          removed += 1;
        }
        continue;
      }
      await rm(linkPath, { recursive: true, force: true });
      removed += 1;
    }
  }
  if (conflicts.length > 0) {
    logConflicts(io, conflicts);
  }
  return removed;
}
```

`removeAllManagedSkills` 改为：

```js
export async function removeAllManagedSkills(context, managed, io = console) {
  await removeShareEntries(context, [...managed.keys()], io);
  for (const targetConfig of canonicalTargets(context)) {
    let removed = 0;
    for (const skillName of managed.keys()) {
      assertSafeSkillName(skillName);
      const target = path.join(targetConfig.destination, skillName);
      if (!isInside(targetConfig.destination, target)) {
        fail(`Uninstall path escaped its target: ${target}`);
      }
      if (existsSync(target)) {
        await rm(target, { recursive: true, force: true });
        removed += 1;
      }
    }
    io.log(`${targetConfig.label}: Removed ${removed}`);
  }
  for (const targetConfig of shareTargets(context)) {
    await removeEmptyDirectory(targetConfig.destination);
  }
  for (const targetConfig of canonicalTargets(context)) {
    await removeEmptyDirectory(targetConfig.destination);
  }
  return [...managed.keys()].length === 0 ? 0 : (await countRemoved(context, managed));
}
```

> 返回值的既有语义是"删除总数"，`test/skills.test.mjs` 会断言它。实现时不要引入 `countRemoved` 这类虚构函数：把两次循环的删除数各自累加进同一个 `total` 并 `return total`（`removeShareEntries` 也返回它删除的条目数）。

因此更简单的正确写法是把计数贯穿两个循环：

```js
export async function removeAllManagedSkills(context, managed, io = console) {
  const names = [...managed.keys()];
  let total = await removeShareEntries(context, names, io);
  for (const targetConfig of canonicalTargets(context)) {
    let removed = 0;
    for (const skillName of names) {
      assertSafeSkillName(skillName);
      const target = path.join(targetConfig.destination, skillName);
      if (!isInside(targetConfig.destination, target)) {
        fail(`Uninstall path escaped its target: ${target}`);
      }
      if (existsSync(target)) {
        await rm(target, { recursive: true, force: true });
        removed += 1;
      }
    }
    total += removed;
    io.log(`${targetConfig.label}: Removed ${removed}`);
  }
  for (const targetConfig of context.targets) {
    await removeEmptyDirectory(targetConfig.destination);
  }
  return total;
}
```

`removeSkillDirectories` 同样处理：

```js
export async function removeSkillDirectories(context, skillNames, io = console) {
  let total = await removeShareEntries(context, skillNames, io);
  for (const targetConfig of canonicalTargets(context)) {
    let removed = 0;
    for (const skillName of skillNames) {
      const target = path.join(targetConfig.destination, skillName);
      if (!isInside(targetConfig.destination, target)) {
        fail(`Uninstall path escaped its target: ${target}`);
      }
      if (existsSync(target)) {
        await rm(target, { recursive: true, force: true });
        removed += 1;
      }
    }
    total += removed;
    io.log(`${targetConfig.label}: ${removed > 0 ? `Removed ${removed}` : "Unchanged"}`);
  }
  return total;
}
```

`install.mjs` 导入补 `classifyShareEntry`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/skills-single-copy.test.mjs`
Expected: PASS（6 个用例）

- [ ] **Step 5: 跑全量测试**

Run: `npm test`
Expected: 全绿。`test/skills.test.mjs:105-124`（外部技能按名删除两个真实目录）仍应通过——它是"按名显式删除"，真实目录照旧删除。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/skills/install.mjs packages/cli/vendor/core-src test/
git commit -m "feat(core): uninstall/unlink semantics for shared targets; foreign links are never unlinked"
```

---

### Task 6: 直装 Skill 走同一套语义

**Files:**
- Modify: `packages/core/src/skills/direct.mjs:125-140`
- Test: `test/skills-single-copy.test.mjs`（追加；直装需要一个真实 git 仓库，沿用 `test/skills-direct-add.test.mjs` 的做法）

**Interfaces:**
- Consumes: `ensureSkillLinks`、`canonicalTargets`、`shareTargets`、`formatLinkSummary`
- Produces: `addDirectSkills` 的日志新增 shareFrom 行；真身只落 canonical

- [ ] **Step 1: 写失败测试（追加）**

```js
test("direct install writes the canonical copy and links the claude target", async () => {
  await withTempDirectory("avenic-direct-src-", async (sourceRoot) => {
    await mkdir(path.join(sourceRoot, "skills", "direct-skill"), { recursive: true });
    await writeFile(path.join(sourceRoot, "skills", "direct-skill", "SKILL.md"), "---\nname: direct-skill\n---\n# direct\n");
    await commitAll(sourceRoot, "direct source");
    await withTempDirectory("avenic-direct-", async (projectRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        const environment = { AVENIC_STATE_DIR: stateRoot };
        const added = runAgent(projectRoot, ["skills", "add", sourceRoot], environment);
        assert.equal(added.status, 0, added.stderr);
        const shared = path.join(projectRoot, ".claude", "skills", "direct-skill");
        assert.equal(await isLink(shared), true);
        assert.equal(lstatSync(path.join(projectRoot, ".agents", "skills", "direct-skill")).isSymbolicLink(), false);
        assert.equal(await readFile(path.join(shared, "SKILL.md"), "utf8"), "---\nname: direct-skill\n---\n# direct\n");
      });
    });
  });
});
```

> 若 `avenic skills add <local path>` 需要 GitHub 形态，先跑 `test/skills-direct-add.test.mjs` 确认它用的输入形态（本地路径或 `file://`），照抄那一种。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/skills-single-copy.test.mjs`
Expected: FAIL — `.claude/skills/direct-skill` 是真实目录

- [ ] **Step 3: 实现**

`direct.mjs` 的 `addDirectSkills` 中，把 `for (const targetConfig of context.targets)` 那段循环替换为（**注意保留 `direct.mjs:119-123` 的 alreadyInstalled 快速返回**）：

```js
  // 与 Pack 安装同序：先预检（上次的 fallback 副本要拿旧 canonical 比较），再写真身，最后补链。
  await ensureSkillLinks(context, requestedNames, { io, silent: true });

  for (const targetConfig of canonicalTargets(context)) {
    const destination = targetConfig.destination;
    await mkdir(destination, { recursive: true });
    for (const name of requestedNames) {
      const target = path.join(destination, name);
      if (!isInside(destination, target)) {
        fail(`Install path escaped its target: ${target}`);
      }
      await rm(target, { recursive: true, force: true });
      const upstreamPath = source.skillPaths?.[name] ?? name;
      await cp(path.join(directory, source.skillRoot, upstreamPath), target, { recursive: true });
    }
    io.log(`✓ ${targetConfig.label}`);
    io.log(`  Path: ${destination}`);
    io.log(`  Added ${requestedNames.length} direct Skill${requestedNames.length === 1 ? "" : "s"}`);
  }

  const linkResult = await ensureSkillLinks(context, requestedNames, { io, silent: true });
  for (const targetConfig of shareTargets(context)) {
    io.log(`✓ ${targetConfig.label} (shared from ${targetConfig.shareFrom})`);
    io.log(`  Path: ${targetConfig.destination}`);
    io.log(`  ${formatLinkSummary(linkResult.targets[targetConfig.id] ?? linkResult.counts)}`);
  }
  logConflicts(io, linkResult.conflicts);
```

`direct.mjs` 导入补：`import { canonicalTargets, ensureSkillLinks, formatLinkSummary, logConflicts, shareTargets } from "./links.mjs";`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/skills-single-copy.test.mjs` → PASS；再 Run: `node --test test/skills-direct-add.test.mjs` → 按 Task 4 Step 5 的规则修断言（读取穿透链接的断言不用改）。

- [ ] **Step 5: 跑全量测试并提交**

Run: `npm test`
Expected: 全绿

```bash
git add packages/core/src/skills/direct.mjs packages/cli/vendor/core-src test/
git commit -m "feat(core): direct install shares skills through links like pack install"
```

---

### Task 7: 接管（adopt / adoptPacked）走同一套语义

**Files:**
- Modify: `packages/core/src/skills/install.mjs:254-292`
- Test: `test/skills-single-copy.test.mjs`（追加）

**Interfaces:**
- Consumes: `ensureSkillLinks`、`canonicalTargets`、`shareTargets`
- Produces: `adoptSkills` 返回 `{ adopted: string[], placed: number, linked: number }`（`placed` 语义保持"补齐的 target 数"，链接也算补齐）

- [ ] **Step 1: 写失败测试（追加）**

```js
test("adopt fills the canonical target and links the shared target", async () => {
  await withTempDirectory("avenic-adopt-link-", async (projectRoot) => {
    await withTempDirectory("avenic-state-", async (stateRoot) => {
      const environment = { AVENIC_STATE_DIR: stateRoot };
      const host = path.join(projectRoot, ".agents", "skills", "handmade");
      await mkdir(host, { recursive: true });
      await writeFile(path.join(host, "SKILL.md"), "---\nname: handmade\n---\n# handmade\n");

      const adopted = runAgent(projectRoot, ["skills", "adopt", "handmade"], environment);
      assert.equal(adopted.status, 0, adopted.stderr);
      const shared = path.join(projectRoot, ".claude", "skills", "handmade");
      assert.equal(await isLink(shared), true);
      assert.equal(await readFile(path.join(shared, "SKILL.md"), "utf8"), "---\nname: handmade\n---\n# handmade\n");
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/skills-single-copy.test.mjs`
Expected: FAIL — `.claude/skills/handmade` 是真实副本

- [ ] **Step 3: 实现**

`adoptSkills` 中把"补齐缺失 target"的循环限定到 canonical，然后补链：

```js
  let placed = 0;
  for (const target of canonicalTargets(context)) {
    const destination = target.destination;
    for (const name of names) {
      const targetPath = path.join(destination, name);
      if (!isInside(destination, targetPath)) {
        fail(`Adopt path escaped its target: ${targetPath}`);
      }
      if (existsSync(targetPath)) continue; // 该 target 已有内容：视为就绪，不覆盖
      await mkdir(destination, { recursive: true });
      await cp(host.get(name), targetPath, { recursive: true });
      placed += 1;
    }
  }
  // shareFrom target 用链接补齐；stat/链接失败时 ensureSkillLinks 会退回拷贝。
  const linkResult = await ensureSkillLinks(context, names, { silent: true });
  const linked = Object.values(linkResult.targets).reduce((sum, counts) => sum + counts.linked, 0);
  placed += linked;
```

返回 `{ adopted: names, placed, linked }`；`index.d.ts` 里 `adoptSkills` 的返回类型加上 `linked: number`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/skills-single-copy.test.mjs` → PASS
Run: `node --test test/skills-adopt.test.mjs test/skills-packadopt.test.mjs` → `placed === 1` 之类的断言仍成立（链接也算补齐）；不成立时按 Task 4 Step 5 的规则修。

- [ ] **Step 5: 跑全量测试并提交**

Run: `npm test`
Expected: 全绿

```bash
git add packages/core/src/skills/install.mjs packages/core/index.d.ts packages/cli/vendor/core-src test/
git commit -m "feat(core): adoption links shared targets instead of copying"
```

---

### Task 8: `managedSkillNames` + CLI 启动补齐

**Files:**
- Modify: `packages/core/src/skills/install.mjs`（新增导出）、`packages/core/src/index.mjs`、`packages/core/index.d.ts`
- Modify: `packages/cli/src/cli/dispatcher.mjs:24`（导入）、`:294-297`（`launchExecutable` 之前）
- Test: `test/skills-single-copy.test.mjs`、`test/skills-targets.test.mjs`（追加）

**Interfaces:**
- Consumes: `previousManagedState`（既有）、`readJson`、`ensureSkillLinks`
- Produces: `managedSkillNames(context): Promise<Set<string>>`（= `lock.sources[].skills` ∪ `lock.adopted` ∪ `lock.directSources[].skills`）

- [ ] **Step 1: 写失败测试**

追加到 `test/skills-targets.test.mjs`：

```js
import { managedSkillNames } from "../packages/core/src/index.mjs"; // 合并到顶部导入
import { mkdir, writeFile } from "node:fs/promises"; // 合并

test("managedSkillNames unions packs, adopted and direct records", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "avenic-managed-"));
  try {
    const context = createInstallContext(false, { cwd, environment: process.env });
    await mkdir(path.dirname(context.lockFile), { recursive: true });
    await writeFile(
      context.lockFile,
      `${JSON.stringify({
        schemaVersion: 3,
        sources: [{ id: "s", skills: ["alpha", "beta"] }],
        adopted: ["handmade"],
        directSources: [{ id: "d", skills: ["direct-one"] }],
      }, null, 2)}\n`,
    );
    const names = await managedSkillNames(context);
    assert.deepEqual([...names].sort(), ["alpha", "beta", "direct-one", "handmade"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("managedSkillNames is empty without a lock file", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "avenic-managed-empty-"));
  try {
    const context = createInstallContext(false, { cwd, environment: process.env });
    assert.equal((await managedSkillNames(context)).size, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
```

追加到 `test/skills-single-copy.test.mjs`（端到端启动补齐）：

```js
test("launching an agent repairs a missing link and never touches unmanaged skills", async () => {
  await withTempDirectory("avenic-launch-bin-", async (binDirectory) => {
    const fake = path.join(binDirectory, process.platform === "win32" ? "claude.ps1" : "claude");
    await writeFile(fake, process.platform === "win32" ? "exit 0\n" : "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") await chmod(fake, 0o755);
    await withTempDirectory("avenic-launch-", async (projectRoot) => {
      await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
        await withTempDirectory("avenic-state-", async (stateRoot) => {
          await createCatalogFixture(catalogRoot);
          const environment = {
            ...catalogEnvironment(catalogRoot, stateRoot),
            PATH: `${binDirectory}${path.delimiter}${process.env.PATH}`,
            Path: `${binDirectory}${path.delimiter}${process.env.PATH}`,
          };
          assert.equal(runAgent(projectRoot, ["claude", "init", "--sessions", "global"], environment).status, 0);
          assert.equal(runAgent(projectRoot, ["skills", "install", "common"], environment).status, 0);

          // 外部（未受管）技能混在 canonical 里：启动补齐不得给它建链接。
          const unmanaged = path.join(projectRoot, ".agents", "skills", "outsider");
          await mkdir(unmanaged, { recursive: true });
          await writeFile(path.join(unmanaged, "SKILL.md"), "outsider\n");

          const shared = path.join(projectRoot, ".claude", "skills", "alpha");
          await unlink(shared); // 模拟 clone 后只有真身、没有链接
          assert.equal(await isLink(shared), false);

          const launched = runAgent(projectRoot, ["claude"], environment);
          assert.equal(launched.status, 0, launched.stderr);
          assert.equal(await isLink(shared), true, "launch repaired the link");
          assert.equal(existsSync(path.join(projectRoot, ".claude", "skills", "outsider")), false, "unmanaged skills are not linked");
        });
      });
    });
  });
});
```

（测试文件顶部补 `import { chmod } from "node:fs/promises";`。）

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/skills-targets.test.mjs test/skills-single-copy.test.mjs`
Expected: FAIL — `managedSkillNames is not a function`；启动后链接未修复

- [ ] **Step 3: 实现 core 侧**

`install.mjs` 在 `previousManagedState` 之后加：

```js
// Avenic 受管的 Skill 名字全集：Pack 安装记录 + 接管记录 + 直装记录。
// 启动补齐只认这个集合，绝不枚举目录——`.agents/skills` 里手工放入的技能不归我们管。
export async function managedSkillNames(context) {
  const managed = new Set((await previousManagedState(context)).keys());
  if (!existsSync(context.lockFile)) {
    return managed;
  }
  const lock = await readJson(context.lockFile);
  for (const name of lock.adopted ?? []) {
    managed.add(name);
  }
  for (const source of lock.directSources ?? []) {
    for (const name of source.skills ?? []) {
      managed.add(name);
    }
  }
  return managed;
}
```

（注意：`previousManagedState` 在无锁时返回空 Map，这里再读一次锁只为拿 `adopted`/`directSources`；锁不存在时直接返回空集合。）

`packages/core/src/index.mjs` 的 install 导出块加 `managedSkillNames,`。
`packages/core/index.d.ts` 加：

```ts
export function managedSkillNames(context: InstallContext): Promise<Set<string>>;
```

- [ ] **Step 4: 实现 CLI 侧**

`packages/cli/src/cli/dispatcher.mjs` 的 `#core` 导入列表加 `managedSkillNames, ensureSkillLinks,`，并在 `let status;`（第 295 行）之前插入：

```js
  // 启动补齐：canonical 存在且受管集合非空时，把缺失/悬空的链接补回来。
  // 失败绝不影响启动；未安装 Skills 的项目零副作用（不创建任何目录）。
  try {
    const installContext = createInstallContext(false, { cwd: projectRoot, environment: process.env });
    const managed = await managedSkillNames(installContext);
    if (managed.size > 0) {
      const linkResult = await ensureSkillLinks(installContext, managed, { silent: true });
      if (linkResult.counts.linked > 0 || linkResult.counts.repaired > 0 || linkResult.counts.migrated > 0) {
        console.log(`Skills shared: ${formatLinkSummary(linkResult.counts)}`);
      }
      logConflicts(console, linkResult.conflicts);
    }
  } catch {
    // 启动补齐是尽力而为：任何异常都不阻断启动。
  }
```

导入补 `createInstallContext`、`formatLinkSummary`、`logConflicts`。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/skills-targets.test.mjs test/skills-single-copy.test.mjs` → PASS

- [ ] **Step 6: 跑全量测试并提交**

Run: `npm test`
Expected: 全绿

```bash
git add packages/core/src/skills/install.mjs packages/core/src/index.mjs packages/core/index.d.ts packages/cli/src/cli/dispatcher.mjs packages/cli/vendor/core-src test/
git commit -m "feat: repair skill links on agent launch from the managed-name set only"
```

---

### Task 9: 状态语义（§8）+ CLI 状态输出

**Files:**
- Modify: `packages/core/src/skills/install.mjs:420-437`、`packages/core/index.d.ts:308-314`
- Modify: `packages/cli/src/cli/skills-cli.mjs:418-431`（顺带删 72 行的死导入 `writeInstallMetadata`）
- Test: `test/skills-single-copy.test.mjs`、`test/cli-surface.test.mjs`（状态输出断言）

**Interfaces:**
- Consumes: `classifyShareEntry`
- Produces: `skillsInstallationStatus` 返回值新增：
  - `targets[].state: "canonical" | "linked" | "fallback" | "missing" | "conflict"`
  - `targets[].counts: { linked, fallback, missing, conflict, unmanaged? }`（canonical 下为 `{ present, total }`）
  - 顶层 `state: "optimized" | "degraded" | "incomplete"`、`operational`、`optimized`、`degraded`、`incomplete`

- [ ] **Step 1: 写失败测试（追加到 `test/skills-single-copy.test.mjs`）**

```js
test("status reports linked vs fallback vs conflict and the overall install state", async () => {
  await withTempDirectory("avenic-status-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);
        const installed = runAgent(projectRoot, ["skills", "install"], environment);
        assert.equal(installed.status, 0, installed.stderr);

        const optimized = runAgent(projectRoot, ["skills", "status"], environment);
        assert.match(optimized.stdout, /Claude Code: shared \(2\/2\)/, "alpha + beta are linked");
        assert.match(optimized.stdout, /Optimized/);

        // 降级：把链接换成真实副本 → "可用但未共享"，仍然 operational
        const shared = path.join(projectRoot, ".claude", "skills", "alpha");
        await unlink(shared);
        await cp(path.join(projectRoot, ".agents", "skills", "alpha"), shared, { recursive: true });
        const degraded = runAgent(projectRoot, ["skills", "status"], environment);
        assert.match(degraded.stdout, /Claude Code: available — copies, not shared \(2\/2\)/);
        assert.match(degraded.stdout, /Degraded/);

        // 冲突：用户自建链接指向别处
        await unlink(shared);
        const userTarget = path.join(projectRoot, "user-skills", "alpha");
        await mkdir(userTarget, { recursive: true });
        await writeFile(path.join(userTarget, "SKILL.md"), "user\n");
        if (process.platform === "win32") {
          await symlink(userTarget, shared, "junction");
        } else {
          await symlink(path.relative(path.dirname(shared), userTarget), shared, "dir");
        }
        const conflicted = runAgent(projectRoot, ["skills", "status"], environment);
        assert.match(conflicted.stdout, /conflict/i);
        assert.match(conflicted.stdout, /Incomplete/);
      });
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/skills-single-copy.test.mjs`
Expected: FAIL — 输出里没有 `shared (2/2)` / `Optimized`

- [ ] **Step 3: 实现 core**

`skillsInstallationStatus` 整体替换为：

```js
export async function skillsInstallationStatus(context) {
  if (!existsSync(context.lockFile)) {
    return null;
  }
  const manifest = await readJson(context.lockFile);
  const groups = (manifest.sources ?? []).map((source) => ({
    source,
    skills: (source.skills ?? []).map((name) => ({ name })),
  }));
  const manifestPacks = manifest.packs ?? (manifest.pack ? [manifest.pack] : []);
  const names = [...new Set([...groups.flatMap((group) => group.skills.map((skill) => skill.name)), ...(manifest.adopted ?? [])])];
  const targets = [];
  let canonicalComplete = true;
  let linkedTotal = 0;
  let fallbackTotal = 0;
  let brokenTotal = 0;
  for (const targetConfig of context.targets) {
    const directory = targetConfig.destination;
    if (!targetConfig.shareFrom) {
      const present = names.filter((name) => existsSync(path.join(directory, name, "SKILL.md"))).length;
      canonicalComplete = canonicalComplete && present === names.length;
      targets.push({
        ...targetConfig,
        present,
        total: names.length,
        complete: present === names.length,
        state: "canonical",
        counts: { present, total: names.length },
      });
      continue;
    }
    // 只读判定：不跟随内容比较（sameTree 留给安装路径），真实目录一律记 fallback。
    const counts = { linked: 0, fallback: 0, missing: 0, conflict: 0 };
    for (const name of names) {
      const linkPath = path.join(directory, name);
      const canonicalPath = path.join(targetConfig.shareDestination, name);
      const verdict = await classifyShareEntry(canonicalPath, linkPath);
      if (verdict.state === "linked" || verdict.state === "repair") {
        counts.linked += 1;
      } else if (verdict.state === "conflict") {
        counts.conflict += 1;
      } else if (verdict.state === "real-directory") {
        counts.fallback += 1;
      } else {
        counts.missing += 1;
      }
    }
    const complete = canonicalComplete && counts.missing === 0 && counts.conflict === 0;
    const state = counts.conflict > 0
      ? "conflict"
      : counts.missing > 0
        ? "missing"
        : counts.fallback > 0
          ? "fallback"
          : "linked";
    linkedTotal += counts.linked;
    fallbackTotal += counts.fallback;
    brokenTotal += counts.missing + counts.conflict;
    targets.push({
      ...targetConfig,
      present: counts.linked + counts.fallback,
      total: names.length,
      complete,
      state,
      counts,
    });
  }
  const operational = canonicalComplete && brokenTotal === 0;
  const optimized = operational && fallbackTotal === 0;
  const degraded = operational && fallbackTotal > 0;
  const incomplete = !operational;
  return {
    groups,
    packs: manifestPacks,
    names,
    targets,
    // 汇总：optimized = 全部链接；degraded = 可用但存在降级副本；incomplete = 有缺失或冲突。
    state: optimized ? "optimized" : degraded ? "degraded" : "incomplete",
    operational,
    optimized,
    degraded,
    incomplete,
  };
}
```

`install.mjs` 导入 `classifyShareEntry`（Task 5 已加）。

`packages/core/index.d.ts` 的 `InstallTarget` 与 `InstallStatus` 更新：

```ts
export interface InstallTargetStatus extends InstallTarget {
  present: number;
  total: number;
  complete: boolean;
  state: "canonical" | "linked" | "fallback" | "missing" | "conflict";
  counts: { linked?: number; fallback?: number; missing?: number; conflict?: number; present?: number; total?: number };
}
export interface InstallStatus {
  groups: SkillGroup[];
  packs: Array<{ id?: string; name?: string } | string>;
  names: string[];
  targets: InstallTargetStatus[];
  state: "optimized" | "degraded" | "incomplete";
  operational: boolean;
  optimized: boolean;
  degraded: boolean;
  incomplete: boolean;
}
```

- [ ] **Step 4: 实现 CLI 输出**

`packages/cli/src/cli/skills-cli.mjs` 的 `commandStatus` 循环改为：

```js
  for (const targetConfig of status.targets) {
    if (targetConfig.state === "canonical") {
      io.log(`${targetConfig.complete ? "✓" : "!"} ${targetConfig.label}: ${targetConfig.present}/${targetConfig.total}`);
      continue;
    }
    if (targetConfig.state === "linked") {
      io.log(`✓ ${targetConfig.label}: shared (${targetConfig.counts.linked}/${targetConfig.total})`);
    } else if (targetConfig.state === "fallback") {
      io.log(`⚠ ${targetConfig.label}: available — copies, not shared (${targetConfig.present}/${targetConfig.total})`);
    } else if (targetConfig.state === "missing") {
      io.log(`! ${targetConfig.label}: links missing — run: avenic skills install`);
    } else {
      io.log(`! ${targetConfig.label}: ${targetConfig.counts.conflict} conflicting entr${targetConfig.counts.conflict === 1 ? "y" : "ies"} — left untouched, resolve manually`);
    }
  }
  io.log(status.state === "optimized" ? "Optimized" : status.state === "degraded" ? "Degraded" : "Incomplete");
```

同时删除第 72 行的 `writeInstallMetadata,` 死导入（该文件从未调用它）。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/skills-single-copy.test.mjs`
Run: `node --test test/cli-surface.test.mjs` → 按新输出更新状态相关断言
Expected: PASS

- [ ] **Step 6: 跑全量测试并提交**

Run: `npm test`
Expected: 全绿

```bash
git add packages/core/src/skills/install.mjs packages/core/index.d.ts packages/cli/src/cli/skills-cli.mjs packages/cli/vendor/core-src test/
git commit -m "feat: status reports linked/fallback/conflict plus optimized/degraded/incomplete"
```

---

### Task 10: 插件侧（服务、命令、启动补齐、状态映射）

> **前置：本 Task 必须在 core 与 CLI 发布之后做**（插件依赖**已发布**的 `@avenic/core`，见 spec §4.1 与 `packages/vscode/package.json:404`）。发布是 USER CHECKPOINT，见 Task 11 Step 1-4。

**Files:**
- Modify: `packages/vscode/package.json`（依赖 + 命令 + 版本）、`packages/vscode/src/services/skills.ts`、`packages/vscode/src/commands/skills-commands.ts`、`packages/vscode/src/services/agents.ts:140`、`packages/vscode/src/dashboard/state.ts:19-29`、`packages/vscode/src/views/view-models.ts:199-207`
- Test: `packages/vscode/test/skills-commands.test.ts`、`packages/vscode/test/dashboard.test.ts`

**Interfaces:**
- Consumes: `ensureSkillLinks`、`managedSkillNames`、`formatLinkSummary`（来自已发布的 `@avenic/core`）
- Produces: 服务 `repairLinks(scope, cwd?, environment?)`、命令 `avenic.skills.repairLinks`、Launch 前补齐、Dashboard 行文案

- [ ] **Step 1: 写失败测试**

`packages/vscode/test/skills-commands.test.ts` 追加（沿用该文件既有的 `testEnv`/fixture helper 与 `expectSkillDirs`）：

```ts
test("repairLinks recreates a missing shared link from the managed set", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    await skills.installPacks("project", ["common"], projectRoot, environment);
    const shared = path.join(projectRoot, ".claude", "skills", "alpha");
    await rm(shared, { recursive: true, force: true });

    const result = await skills.repairLinks("project", projectRoot, environment);
    assert.ok(result.counts.linked >= 1);
    assert.equal(lstatSync(shared).isSymbolicLink(), true);
    assert.equal(existsSync(path.join(projectRoot, ".claude", "skills", "outsider")), false);
  });
});
```

`packages/vscode/test/dashboard.test.ts` 追加/更新：安装后 `skillsHealth` 行的 `details` 从 `1/1` 变为共享语义（例如 `Claude Code` 行 `details === "shared"`），`ok` 仍为 `true`。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:vscode`
Expected: FAIL — `skills.repairLinks is not a function`

- [ ] **Step 3: 实现**

`packages/vscode/src/services/skills.ts` 追加：

```ts
import {
  ensureSkillLinks as coreEnsureSkillLinks,
  managedSkillNames as coreManagedSkillNames,
} from "@avenic/core"; // 合并到既有导入

// 启动/手动补齐共享链接：只处理 lock 记录的受管技能，插件侧不做任何 fs 判断。
export async function repairLinks(scope: Scope, cwd?: string, environment: Env = process.env) {
  const installContext = context(scope, cwd, environment);
  const managed = await coreManagedSkillNames(installContext);
  if (managed.size === 0) {
    return { counts: { linked: 0, repaired: 0, migrated: 0, fallback: 0, conflict: 0, unchanged: 0, skipped: 0 }, conflicts: [], targets: {} };
  }
  return coreEnsureSkillLinks(installContext, managed, { silent: true });
}
```

`packages/vscode/src/commands/skills-commands.ts` 注册命令（放在 `adoptPacked` 相关注册之后）：

```ts
  // 共享链接修复：与安装/启动同一套 core 逻辑，插件只负责作用域选择与提示。
  register("avenic.skills.repairLinks", async () => {
    if (busy()) return;
    const scope = await pickScope();
    if (scope === null) return;
    const cwd = await scopeCwd(scope, deps.resolveRoot);
    if (cwd === null) return;
    const result = await runMutation(deps.queue, () => withProgress("修复 Skills 链接", async () => skills.repairLinks(scope, cwd)), () => deps.refresh());
    const { counts, conflicts } = result;
    await vscode.window.showInformationMessage(
      counts.linked + counts.repaired + counts.migrated === 0
        ? "Skills 链接已是最新"
        : `链接 ${counts.linked} · 迁移 ${counts.migrated} · 降级 ${counts.fallback} · 冲突 ${conflicts.length}`,
    );
  });
```

`packages/vscode/src/services/agents.ts` 的 `prepareAgentLaunch`：在 `let done = false;`（第 140 行）之前插入：

```ts
  // 启动补齐共享链接：尽力而为，绝不阻断启动。
  try {
    const { repairLinks } = await import("./skills.ts");
    await repairLinks("project", projectRoot);
  } catch {
    // ignore
  }
```

`packages/vscode/src/dashboard/state.ts` 的 `skillsHealthRows` 改为按 `state` 生成文案：

```ts
  const details = target.state === "canonical"
    ? `${target.present}/${target.total}`
    : target.state === "linked"
      ? "shared"
      : target.state === "fallback"
        ? "copies, not shared"
        : target.state === "missing"
          ? "links missing"
          : "conflict";
```

`packages/vscode/src/views/view-models.ts:199-207` 的"安装目标 N/M"聚合改用 `status.targets.filter((t) => t.complete).length`（含义不变，但可顺带显示共享状态；若聚合语义不变则不动）。

`packages/vscode/package.json`：
- `devDependencies["@avenic/core"]` 提升到已发布的新版本（如 `^1.1.0`）
- `contributes.commands` 加 `{ "command": "avenic.skills.repairLinks", "title": "Avenic: 修复 Skills 链接", "category": "Avenic", "icon": "$(link)" }`
- `contributes.menus["view/title"]` 加 `{ "command": "avenic.skills.repairLinks", "when": "view == avenic.skills" }`
- `version` 提升到 `0.1.11`

- [ ] **Step 4: 安装依赖并运行测试**

Run: `npm install --prefix packages/vscode`（拉取新 core）
Run: `npm run test:vscode`
Expected: typecheck + 测试全绿

- [ ] **Step 5: 提交**

```bash
git add packages/vscode/src packages/vscode/package.json packages/vscode/package-lock.json packages/vscode/test
git commit -m "feat(vscode): repair shared skill links on demand and before launch; status rows show sharing state"
```

> `packages/vscode/package-lock.json` 是扩展自己的锁文件（与根目录 `package-lock.json` 不同）；只提交确实变化的那一个。

---

### Task 11: 文档、版本与发布顺序

**Files:**
- Modify: `README.md`、`packages/cli/README.md`、`docs/development.md`、`packages/vscode/CHANGELOG.md`、`packages/core/package.json`、`packages/cli/package.json`、`packages/vscode/package.json`

- [ ] **Step 1: 文档**

- `README.md` / `packages/cli/README.md`：在 Skills 章节写明"同一作用域只保留一份物理文件：`.agents/skills/<name>` 是真身，`.claude/skills/<name>` 是指向它的链接（Windows 为 junction）"；`avenic skills status` 输出示例更新为新文案（`shared` / `copies, not shared` / `Optimized`）；`avenic skills uninstall` 的说明写明链接会被解除。
- `docs/development.md`：在发布流程（第 39、48 行附近）补一句"core 变更后必须先 `npm run sync-core` 再发布 CLI；插件依赖已发布的 `@avenic/core`，故插件改动排在其后"。
- `packages/vscode/CHANGELOG.md`：新增 `0.1.11` 段落（Skills 单副本共享、状态文案、修复链接命令）。

- [ ] **Step 2: 版本提升（顺序不可换）**

```bash
# core：新增导出 + 行为变更 → minor
node -e "const f='packages/core/package.json';const p=require('./'+f);p.version='1.1.0';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
npm run sync-core
npm test          # 必须全绿再往下
```

- [ ] **Step 3: 提交并推送 core（USER CHECKPOINT：发布前停下来确认）**

```bash
git add packages/core/package.json packages/cli/vendor/core-src README.md packages/cli/README.md docs/development.md packages/vscode/CHANGELOG.md
git commit -m "chore(core): 1.1.0 — skills single-copy sharing (links), status semantics, managed-name repair"
git push
```

然后**请用户确认**后执行（npm 发布是认证类操作）：

```bash
cd packages/core && npm publish
```

- [ ] **Step 4: CLI 版本提升 + 发布（USER CHECKPOINT）**

```bash
node -e "const f='packages/cli/package.json';const p=require('./'+f);p.version='1.2.0';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
npm test
git add packages/cli/package.json && git commit -m "chore(cli): 1.2.0 — shared skills, new status output, launch repair"
git push
cd packages/cli && npm publish   # 需用户确认
```

- [ ] **Step 5: 打包 VSIX（不上传）**

Run: `npm --prefix packages/vscode run package`
Expected: 产出 `packages/vscode/dist/avenic-agent-manager.vsix`（版本 `0.1.11`），报告路径给用户。

- [ ] **Step 6: 交付报告**

向用户报告：core/CLI 已发布版本、VSIX 路径与版本、**等待用户自行上传 Marketplace（本计划不上传任何版本，尤其不得再操作已上传的 0.1.10）**。

---

## 自审记录

- **Spec 覆盖**：§3.2 归属判定 → Task 2/3；§5.1 四阶段 → Task 4；§5.2 卸载 → Task 5；§5.3 接管 → Task 7；§5.4 直装 → Task 6；§5.5 启动补齐 → Task 8；§6 受管集合 → Task 8；§7 `sameTree` → Task 2；§8 状态 → Task 9；§9 安全不变量 → Task 2/3/5（`lstat` 守卫、`isInside`、绝不 unlink 外来链接）；§10 降级 → Task 3 的 `createLink` 注入与 `fallback` 计数；§11 九路径矩阵 → Task 4/5/6/7/8/9；§12 影响面 → 各 Task 的 Files 块；§13 测试（含 A1/A2 两个用户指定回归）→ Task 4 Step 1；§14 发布顺序 → Task 11。
- **命名一致性**：`ensureSkillLinks` / `classifyShareEntry` / `sameTree` / `removeLinkSafely` / `createSkillLink` / `canonicalTargets` / `shareTargets` / `managedSkillNames` / `formatLinkSummary` / `logConflicts` / `shareDestination` / `counts` 在全部 Task 中同名同形。
- **已知未覆盖**：`README` 之外的其他文档若在实施中冒出对"两份拷贝"的描述，按 Task 11 Step 1 的口径一并更新。
