# Avenic 品牌迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Avenic 仓库从 AgentHome 品牌完整重塑为 Avenic（包名、bin、env、路径、文案、文档、GitHub 仓库、npm 发布、旧包 deprecate），数据零丢失。

**Architecture:** 单一 GitHub 仓库含 core / cli / vscode 三个 package；core = 唯一业务逻辑层（公开 npm 包 `@avenic/core`），CLI 与 VS Code Extension 是同一仓库的两个客户端 package。品牌迁移不改任何架构，持久化数据通过"兼容读 + 自动迁移"过渡。

**Tech Stack:** Node ≥18.17 纯 ESM（无构建、无第三方运行时依赖）、node:test、npm 11、gh CLI（已登录 Echo-Kang-hub）、Windows + Git Bash。

**Spec:** `docs/superpowers/specs/2026-09-07-avenic-rebrand-design.md`（计划的每个任务从 spec 论证，执行者需同时读 spec）

## Global Constraints

- 术语：不使用 "monorepo"，称"Avenic 仓库 / 单仓库多 package 结构"；CLI 与扩展是同一仓库的两个客户端 package。
- **C 类名称一律不改**：`.agents/` 全部子路径、`~/.agents/skills`、`.claude/skills`、`~/.claude/skills`、agent id `claude`/`codex`/`opencode`、`AGENTS` 表、`getAgent`、LICENSE 版权行、gitignore `# Agent Runtime` 注释。禁止机械替换所有含 agent 的名称。
- `.agent-skills-profile` 仅保留**读取**（历史遗留迁移源），不新写、不更名。
- 数据迁移原则：旧持久化文件"新名优先、旧名兼容、原子迁移"，**禁止任何数据丢失**。
- env：`AVENIC_STATE_DIR` / `AVENIC_CATALOG_SPEC` 为主；旧 `AGENTHOME_STATE_DIR` / `AGENTHOME_CATALOG_SPEC` 仅回退读 + stderr deprecation 提示。
- 根 package.json：内部名 `avenic-repo`，**不得**出现 `workspaces` 字段或 install 生命周期脚本（`test/packaging.test.mjs` 守护）。
- core 源码每次修改后执行 `npm run sync-core`（`npm test` 的 pretest 自动执行；`test/sync.test.mjs` 守护 vendor 一致性）。
- 版本统一 1.0.0（根、core、cli）。bin：`avenic` / `ave`；`ah` / `agenthome` 废弃。
- 旧名 `agenthome-cli`、`agenthome-catalog` **永不复用**（GitHub redirect 依赖此前提）。
- 历史归档文档不改：`docs/superpowers/specs/2026-09-06-split-cli-catalog-design.md`、`docs/superpowers/plans/2026-09-06-split-cli-catalog.md`。
- 输出长度纪律：不全文 cat 大文件；spec/plan 按需分段读；git diff 限制范围（`git diff --stat` + 按文件看）；测试日志只看失败与摘要行；定位内容用 rg/find/head/tail。
- Windows + Git Bash：spawn 相关测试沿用仓库现有 `.ps1` shim 模式（`.cmd` 无法被 spawnSync 直接启动）。
- 每个 Task：测试先行（改断言 → 确认失败 → 改实现 → 确认全绿 → review diff → commit）。
- Agent 自动执行一切 CLI 可完成的操作；USER CHECKPOINT 仅限：npm 浏览器 2FA、gh/npm 权限不足、网页授权。

---

### Task 0: 提交设计与计划文档

**Files:**
- Commit: `docs/superpowers/specs/2026-09-07-avenic-rebrand-design.md`（已存在）
- Commit: `docs/superpowers/plans/2026-09-07-avenic-rebrand.md`（本文件）
- Review & Commit: `docs/superpowers/plans/2026-09-06-vscode-extension.md`（未跟踪，rebrand 前就存在）、`.gitignore`（已修改，内容与 rebrand 无关——先 `git diff .gitignore` 确认其改动合理再提交）

**Interfaces:**
- Consumes: 无
- Produces: 干净的 git 基线，后续每个 Task 的 commit 可独立 review

- [ ] **Step 1: 检查工作区状态**

Run: `git status --short && git diff .gitignore | head -20`
Expected: 仅 `.gitignore`、两个计划文档、spec 文档。确认 `.gitignore` 改动合理（若是 `.agents/` 或缓存条目，属正常）。

- [ ] **Step 2: 提交文档**

```bash
git add docs/superpowers/specs/2026-09-07-avenic-rebrand-design.md docs/superpowers/plans/2026-09-07-avenic-rebrand.md
git commit -m "docs: Avenic rebrand design spec and implementation plan"
git add docs/superpowers/plans/2026-09-06-vscode-extension.md .gitignore
git commit -m "chore: track vscode extension plan and gitignore update"
```

Expected: 两个 commit 成功，工作区干净。

---

### Task 1: 根 manifest 改名 `avenic-repo`

**Files:**
- Modify: `test/packaging.test.mjs`（新增根 manifest 测试）
- Modify: `package.json`（根）

**Interfaces:**
- Consumes: 无（manifest-only）
- Produces: 根 manifest 身份 `avenic-repo@1.0.0`，bin `avenic`/`ave`；后续 GitHub 根安装模式依赖此 bin。

- [ ] **Step 1: 写失败测试**

在 `test/packaging.test.mjs` 末尾追加：

```js
test("root manifest carries the internal avenic-repo identity", async () => {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "avenic-repo");
  assert.equal(manifest.version, "1.0.0");
  assert.deepEqual(Object.keys(manifest.bin).sort(), ["ave", "avenic"]);
  assert.equal(manifest.repository.url, "git+https://github.com/Echo-Kang-hub/avenic.git");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/packaging.test.mjs 2>&1 | tail -5`
Expected: FAIL，新测试报 `manifest.name` 为 `agenthome-cli-monorepo`。

- [ ] **Step 3: 修改根 package.json**

- `"name": "agenthome-cli-monorepo"` → `"name": "avenic-repo"`
- `"version": "5.7.7"` → `"version": "1.0.0"`
- `"bin": { "agenthome": ..., "ah": ... }` → `"bin": { "avenic": "packages/cli/scripts/skills.mjs", "ave": "packages/cli/scripts/skills.mjs" }`
- `"repository.url"` → `"git+https://github.com/Echo-Kang-hub/avenic.git"`
- **保持不动**：`private: true`、无 workspaces、无 install 生命周期脚本、`files`、`engines`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/packaging.test.mjs 2>&1 | tail -5`
Expected: PASS（本文件全部测试）。

- [ ] **Step 5: Commit**

```bash
git add package.json test/packaging.test.mjs
git commit -m "feat: rebrand root manifest to avenic-repo (bin avenic/ave, v1.0.0)"
```

---

### Task 2: core 包改名 `@avenic/core`

**Files:**
- Modify: `test/packaging.test.mjs`（core manifest 断言）
- Modify: `packages/core/package.json`
- Modify: `packages/core/src/index.mjs:1`、`packages/core/index.d.ts:1`（注释）
- Regenerate: `packages/cli/vendor/core-src/`（`npm run sync-core`）

**Interfaces:**
- Consumes: 无
- Produces: npm 包身份 `@avenic/core@1.0.0`（`publishConfig.access: "public"` 保留）；M6 发布此包。

- [ ] **Step 1: 修改失败断言**

`test/packaging.test.mjs` 的 `core manifest is configured for public publishing` 测试中（第 43、46 行就地修改，不新增行）：

```js
assert.equal(manifest.name, "@agenthome-cli/core");  // 旧
assert.equal(manifest.version, "5.8.0");             // 旧
```
改为：

```js
assert.equal(manifest.name, "@avenic/core");
assert.equal(manifest.version, "1.0.0");
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/packaging.test.mjs 2>&1 | tail -5`
Expected: FAIL，core 断言不匹配。

- [ ] **Step 3: 修改 core manifest 与注释**

- `packages/core/package.json`：`"name": "@agenthome-cli/core"` → `"@avenic/core"`；`"version": "5.8.0"` → `"1.0.0"`；其余（`publishConfig`、`files`、`exports`、`types`）不动。
- `packages/core/src/index.mjs:1`：`// Public API of @agenthome-cli/core.` → `// Public API of @avenic/core.`
- `packages/core/index.d.ts:1`：`// Type declarations for @agenthome-cli/core.` → `// Type declarations for @avenic/core.`

- [ ] **Step 4: 同步 vendor 并运行测试**

```bash
npm run sync-core && node --test test/packaging.test.mjs test/sync.test.mjs 2>&1 | tail -5
```

Expected: PASS（vendor 副本注释随 sync 更新）。

- [ ] **Step 5: Commit**

```bash
git add packages/core/package.json packages/core/src/index.mjs packages/core/index.d.ts packages/cli/vendor/core-src test/packaging.test.mjs
git commit -m "feat(core): rebrand @agenthome-cli/core to @avenic/core v1.0.0"
```

---

### Task 3: CLI 包改名 `avenic`（bin avenic/ave）

**Files:**
- Modify: `test/packaging.test.mjs`（bin 名断言）
- Modify: `packages/cli/package.json`

**Interfaces:**
- Consumes: 无
- Produces: npm 包身份 `avenic@1.0.0`，bin `avenic`/`ave`，自更新元数据 `avenic.packageSpec: "avenic@latest"`。

- [ ] **Step 1: 修改失败断言**

`test/packaging.test.mjs` 的 `published bin names avoid shell collisions` 测试中：

```js
assert.deepEqual(Object.keys(manifest.bin).sort(), ["agenthome", "ah"]);  // 旧
```
改为：

```js
assert.deepEqual(Object.keys(manifest.bin).sort(), ["ave", "avenic"]);
```

（注释中"Single-word names are collision-free in PowerShell, cmd.exe, Git Bash"保留；`ave` 已实测：npm 同名包为 2015 年死库无 bin、PowerShell 无 alias、PATH 无占用。）

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/packaging.test.mjs 2>&1 | tail -5`
Expected: FAIL，bin 断言不匹配。

- [ ] **Step 3: 修改 CLI manifest**

`packages/cli/package.json`：
- `"name": "agenthome-cli"` → `"avenic"`
- `"version": "5.8.0"` → `"1.0.0"`
- `"bin": { "agenthome": "scripts/skills.mjs", "ah": "scripts/skills.mjs" }` → `"bin": { "avenic": "scripts/skills.mjs", "ave": "scripts/skills.mjs" }`
- `"agentHome": { "packageSpec": "agenthome-cli@latest" }` → `"avenic": { "packageSpec": "avenic@latest" }`
- 其余（`imports` `#core`、`prepack`、`files`、`engines`）不动。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/packaging.test.mjs 2>&1 | tail -5`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/cli/package.json test/packaging.test.mjs
git commit -m "feat(cli): rebrand package to avenic with bins avenic/ave"
```

---

### Task 4: env 变量 AVENIC_* 主名 + AGENTHOME_* 回退

**Files:**
- Modify: `packages/core/src/skills/paths.mjs`（stateRoot + 共享 helper）
- Modify: `packages/core/src/skills/catalog.mjs:24-25`（catalog spec env）
- Modify（测试 env 改名 + 新增回退测试）: `test/runtime.test.mjs`、`test/skills.test.mjs`、`test/catalog-cache.test.mjs`、`test/skills-direct-add.test.mjs`、`test/cli-surface.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `deprecatedEnvironmentValue(environment, primary, legacy)`（paths.mjs 内部导出，供 catalog.mjs 复用；**不进 barrel、不进 index.d.ts**）；`stateRoot` 认可 `AVENIC_STATE_DIR`；`loadDefaultCatalogSpec` 认可 `AVENIC_CATALOG_SPEC`。

- [ ] **Step 1: 测试改名 + 写失败测试**

1. 把 `test/*.test.mjs` 中所有 `AGENTHOME_STATE_DIR` 替换为 `AVENIC_STATE_DIR`、`AGENTHOME_CATALOG_SPEC` 替换为 `AVENIC_CATALOG_SPEC`（仅测试文件，用 rg 定位：`rg -l AGENTHOME_ test/ integration/`）。
2. 在 `test/runtime.test.mjs`（或合适的既有 describe 内）新增：

```js
test("stateRoot prefers AVENIC_STATE_DIR and falls back to AGENTHOME_STATE_DIR", () => {
  assert.equal(stateRoot({ AVENIC_STATE_DIR: "/x" }), "/x");
  assert.equal(stateRoot({ AGENTHOME_STATE_DIR: "/legacy" }), "/legacy");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test 2>&1 | tail -8`
Expected: FAIL——改了 env 名的测试全部失败（stateRoot 不认识 `AVENIC_STATE_DIR`，落到默认目录），新回退测试失败。

- [ ] **Step 3: 实现**

`packages/core/src/skills/paths.mjs`：

```js
export function deprecatedEnvironmentValue(environment, primary, legacy) {
  if (environment[primary]) return environment[primary];
  if (environment[legacy]) {
    console.warn(`Environment variable ${legacy} is deprecated; use ${primary}`);
    return environment[legacy];
  }
  return undefined;
}

export function stateRoot(environment = process.env) {
  const override = deprecatedEnvironmentValue(environment, "AVENIC_STATE_DIR", "AGENTHOME_STATE_DIR");
  if (override) return override;
  return path.join(
    environment.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "avenic",  // 旧值 "agent-skills"；目录迁移在 Task 8
  );
}
```

`packages/core/src/skills/catalog.mjs` 顶部 import 加 `deprecatedEnvironmentValue`（来自 `./paths.mjs`），并把 env 读取处改为：

```js
const catalogSpec = deprecatedEnvironmentValue(environment, "AVENIC_CATALOG_SPEC", "AGENTHOME_CATALOG_SPEC");
```

（保持原有优先级顺序：env > catalog.json > 默认 spec。）

- [ ] **Step 4: 同步 vendor 并运行测试**

```bash
npm run sync-core && npm test 2>&1 | tail -8
```

Expected: PASS（警告输出在 stderr，不破坏断言；若某测试用旧 env 名且断言了 stderr 为空，改用新名）。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/skills/paths.mjs packages/core/src/skills/catalog.mjs packages/cli/vendor/core-src test/
git commit -m "feat(core): AVENIC_* env vars with AGENTHOME_* fallback"
```

---

### Task 5: 代码符号与 UI 文案全量替换

**Files:**
- Modify: `packages/cli/src/cli/self-update.mjs`、`packages/cli/src/cli/dispatcher.mjs`、`packages/cli/src/cli/skills-cli.mjs`
- Modify: `packages/core/src/runtime/sessions.mjs`（tmp 锁名 + 注释）、`packages/core/src/runtime/adapters/claude.mjs:71`、`packages/core/src/runtime/adapters/codex.mjs:130`（注释）、`packages/cli/scripts/watchdog.mjs:1`（注释）
- Modify: `test/cli-surface.test.mjs`（断言）
- Regenerate: `packages/cli/vendor/core-src/`

**Interfaces:**
- Consumes: Task 3 的 bin 名、Task 4 的 env helper
- Produces: `avenicPackageSpec(packageRoot)`、`updateAvenic(packageRoot, options)`（原 `agentHomePackageSpec`/`updateAgentHome`，两个调用点签名不变）；用户可见文案全 Avenic。

- [ ] **Step 1: 修改失败断言**

`test/cli-surface.test.mjs`（用 rg 定位所有匹配行）：
- `/AgentHome/` → `/Avenic/`
- `/shorthand: ah/` → `/shorthand: ave/`
- `/Usage: agenthome /g` → `/Usage: avenic /g`
- `/Run: agenthome claude init/` → `/Run: avenic claude init/`
- tmp 前缀字符串 `agenthome-fake-npm-`、`agenthome-help-` 等 → `avenic-*`（cosmetic，统一品牌）

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test 2>&1 | tail -8`
Expected: FAIL，cli-surface 文案断言不匹配。

- [ ] **Step 3: 源码替换（精确清单）**

`packages/cli/src/cli/self-update.mjs`：
- `agentHomePackageSpec` → `avenicPackageSpec`；`metadata.agentHome?.packageSpec` → `metadata.avenic?.packageSpec`
- `"Echo-Kang-hub/agenthome-cli#main"` → `"Echo-Kang-hub/avenic#main"`
- `updateAgentHome` → `updateAvenic`；`"Updating AgentHome"` → `"Updating Avenic"`；`"AgentHome update complete"` → `"Avenic update complete"`

`packages/cli/src/cli/dispatcher.mjs`：
- `:26` import `updateAgentHome` → `updateAvenic`；`:420` 调用点同步
- `:60` `CLI: agenthome (shorthand: ah)` → `CLI: avenic (shorthand: ave)`
- `:63-78` usage 行中全部 `agenthome ` → `avenic `
- `:58` `AgentHome\n` → `Avenic\n`；`:95` `Update AgentHome:` → `Update Avenic:`；`:134` `AgentHome Runtime\n` → `Avenic Runtime\n`；`:313` `AgentHome Status\n` → `Avenic Status\n`；`:326` `AgentHome Doctor\n` → `Avenic Doctor\n`
- 其余错误信息里的 `agenthome`（如 `Run: agenthome claude init`）→ `avenic`

`packages/cli/src/cli/skills-cli.mjs`：
- `:64` import `updateAgentHome` → `updateAvenic`；`:1017` 调用点同步
- `:113` `AgentHome catalog` → `Avenic catalog`；`:943`、`:1003` `AgentHome Git clone` → `Avenic Git clone`

`packages/core/src/runtime/sessions.mjs`：
- `:213` 注释、`:216` `` `agenthome-launch-${key}` `` → `` `avenic-launch-${key}` ``（临时目录，硬切）、`:243`、`:271` 注释中的 `agenthome` → `avenic`

`packages/core/src/runtime/adapters/claude.mjs:71`、`codex.mjs:130`：注释中 `agenthome` → `avenic`。

`packages/cli/scripts/watchdog.mjs:1`：注释中 `agenthome` → `avenic`。

**禁止**：不要动 `.agents/`、`AGENTS`、`getAgent`、`.agent-skills-profile` 常量（Task 7 处理）、env 回退名（Task 4 的 legacy 行）。

- [ ] **Step 4: 同步 vendor 并运行测试**

```bash
npm run sync-core && npm test 2>&1 | tail -8
```

Expected: PASS。

- [ ] **Step 5: 残留检查**

Run: `rg -n -i "agenthome" packages/cli/src packages/core/src packages/cli/scripts | head -20`
Expected: 仅剩 Task 7 未处理的 `.agent-skills-profile` 常量与 env legacy 回退名（`AGENTHOME_*`）；其余必须为空。

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src packages/cli/scripts packages/core/src packages/cli/vendor/core-src test/cli-surface.test.mjs
git commit -m "feat: rebrand user-facing text and internal symbols to Avenic"
```

---

### Task 6: integration 测试与 GitHub 根安装模式更新

**Files:**
- Modify: `integration/global-install.mjs`

**Interfaces:**
- Consumes: Task 1/3 的 bin 名
- Produces: `test:install` 双模式（registry tarball + GitHub 根包）对 `avenic`/`ave` 的验证

- [ ] **Step 1: 修改断言（测试先行）**

`integration/global-install.mjs`：
- `"agenthome.cmd"` → `"avenic.cmd"`、`"ah.cmd"` → `"ave.cmd"`（win32 分支；POSIX 分支同改 `agenthome`/`ah` → `avenic`/`ave`）
- `/shorthand: ah/` → `/shorthand: ave/`
- tmp 前缀 `agenthome-global-install-` → `avenic-global-install-`
- 所有 `AGENTHOME_*` env → `AVENIC_*`

- [ ] **Step 2: 运行确认失败**

Run: `npm run test:install 2>&1 | tail -12`
Expected: FAIL，找不到旧 bin 名（此时 Task 1/3 已改 bin）。

- [ ] **Step 3: 运行确认通过**

若 Step 2 已因 Task 1/3 的 bin 改名而通过（即仅断言文件过期），本步无需改源码，直接确认全绿。

Run: `npm run test:install 2>&1 | tail -12`
Expected: PASS（双模式均绿）。

- [ ] **Step 4: Commit**

```bash
git add integration/global-install.mjs
git commit -m "test: rebrand integration harness to avenic/ave"
```

---

### Task 7: 项目文件迁移（.agent-skills.* → .avenic.*）

**Files:**
- Modify: `packages/core/src/skills/paths.mjs`（常量 + 迁移函数）
- Modify: `packages/core/src/skills/install.mjs`（createInstallContext 调用迁移）
- Test: 新建 `test/migration.test.mjs`
- Regenerate: `packages/cli/vendor/core-src/`

**Interfaces:**
- Consumes: 无
- Produces: `PROJECT_CONFIG_FILE = ".avenic.json"`、`PROJECT_LOCK_FILE = ".avenic.lock.json"`、`LEGACY_PROJECT_CONFIG_FILE = ".agent-skills.json"`、`LEGACY_PROJECT_LOCK_FILE = ".agent-skills.lock.json"`、`migrateLegacyProjectFiles(cwd)`（内部，不进 barrel/d.ts）；`createInstallContext` 返回前自动完成迁移。

- [ ] **Step 1: 写失败测试**

新建 `test/migration.test.mjs`：

```js
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createInstallContext } from "../packages/core/src/index.mjs";

test("createInstallContext migrates legacy project files to .avenic.*", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "avenic-migrate-"));
  writeFileSync(path.join(cwd, ".agent-skills.json"), JSON.stringify({ schemaVersion: 2, packs: ["common"] }));
  writeFileSync(path.join(cwd, ".agent-skills.lock.json"), JSON.stringify({ catalog: { spec: "x" } }));
  const context = createInstallContext(false, { cwd });
  assert.equal(context.configFile, path.join(cwd, ".avenic.json"));
  assert.equal(context.lockFile, path.join(cwd, ".avenic.lock.json"));
  assert.deepEqual(JSON.parse(readFileSync(context.configFile, "utf8")), { schemaVersion: 2, packs: ["common"] });
  assert.equal(existsSync(path.join(cwd, ".agent-skills.json")), false);
  assert.equal(existsSync(path.join(cwd, ".agent-skills.lock.json")), false);
});

test("migration never overwrites existing new files", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "avenic-migrate-"));
  // 两处都写合法 JSON，避免 createInstallContext 解析失败干扰断言
  writeFileSync(path.join(cwd, ".avenic.json"), JSON.stringify({ schemaVersion: 2, packs: ["fresh"] }));
  writeFileSync(path.join(cwd, ".agent-skills.json"), JSON.stringify({ schemaVersion: 2, packs: ["old"] }));
  const context = createInstallContext(false, { cwd });
  assert.deepEqual(JSON.parse(readFileSync(context.configFile, "utf8")), { schemaVersion: 2, packs: ["fresh"] });
  assert.equal(existsSync(path.join(cwd, ".agent-skills.json")), true);
});
```

（`createInstallContext(false, {cwd})` 为项目作用域；断言以源码实际返回键为准，若 `configFile`/`lockFile` 键名不同按源码修正测试。）

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/migration.test.mjs 2>&1 | tail -6`
Expected: FAIL（旧名文件不会被识别，context 指向 `.agent-skills.*` 或测试报错）。

- [ ] **Step 3: 实现**

`packages/core/src/skills/paths.mjs`：

```js
import { existsSync, renameSync } from "node:fs";

export const PROJECT_CONFIG_FILE = ".avenic.json";
export const PROJECT_LOCK_FILE = ".avenic.lock.json";
export const LEGACY_PROJECT_CONFIG_FILE = ".agent-skills.json";
export const LEGACY_PROJECT_LOCK_FILE = ".agent-skills.lock.json";
export const LEGACY_PROFILE_FILE = ".agent-skills-profile";  // 保持旧名：仅历史读取

export function migrateLegacyProjectFiles(cwd) {
  for (const [legacy, current] of [
    [LEGACY_PROJECT_CONFIG_FILE, PROJECT_CONFIG_FILE],
    [LEGACY_PROJECT_LOCK_FILE, PROJECT_LOCK_FILE],
  ]) {
    const from = path.join(cwd, legacy);
    const to = path.join(cwd, current);
    if (!existsSync(to) && existsSync(from)) renameSync(from, to);  // 同目录原子 rename
  }
}
```

`packages/core/src/skills/install.mjs`：import `migrateLegacyProjectFiles`；在 `createInstallContext` 组装 context 前调用 `migrateLegacyProjectFiles(cwd)`。

- [ ] **Step 4: 同步 vendor 并运行全部测试**

```bash
npm run sync-core && npm test 2>&1 | tail -8
```

Expected: PASS。若既有测试 fixture 写入 `.agent-skills.json`（`test/skills.test.mjs` 等），全部改为 `.avenic.json`（rg 定位 `agent-skills` in test/，仅替换 PROJECT_CONFIG/LOCK 相关，**不动** `AGENTHOME_` 回退与 `.agent-skills-profile`）。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/skills/paths.mjs packages/core/src/skills/install.mjs packages/cli/vendor/core-src test/migration.test.mjs test/
git commit -m "feat(core): migrate .agent-skills.* project files to .avenic.* atomically"
```

---

### Task 8: 全局状态目录迁移（~/.config/agent-skills → ~/.config/avenic）

**Files:**
- Modify: `packages/core/src/skills/paths.mjs`（stateRoot）
- Test: `test/migration.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 4 的 `deprecatedEnvironmentValue`
- Produces: `stateRoot` 返回 `~/.config/avenic`（或 env 覆盖），并在新目录缺失、旧目录存在时一次性 rename 迁移；失败降级回旧目录（不丢数据）。

- [ ] **Step 1: 写失败测试**

`test/migration.test.mjs` 追加（fs import 中补 `mkdirSync`）：

```js
import { stateRoot } from "../packages/core/src/index.mjs";

test("stateRoot migrates ~/.config/agent-skills to avenic once", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "avenic-state-"));
  mkdirSync(path.join(root, "agent-skills", "catalog"), { recursive: true });
  writeFileSync(path.join(root, "agent-skills", "catalog.json"), "{}");
  const env = { XDG_CONFIG_HOME: root };
  assert.equal(stateRoot(env), path.join(root, "avenic"));
  assert.equal(existsSync(path.join(root, "avenic", "catalog.json")), true);
  assert.equal(existsSync(path.join(root, "agent-skills")), false);
});

test("stateRoot keeps legacy directory when rename fails", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "avenic-state-"));
  // 用一个同名文件占位，使 rename 失败
  writeFileSync(path.join(root, "avenic"), "blocked");
  mkdirSync(path.join(root, "agent-skills"));
  const env = { XDG_CONFIG_HOME: root };
  assert.equal(stateRoot(env), path.join(root, "agent-skills"));
});
```

（`stateRoot` 已确认经 barrel 导出：`packages/core/src/index.mjs` 导出、`packages/core/index.d.ts:168` 有 `stateRoot(environment?: ProcessEnvLike): string` 声明，直接 import 即可。）

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/migration.test.mjs 2>&1 | tail -6`
Expected: FAIL（stateRoot 仍返回 `agent-skills` 路径且不迁移）。

- [ ] **Step 3: 实现**

`packages/core/src/skills/paths.mjs` 的 `stateRoot` 默认分支：

```js
const root = environment.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const current = path.join(root, "avenic");
const legacy = path.join(root, "agent-skills");
if (!existsSync(current) && existsSync(legacy)) {
  try {
    renameSync(legacy, current);
  } catch {
    return legacy;  // 迁移失败降级：继续用旧目录，不丢数据
  }
}
return current;
```

- [ ] **Step 4: 同步 vendor 并运行全部测试**

```bash
npm run sync-core && npm test 2>&1 | tail -8
```

Expected: PASS。注意：本机若真实存在 `~/.config/agent-skills/`，运行测试后它会被迁移到 `~/.config/avenic/`——这是预期行为（spec §8）。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/skills/paths.mjs packages/cli/vendor/core-src test/migration.test.mjs
git commit -m "feat(core): migrate global state dir ~/.config/agent-skills to avenic"
```

---

### Task 9: 默认 catalog spec → avenic-catalog

**Files:**
- Modify: `packages/core/src/skills/catalog.mjs:11`
- Modify: 相关测试（若有 fixture 引用）
- Regenerate: `packages/cli/vendor/core-src/`

**Interfaces:**
- Consumes: 无
- Produces: `DEFAULT_CATALOG_SPEC = "Echo-Kang-hub/avenic-catalog#main"`（私有常量，不经 barrel）。

- [ ] **Step 1: 定位现有引用**

Run: `rg -n "agenthome-catalog" packages test integration`
Expected: 命中 `packages/core/src/skills/catalog.mjs:11`（及 vendor 副本）；若测试中有 fixture，一并列出。

- [ ] **Step 2: 写失败测试**

若 `loadDefaultCatalogSpec` 默认值没有直接断言，在 `test/catalog-cache.test.mjs` 追加：

```js
test("default catalog spec points at the avenic catalog", async () => {
  const environment = { ...process.env, AVENIC_STATE_DIR: mkdtempSync(path.join(os.tmpdir(), "avenic-spec-")) };
  delete environment.AGENTHOME_CATALOG_SPEC;
  delete environment.AVENIC_CATALOG_SPEC;
  assert.equal(await loadDefaultCatalogSpec(environment), "Echo-Kang-hub/avenic-catalog#main");
});
```

（按 catalog-cache.test.mjs 现有 import 与工具函数风格调整；若该文件已有默认 spec 测试，直接改其期望值。）

- [ ] **Step 3: 运行测试确认失败**

Run: `node --test test/catalog-cache.test.mjs 2>&1 | tail -6`
Expected: FAIL（默认值仍是 `agenthome-catalog`）。

- [ ] **Step 4: 修改常量**

`packages/core/src/skills/catalog.mjs:11`：

```js
const DEFAULT_CATALOG_SPEC = "Echo-Kang-hub/avenic-catalog#main";
```

（`Echo-Kang-hub/avenic-catalog` 由 M5 Task 13 rename 而来；本任务不改用户已存在锁文件中的旧 URL——redirect 兜底。）

- [ ] **Step 5: 同步 vendor 并运行测试**

```bash
npm run sync-core && npm test 2>&1 | tail -8
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/skills/catalog.mjs packages/cli/vendor/core-src test/catalog-cache.test.mjs
git commit -m "feat(core): default catalog spec now Echo-Kang-hub/avenic-catalog#main"
```

---

### Task 10: 文档与 active spec 品牌迁移

**Files:**
- Modify: `README.md`、`packages/cli/README.md`、`docs/development.md`
- Modify: `docs/superpowers/specs/2026-09-06-vscode-extension-design.md`（active spec）
- Modify: `docs/superpowers/plans/2026-09-06-vscode-extension.md`（pending plan，仅品牌字符串，不改结构）
- **不改**：`docs/superpowers/specs/2026-09-06-split-cli-catalog-design.md`、`docs/superpowers/plans/2026-09-06-split-cli-catalog.md`（历史归档）

**Interfaces:**
- Consumes: 全部新名称
- Produces: 文档零旧品牌残留（历史归档除外）

- [ ] **Step 1: 逐文件替换**

`README.md` 与 `packages/cli/README.md`：
- 标题与正文 `AgentHome` → `Avenic`
- `npm install -g agenthome-cli` → `npm install -g avenic`；`npm uninstall -g agenthome-cli` → `npm uninstall -g avenic`
- 命令示例 `agenthome ` → `avenic `；"`agenthome` 与简写 `ah`" → "`avenic` 与简写 `ave`"
- `Echo-Kang-hub/agenthome-catalog` → `Echo-Kang-hub/avenic-catalog`
- 数据路径说明中 `.agent-skills.lock.json` → `.avenic.lock.json`；`.agent-skills.json` → `.avenic.json`；`~/.config/agent-skills/` → `~/.config/avenic/`
- **保留**：`.agents/`、`.claude/skills/` 等生态路径原样

`docs/development.md`：
- 第 40 行：`agentHome.packageSpec` 保持 `agenthome-cli@latest` → `avenic.packageSpec` 保持 `avenic@latest`
- 第 42 行：改写为"发布物是 `packages/cli`（包名 `avenic`）与 `packages/core`（包名 `@avenic/core`）"，删除"原拟 `@agenthome/core`…该 scope 已被其他 npm 账号占用"的历史注释
- "core 发布纪律"节内命令 `cd packages/core && npm publish` 保留；包名引用 `@agenthome-cli/core` → `@avenic/core`
- 仓库结构段 "packages/cli（agenthome-cli npm package）" 类表述 → `avenic`；可补一句"根 package.json 内部名 `avenic-repo`"
- 第 48-50 行 catalog 仓库段：当前只写"私有 catalog 仓库"（无品牌词）则不动；如出现 `agenthome-catalog` 一并替换
- 打包约束段（第 26-30 行）不改（pacote 约束与 brand 无关）

`docs/superpowers/specs/2026-09-06-vscode-extension-design.md`：
- `@agenthome/core` → `@avenic/core`；`agenthome.*` → `avenic.*`（命令/view ID）；`AgentHome` → `Avenic`
- 仓库引用 `Echo-Kang-hub/agenthome-cli（monorepo，…）` → `Echo-Kang-hub/avenic（单仓库多 package 结构，…）`

`docs/superpowers/plans/2026-09-06-vscode-extension.md`（仅品牌字符串）：
- import 样例 `"@agenthome/core"` → `"@avenic/core"`；`agenthome.agents.*` → `avenic.agents.*`；标题/约束中的 AgentHome → Avenic；`Echo-Kang-hub/agenthome-catalog` → `Echo-Kang-hub/avenic-catalog`
- 不改任务结构、不改非品牌内容

- [ ] **Step 2: CI 检查**

Run: `rg -n -i "agenthome|agent-skills" .github/ 2>/dev/null | head -5`
Expected: 无命中（ci.yml 无品牌字符串）。若有命中，同步替换后重跑。

- [ ] **Step 3: 残留验证**

Run: `rg -n -i "agenthome|agent-skills" README.md packages/cli/README.md docs/development.md docs/superpowers/specs/2026-09-06-vscode-extension-design.md docs/superpowers/plans/2026-09-06-vscode-extension.md | head -10`
Expected: 空（vscode plan 中如遇 `AGENTHOME_STATE_DIR` 测试样例一并改为 `AVENIC_STATE_DIR`）。

- [ ] **Step 4: Commit**

```bash
git add README.md packages/cli/README.md docs/development.md docs/superpowers/specs/2026-09-06-vscode-extension-design.md docs/superpowers/plans/2026-09-06-vscode-extension.md
git commit -m "docs: rebrand AgentHome to Avenic across README, docs, and VS Code spec"
```

---

### Task 11: M4 全量验证与品牌残留审计

**Files:**
- 无（验证任务；发现问题则修复对应文件）

**Interfaces:**
- Consumes: Task 1–10 全部产物
- Produces: 发布/rename 前的绿灯清单

- [ ] **Step 1: 全量测试**

```bash
npm test 2>&1 | tail -8
npm run test:install 2>&1 | tail -12
npm run pack:cli 2>&1 | tail -6
```

Expected: 三者全绿。任一失败 → 定位修复后重跑（不回滚已完成任务）。

- [ ] **Step 2: 品牌残留审计（允许清单模式）**

```bash
rg -n -i "agenthome|agent-skills" --glob '!node_modules/**' --glob '!docs/superpowers/plans/2026-09-06-split-cli-catalog.md' --glob '!docs/superpowers/specs/2026-09-06-split-cli-catalog-design.md' --glob '!docs/superpowers/specs/2026-09-07-avenic-rebrand-design.md' --glob '!docs/superpowers/plans/2026-09-07-avenic-rebrand.md' | head -40
```

**合法残留（允许清单，逐条核对，其余必须修复）**：
- `packages/core/src/skills/paths.mjs`：`AGENTHOME_STATE_DIR` 回退行、`.agent-skills-profile` 常量、`LEGACY_PROJECT_*` 常量
- `packages/core/src/skills/catalog.mjs`：`AGENTHOME_CATALOG_SPEC` 回退行
- `test/migration.test.mjs` 等测试：旧文件名 fixture、回退行为测试
- `packages/cli/vendor/core-src/`：与 core 一致的上述行（sync 后自动一致）
- M6 尚未执行的 deprecate 目标 `agenthome-cli`（npm 命令本身，不在仓库内）

- [ ] **Step 3: 修复审计发现并提交**

若 Step 2 发现允许清单外的残留：定位 → 修复 → 重跑 `npm test` → 

```bash
git add <修复文件>
git commit -m "fix: remove remaining AgentHome brand references"
```

- [ ] **Step 4: 推送**

```bash
git push origin main
```

Expected: 推送成功（remote 仍是旧名，GitHub rename 在 Task 13 执行后旧名 redirect 到新名）。

---

### Task 12: GitHub rename（主仓库 + catalog 仓库）

**Files:**
- 无仓库文件修改（remote 配置变更）

**Interfaces:**
- Consumes: Task 11 绿灯
- Produces: `Echo-Kang-hub/avenic`、`Echo-Kang-hub/avenic-catalog` 存在；旧 URL redirect 生效；本地 origin 指向新 URL。

- [ ] **Step 1: 检查 gh 权限**

Run: `gh auth status 2>&1 | head -5`
Expected: 已登录 `Echo-Kang-hub`。

- [ ] **Step 2: rename 主仓库**

```bash
gh api -X PATCH repos/Echo-Kang-hub/agenthome-cli -f name=avenic --jq '.full_name'
gh api -X PATCH repos/Echo-Kang-hub/agenthome-catalog -f name=avenic-catalog --jq '.full_name'
```

Expected: 输出 `Echo-Kang-hub/avenic`、`Echo-Kang-hub/avenic-catalog`。

**USER CHECKPOINT**（仅当 PATCH 返回 403/404 或 gh 缺 `repo` scope）：请用户在 GitHub 网页 Settings → Rename 手动把两个仓库分别改为 `avenic`、`avenic-catalog`，完成后告诉我继续；Agent 从 Step 3 接续。

- [ ] **Step 3: 更新本地 remote 并验证**

```bash
git remote set-url origin https://github.com/Echo-Kang-hub/avenic.git
git fetch origin && git status -sb | head -3
gh repo view Echo-Kang-hub/avenic --json nameWithOwner -q .nameWithOwner
```

Expected: fetch 成功，`Echo-Kang-hub/avenic` 可见。

- [ ] **Step 4: 验证旧 URL redirect**

```bash
git ls-remote https://github.com/Echo-Kang-hub/agenthome-cli.git HEAD | head -1
git ls-remote https://github.com/Echo-Kang-hub/agenthome-catalog.git HEAD | head -1
```

Expected: 两个旧 URL 均返回 HEAD（redirect 生效）。若失败，检查旧名下是否意外存在新仓库。

- [ ] **Step 5: 记录**

无代码提交；在最终报告中记录 rename 完成时间与验证结果。

---

### Task 13: npm 发布前复验 + 发布 @avenic/core

**Files:**
- 无（npm registry 操作）

**Interfaces:**
- Consumes: Task 2 的 core manifest
- Produces: registry 上 `@avenic/core@1.0.0`

- [ ] **Step 1: 发布前 gate 复验**

```bash
npm view avenic version 2>&1 | head -1; npm view @avenic/core version 2>&1 | head -1; npm org ls avenic 2>&1 | head -3
```

Expected: `avenic` 与 `@avenic/core` 均 E404；`npm org ls avenic` 无报错（echokang 可访问 org）。

- [ ] **Step 2: 发布 core**

```bash
cd packages/core && npm publish
```

Expected: `+ @avenic/core@1.0.0`。

**USER CHECKPOINT**（仅当出现 OTP/E401 浏览器 2FA 提示）：请在本会话输入 `! cd packages/core && npm publish` 完成认证；完成后告诉我继续，Agent 从 Step 3 接续。

- [ ] **Step 3: 发布后验证**

```bash
npm view @avenic/core version dist-tags --json 2>&1 | head -10
```

Expected: `version: 1.0.0`，`latest: 1.0.0`。

---

### Task 14: 发布 avenic + registry 模式验证

**Files:**
- 无（npm registry 操作）

**Interfaces:**
- Consumes: Task 3 的 CLI manifest、Task 13 的 core 发布
- Produces: registry 上 `avenic@1.0.0`

- [ ] **Step 1: 发布 CLI**

```bash
cd packages/cli && npm publish
```

Expected: `+ avenic@1.0.0`。2FA 处理同 Task 13（USER CHECKPOINT 同上）。

- [ ] **Step 2: registry 模式临时安装验证**

```bash
TMP=$(mktemp -d); npm install --global avenic --prefix "$TMP/prefix" 2>&1 | tail -3
AVENIC_STATE_DIR="$TMP/state" "$TMP/prefix/avenic.cmd" --help 2>&1 | head -8
AVENIC_STATE_DIR="$TMP/state" "$TMP/prefix/ave.cmd" --help 2>&1 | head -3
```

Expected: 安装成功；help 输出含 `Avenic` 与 `shorthand: ave`（POSIX 下路径为 `$TMP/prefix/bin/avenic`，按平台调整）。

- [ ] **Step 3: doctor / skills status 验证**

```bash
cd "$TMP" && AVENIC_STATE_DIR="$TMP/state" "$TMP/prefix/avenic.cmd" doctor 2>&1 | tail -6
cd "$TMP" && AVENIC_STATE_DIR="$TMP/state" "$TMP/prefix/avenic.cmd" skills status 2>&1 | tail -4
```

Expected: `doctor` 正常输出 Avenic Doctor；`skills status` 显示 "No managed ... skills installation found" 类信息（未安装状态），exit 0。

- [ ] **Step 4: 验证 --version**

Run: `"$TMP/prefix/avenic.cmd" --version 2>&1 | head -2`
Expected: 输出 `1.0.0`（若 CLI 无 --version 命令，跳过并在报告中注明，以 `npm view avenic version` 替代）。

---

### Task 15: GitHub 根安装模式验证 + deprecate 旧包

**Files:**
- 无（npm registry / 安装验证）

**Interfaces:**
- Consumes: Task 12 rename、Task 14 CLI 发布
- Produces: GitHub 根模式可用；`agenthome-cli` 已 deprecate

- [ ] **Step 1: GitHub 根安装模式验证**

```bash
TMP=$(mktemp -d); npm install --global Echo-Kang-hub/avenic --prefix "$TMP/prefix" 2>&1 | tail -3
AVENIC_STATE_DIR="$TMP/state" "$TMP/prefix/avenic.cmd" --help 2>&1 | head -5
```

Expected: 安装成功（根 manifest `avenic-repo` 提供 bin），help 输出 Avenic。

- [ ] **Step 2: deprecate 旧包**

```bash
npm deprecate agenthome-cli "Renamed to avenic: npm i -g avenic"
npm view agenthome-cli deprecated 2>&1 | head -1
```

Expected: 第二条输出 deprecate 文案。

**USER CHECKPOINT**：仅当 2FA 阻断 deprecate 命令时同 Task 13 处理。

- [ ] **Step 3: 终局验证清单**

```bash
npm view avenic version; npm view @avenic/core version; npm view agenthome-cli deprecated
```

Expected: `1.0.0` / `1.0.0` / deprecate 文案。全部就绪后向用户提交完整迁移报告（含 rename 时间、发布版本、验证结果、残留允许清单核对结果）。

---

## Self-Review 记录

1. **Spec coverage**：spec §5 A 类映射 → Task 1/2/3/4/5/6/9/10；§8 数据迁移 → Task 7/8（含失败降级）；§9 发布顺序 → Task 11–15（rename 先行、发布验证、deprecate）；§9.1 自动化原则 → 各 Task 的 USER CHECKPOINT 标注；C 类不动 → Global Constraints + Task 5 禁止清单；历史归档不改 → Task 10 明确排除；VS Code spec 更新 → Task 10。
2. **Placeholder scan**：无 TBD/TODO；每步含具体命令与断言内容。
3. **Type consistency**：`avenicPackageSpec`/`updateAvenic`（Task 5）与调用点（skills-cli/dispatcher）一致；`deprecatedEnvironmentValue(environment, primary, legacy)`（Task 4）在 Task 8 复用一致；`migrateLegacyProjectFiles(cwd)`（Task 7）在 install.mjs 调用一致；bin 名 `avenic`/`ave` 在 Task 1/3/6/14/15 一致。
