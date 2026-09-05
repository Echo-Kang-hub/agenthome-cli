# AgentHome 拆分实施计划（CLI + Catalog）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline, 用户已指定) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把单仓库 AgentHome 拆成 public `agenthome-cli`（monorepo：core+cli）与 private `agenthome-catalog`，CLI 经 git 全局缓存按锁定 commit 从私有 catalog 取 Skills，并新增直接公开源安装。

**Architecture:** core（纯逻辑、io 注入）与 cli（bin 六件套）同仓库，cli 通过 `imports` 别名 `#core` 引用提交进 git 的 `vendor/core-src` 同步副本；catalog 仓库纯数据 + CI；两种安装模式（GitHub 根安装 / registry tarball）共用同一相对路径解析。

**Tech Stack:** Node ≥18.17 纯 ESM（无构建、无第三方依赖）、npm workspaces、node:test、git、gh CLI（已装已登录 Echo-Kang-hub）。

**Spec:** `docs/superpowers/specs/2026-09-06-split-cli-catalog-design.md`

## Global Constraints

- Node >=18.17；纯 ESM；无第三方运行时依赖；无构建步骤（唯一同步脚本 `sync-core.mjs`）。
- 行为兼容：现有输出文案、退出码、数据文件格式逐字不变；18 项现有测试迁移后必须全绿。
- 双安装模式等价：GitHub 根安装（根 package.json 持 bin）与 registry tarball（packages/cli 持 bin）；`#core` 别名在两种模式下都指向 `vendor/core-src`。
- bin 六件套：`agent`、`agenthome`、`agent-skills`、`ac`、`ax`、`ao`。
- 认证完全委托 git/gh；CLI 不读不存 token；失败提示含 `gh auth login`。
- catalog 默认 spec：`Echo-Kang-hub/agenthome-catalog#main`；项目锁固定 commit 可复现。
- 不执行：npm publish、删除会话/认证/用户文件、改 NVM/PATH、force push、删除远程仓库。
- 远程操作已授权：gh rename 当前仓库为 `agenthome-catalog`、创建 public `agenthome-cli`、push。
- Windows（本机）与 Linux（CI）双平台；测试离线（本地 git fixture，零网络）。

## 文件结构（新仓库 D:\FileDownload\Projects\agenthome-cli）

```
agenthome-cli/
├─ package.json                     # agenthome-cli-monorepo, private, workspaces, bin 六件套→packages/cli
├─ .gitignore  .gitattributes  README.md
├─ scripts/sync-core.mjs            # 拷贝 packages/core/src → packages/cli/vendor/core-src
├─ .github/workflows/ci.yml
├─ docs/superpowers/specs|plans/    # 从当前仓库复制
├─ packages/
│  ├─ core/package.json             # @agenthome/core, private
│  └─ core/src/
│     ├─ index.mjs                  # 公共 API 汇总导出
│     ├─ runtime/                   # 从 src/runtime/ 原样迁移（零改动）
│     │  ├─ agents.mjs config.mjs gitignore.mjs project-root.mjs process.mjs sessions.mjs
│     │  └─ adapters/{index,claude,codex,opencode}.mjs
│     ├─ skills/                    # 从 scripts/skills.mjs 拆分
│     │  ├─ paths.mjs ids.mjs git.mjs ui.mjs
│     │  ├─ sources.mjs packs.mjs install.mjs vendor.mjs
│     │  ├─ catalog.mjs             # 新：缓存/默认 spec/锁
│     │  └─ direct.mjs              # 新：直接公开源
│     └─ util/{json.mjs,fs.mjs}
│  └─ cli/
│     ├─ package.json               # agenthome-cli, private, imports #core, agentHome.packageSpec
│     ├─ vendor/core-src/           # 提交进 git 的同步副本（git 维护）
│     ├─ bin/{agent,ac,ax,ao}.mjs
│     ├─ scripts/skills.mjs         # agenthome/agent-skills bin 入口
│     └─ src/{dispatcher.mjs,run.mjs,skills-cli.mjs,self-update.mjs}
├─ test/
│  ├─ runtime.test.mjs              # 迁移（改 import/bin 路径 + self-update 断言）
│  ├─ skills.test.mjs               # 迁移（fixture catalog、bin 调用）
│  ├─ catalog-cache.test.mjs        # 新（TDD）
│  ├─ skills-direct-add.test.mjs    # 新（TDD）
│  └─ sync.test.mjs                 # 新：vendor 与 core 同步守护
└─ integration/global-install.mjs   # 迁移（根包 + cli 包双模式 + fixture 安装）
```

## Phase A：文档落盘（当前仓库）

### Task A1: 提交 spec 与 plan

- [x] 已提交 spec（commit 6ff7af2）；本文件写完后提交。

```bash
cd "D:\FileDownload\Projects\agent-skills" && git add docs/ && git commit -m "docs: add split implementation plan"
```

## Phase B：新仓库 D:\FileDownload\Projects\agenthome-cli

### Task B1: 脚手架与 sync-core

**Files:** Create: `package.json`、`.gitignore`、`.gitattributes`、`scripts/sync-core.mjs`、`packages/core/package.json`、`packages/core/src/index.mjs`（占位）、`packages/cli/package.json`、`packages/cli/vendor/core-src/`（空待同步）、`.github/workflows/ci.yml`

**Interfaces:**
- Produces: `npm run sync-core`（复制 core→vendor）；根与 cli 的 package.json（bin/imports 供后续任务）；`AGENTHOME_*` 无（此任务无代码逻辑）。

- [ ] **Step 1: git init 并创建根 package.json**

```bash
mkdir -p /d/FileDownload/Projects/agenthome-cli && cd /d/FileDownload/Projects/agenthome-cli && git init -b main && git config user.name "Echo-Kang-hub" && git config user.email "3262955816@qq.com"
```

根 `package.json`：

```json
{
  "name": "agenthome-cli-monorepo",
  "version": "5.5.0",
  "private": true,
  "type": "module",
  "workspaces": ["packages/core", "packages/cli"],
  "bin": {
    "agenthome": "packages/cli/scripts/skills.mjs",
    "agent-skills": "packages/cli/scripts/skills.mjs",
    "agent": "packages/cli/bin/agent.mjs",
    "ac": "packages/cli/bin/ac.mjs",
    "ax": "packages/cli/bin/ax.mjs",
    "ao": "packages/cli/bin/ao.mjs"
  },
  "scripts": {
    "sync-core": "node scripts/sync-core.mjs",
    "pretest": "npm run sync-core",
    "test": "node --test test/",
    "test:install": "npm run sync-core && node integration/global-install.mjs",
    "pack:cli": "cd packages/cli && npm pack --dry-run --json"
  },
  "files": ["packages/", "README.md"],
  "engines": { "node": ">=18.17" },
  "repository": { "type": "git", "url": "git+https://github.com/Echo-Kang-hub/agenthome-cli.git" }
}
```

`.gitignore`：`node_modules/`、`*.tgz`、`.tmp/`。

`.gitattributes`：`* text=auto eol=lf`（保持与现有仓库一致：`* text=auto`）。

- [ ] **Step 2: 写 scripts/sync-core.mjs（含测试断言用的 exit 语义）**

```js
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "packages", "core", "src");
const target = path.join(root, "packages", "cli", "vendor", "core-src");

await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
console.log(`core synced -> ${target}`);
```

- [ ] **Step 3: packages/core/package.json**

```json
{
  "name": "@agenthome/core",
  "version": "5.5.0",
  "private": true,
  "type": "module",
  "main": "src/index.mjs",
  "exports": { ".": "./src/index.mjs" }
}
```

- [ ] **Step 4: packages/cli/package.json**

```json
{
  "name": "agenthome-cli",
  "version": "5.5.0",
  "private": true,
  "description": "Portable Skills, runtime configuration, and sessions for coding agents",
  "type": "module",
  "imports": {
    "#core": "./vendor/core-src/index.mjs",
    "#core/*": "./vendor/core-src/*"
  },
  "bin": {
    "agenthome": "scripts/skills.mjs",
    "agent-skills": "scripts/skills.mjs",
    "agent": "bin/agent.mjs",
    "ac": "bin/ac.mjs",
    "ax": "bin/ax.mjs",
    "ao": "bin/ao.mjs"
  },
  "scripts": { "prepack": "node ../../scripts/sync-core.mjs" },
  "files": ["bin/", "scripts/", "src/", "vendor/core-src/"],
  "engines": { "node": ">=18.17" },
  "agentHome": { "packageSpec": "Echo-Kang-hub/agenthome-cli#main" }
}
```

- [ ] **Step 5: 验证 sync-core 可运行**

Run: `npm run sync-core`（core 尚空 → vendor/core-src 空目录生成）

- [ ] **Step 6: .github/workflows/ci.yml**

```yaml
name: CI

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  test:
    name: Test and package check
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Sync core
        run: npm run sync-core
      - name: Unit tests
        run: npm test
      - name: Global install integration
        run: npm run test:install
      - name: Registry tarball dry run
        run: npm run pack:cli
      - name: GitHub root package dry run
        run: npm pack --dry-run --json
```

- [ ] **Step 7: 提交**

```bash
git add -A && git commit -m "chore: scaffold monorepo workspace"
```

### Task B2: 迁移 runtime 测试与 core 模块（TDD）

**Files:**
- Create: `packages/core/src/runtime/*`（从当前仓库 `src/runtime/` 复制）、`test/runtime.test.mjs`（改写）
- Modify: `packages/core/src/index.mjs`（导出 runtime 公共 API）

**Interfaces:**
- Produces（core 导出名，与现有一致）: `AGENTS, getAgent, validateAuthMode, runtimePaths, loadRuntime, initializeAgent, deinitializeAgent, setLocalAuth, clearLocalAuth, effectiveAgentConfig, REQUIRED_RULES, SESSIONS_RULE, ensureRuntimeGitignore, sessionsGitIgnored, setSessionsGitIgnored, removeRuntimeGitignore, locateProjectRoot, PROJECT_ROOT_TOKEN, samePath, transformJsonLines, listFiles, replaceDirectory, snapshotFiles, mergeFiles, readFirstJsonLine, hashContent, spawnExecutableSync, getSessionAdapter`

- [ ] **Step 1: 复制 runtime 模块（原样，零改动）**

```bash
mkdir -p packages/core/src/runtime/adapters
cp -r /d/FileDownload/Projects/agent-skills/src/runtime/. packages/core/src/runtime/
```

- [ ] **Step 2: 写 packages/core/src/index.mjs（runtime 部分先导出，skills 部分后续任务追加）**

```js
export {
  AGENTS,
  getAgent,
} from "./runtime/agents.mjs";
export {
  clearLocalAuth,
  deinitializeAgent,
  effectiveAgentConfig,
  initializeAgent,
  loadRuntime,
  runtimePaths,
  setLocalAuth,
  validateAuthMode,
} from "./runtime/config.mjs";
export {
  REQUIRED_RULES,
  SESSIONS_RULE,
  ensureRuntimeGitignore,
  removeRuntimeGitignore,
  sessionsGitIgnored,
  setSessionsGitIgnored,
} from "./runtime/gitignore.mjs";
export { locateProjectRoot } from "./runtime/project-root.mjs";
export { spawnExecutableSync } from "./runtime/process.mjs";
export {
  PROJECT_ROOT_TOKEN,
  hashContent,
  listFiles,
  mergeFiles,
  readFirstJsonLine,
  replaceDirectory,
  samePath,
  snapshotFiles,
  transformJsonLines,
} from "./runtime/sessions.mjs";
export { getSessionAdapter } from "./runtime/adapters/index.mjs";
```

- [ ] **Step 3: 迁移 test/runtime.test.mjs（改写 import 与 bin 路径，断言不变）**

从当前仓库 `test/runtime.test.mjs` 复制，然后做三处机械替换：
1. `"../src/runtime/config.mjs"` → `"../packages/core/src/runtime/config.mjs"`（gitignore/project-root/adapters/sessions 同理，`../src/cli/self-update.mjs` → `../packages/cli/src/self-update.mjs` 暂缺——本测试里 self-update 用例见 Step 5 说明，先注释该 import 与用例占位）。
2. `runCli` 的 entry 路径：`path.join(packageRoot, "bin", entry)` → `path.join(packageRoot, "packages", "cli", "bin", entry)`。
3. self-update 用例整体移到 Task B7（彼时 self-update.mjs 已迁移），本任务内先用最小桩文件 `packages/cli/src/self-update.mjs`：

```js
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function agentHomePackageSpec(packageRoot) {
  const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  return metadata.agentHome?.packageSpec ?? "agenthome-cli";
}
```

（`updateAgentHome` 函数在 Task B7 迁移。）

- [ ] **Step 4: 先跑测试确认失败**

Run: `node --test test/runtime.test.mjs`
Expected: FAIL——bin 缺失（`packages/cli/bin/agent.mjs` 不存在）。

- [ ] **Step 5: 复制 bin 四件套与 run.mjs**

```bash
mkdir -p packages/cli/bin packages/cli/src
cp /d/FileDownload/Projects/agent-skills/bin/{agent,ac,ax,ao}.mjs packages/cli/bin/
cp /d/FileDownload/Projects/agent-skills/src/cli/run.mjs packages/cli/src/
```

run.mjs 的 import `./dispatcher.mjs` 保持相对路径（同目录），dispatcher 在 Task B7 迁移；本任务先创建最小 dispatcher 桩（仅让 `agent.mjs` 可执行、帮助文本正确），在 Task B7 前 runtime 测试中用到 `agent.mjs` 的用例（sessions git、full/short commands）会依赖它——因此本任务内必须先迁移 dispatcher 的 runtime 部分（见 Step 6）。

- [ ] **Step 6: 迁移 dispatcher（runtime 部分）**

从当前仓库 `src/cli/dispatcher.mjs` 复制到 `packages/cli/src/dispatcher.mjs`，机械替换：
1. `../runtime/agents.mjs` → `#core`（用 `import { AGENTS, getAgent } from "#core"` 等，逐个函数改从 `#core` 导入）。
2. `./self-update.mjs` 保持（Task B7 迁移 updateAgentHome）。
3. `dispatchSkills` 暂时保留子进程方案（Task B8 改为同进程）。
4. `packageRoot`：`path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")` → 指向 `packages/cli`（bin 在 packages/cli/bin 下，上溯两级即 packages/cli）。
5. 其余（init/deinit/auth/status/sessions/dispatchStatus/dispatchDoctor）逐字保留。

- [ ] **Step 7: 跑测试到绿**

Run: `node --test test/runtime.test.mjs`；若失败按输出修复（预期问题：bin 里 `import { start } from "../src/run.mjs"` 相对路径 OK；`#core` 别名要求 node ≥18.17 的 imports 解析——本机 node 版本满足）。

- [ ] **Step 8: 全量回归 + 提交**

Run: `npm test`（skills 测试尚未迁移，仅 runtime 通过即可）
```bash
git add -A && git commit -m "test: migrate runtime tests and core modules"
```

### Task B3: 拆分 skills.mjs → core/skills 模块（TDD）

**Files:**
- Create: `packages/core/src/util/json.mjs`、`util/fs.mjs`、`skills/ids.mjs`、`skills/paths.mjs`、`skills/git.mjs`、`skills/ui.mjs`、`skills/sources.mjs`、`skills/packs.mjs`、`skills/vendor.mjs`、`skills/install.mjs`、`packages/cli/src/skills-cli.mjs`、`packages/cli/scripts/skills.mjs`
- Modify: `test/skills.test.mjs`（fixture 化）、`packages/core/src/index.mjs`（追加 skills 导出）

**Interfaces（拆分后的函数名与签名，行为与现状逐字一致）:**
- `util/json.mjs`: `readJson(file)`, `writeJson(file, value)`（skills 版，含 fail 信息）
- `util/fs.mjs`: `removeEmptyDirectory(dir)`, `isInside(parent, target)`
- `skills/ids.mjs`: `assertSafeId(value,label)`, `assertSafeSkillName(value)`, `assertSafeRelativePath(value,label)`, `assertSafeSkillRoot(value)`, `assertSafeSkillPath(value,label)`
- `skills/paths.mjs`: 常量 `PROJECT_CONFIG_FILE, PROJECT_LOCK_FILE, LEGACY_PROFILE_FILE, PROJECT_TARGETS, GLOBAL_TARGETS`；函数 `stateRoot(environment)`（`AGENTHOME_STATE_DIR` 覆盖 > `XDG_CONFIG_HOME/agent-skills` > `~/.config/agent-skills`）、`globalConfigFile(environment)`, `globalLockFile(environment)`, `catalogCacheRoot(environment)`, `defaultCatalogFile(environment)`
- `skills/git.mjs`: `fail(message)`, `run(command,args,options)`, `git(args,options)`, `normalizeRepositoryInput(repo)`, `repositoryIdentity(repo)`, `deriveSourceId(repo)`, `cloneHead(source,dest)`, `cloneRevision(source,dest)`, `remoteHead(source)`, `currentRepositoryState(catalogRoot)`
- `skills/ui.mjs`: `printTree(io, groups, title, details=[])`
- `skills/sources.mjs`: `readSkill(dir,requireMatchingFolder=true)`, `parseFrontmatterName(content,file)`, `buildCatalog(config, skillsRoot)`, `loadSources(catalogRoot)`, `saveSources(catalogRoot, data)`, `findSource(config, ref)`, `registerSource(catalogRoot, config, options)`, `stageSource(source, cloneDir, stageDir, skillNames)`, `discoverSourceSkills(source, cloneDir, options)`, `detectSkillRoot(cloneDir)`
- `skills/packs.mjs`: `loadPacks(catalogRoot)`, `resolvePack(catalog, config, pack)`, `parsePackArguments(args)`, `normalizePackIds(ids)`, `resolvePacks(catalog, config, packs, ids)`, `addSkillsToPacks(catalogRoot, packIds, sourceId, skillNames)`, `packContainsSkill(...)`, `skillCoveredByPacks(...)`, `catalogReferences(packs)`, `pruneCatalogSkills(catalogRoot, config, packs, candidates)`
- `skills/vendor.mjs`: `createTempDirectory(catalogRoot)`, `removeTempDirectory(dir)`, `replaceStagedFiles(replacements, tempDir)`
- `skills/install.mjs`: `createInstallContext(global, environment)`、`resolveInstallPacks(context, explicitPacks)`、`previousManagedState(context)`、`installedPackIds(context)`、`installCopies(context, resolvedPacks, io)`、`writeInstallMetadata(context, resolvedPacks, catalogInfo)`、`isCatalogDirectory(dir)`
- `packages/cli/src/skills-cli.mjs`: `dispatchSkills(argumentsList, { io, cwd, environment })` 返回 exit code；命令命令函数（commandInstall/commandUninstall/commandUninstallSkill/commandTree/commandPacks/commandStatus/commandDoctor）内部从 core 组合。

**拆分规则（机械、行为不变）:**
- `catalogRoot` 全局状态删除：所有读 skills/packs/sources 的函数加显式参数（见上）；`main()` 里维护模式用 `setCatalogRoot(cwd)` 改为「校验 `isCatalogDirectory(cwd)` 后把 cwd 作为 catalogRoot 传入」。
- 所有 `console.log` 改 `io.log`（`io` 默认 `console`）；`printTree(io, ...)`。
- `takeOption` 移到 skills-cli（CLI 层），core 不再有。
- 冲突消息、帮助文本、树输出格式逐字保留。

- [ ] **Step 1: 写 fixture 化的 test/skills.test.mjs（先测试后实现——此文件立即失败）**

从当前 `test/skills.test.mjs` 复制并改写：

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentBin = path.join(packageRoot, "packages", "cli", "bin", "agent.mjs");

function runAgent(cwd, argumentsList, environment = {}) {
  return spawnSync(process.execPath, [agentBin, ...argumentsList], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...environment },
  });
}

async function withTempDirectory(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function gitQuiet(cwd, argumentsList) {
  const result = spawnSync("git", ["-C", cwd, ...argumentsList], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function commitAll(root, message) {
  await gitQuiet(root, ["init", "--quiet", "-b", "main"]);
  await gitQuiet(root, ["add", "-A"]);
  await gitQuiet(root, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", message]);
  return gitQuiet(root, ["rev-parse", "HEAD"]);
}

async function createCatalogFixture(root) {
  await mkdir(path.join(root, "packs"), { recursive: true });
  await mkdir(path.join(root, "licenses"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "fixture-catalog", version: "1.0.0", private: true }, null, 2)}\n`,
  );
  await writeFile(
    path.join(root, "sources.lock.json"),
    `${JSON.stringify({ schemaVersion: 1, sources: [{ id: "test-source", name: "Test Source", repository: "https://github.com/example/test.git", skillRoot: "skills", revision: "a".repeat(40), skillPaths: { beta: "nested/beta" }, licenseFile: "licenses/test-source-LICENSE" }] }, null, 2)}\n`,
  );
  await writeFile(path.join(root, "licenses", "test-source-LICENSE"), "license\n");
  for (const skillName of ["alpha", "gamma"]) {
    const directory = path.join(root, "skills", "test-source", skillName);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${skillName}\n---\n`);
  }
  const beta = path.join(root, "skills", "test-source", "nested", "beta");
  await mkdir(beta, { recursive: true });
  await writeFile(path.join(beta, "SKILL.md"), `---\nname: beta\n---\n`);
  const common = { schemaVersion: 1, id: "common", name: "Common", sources: [{ source: "test-source", skills: ["alpha"] }] };
  const development = { schemaVersion: 1, id: "development", name: "Development", sources: [{ source: "test-source", skills: ["beta", "gamma"] }] };
  await writeFile(path.join(root, "packs", "common.json"), `${JSON.stringify(common, null, 2)}\n`);
  await writeFile(path.join(root, "packs", "development.json"), `${JSON.stringify(development, null, 2)}\n`);
  await commitAll(root, "fixture catalog");
}

function catalogEnvironment(catalogRoot, stateRoot) {
  return { AGENTHOME_CATALOG_SPEC: catalogRoot, AGENTHOME_STATE_DIR: stateRoot };
}
```

四个用例改写为 fixture 版（行为断言与原版一一对应）：
1. `Pack uninstall prunes only Skills no longer selected`：install `["development"]`（env=catalogEnvironment）→ `.agents/skills/` 有 alpha/beta/gamma；`uninstall-skill beta` 拒绝 `/Managed by configured Packs/`；`uninstall development` 后 beta/gamma 消失、alpha（common）保留；config.packs == `["common"]`；重复 uninstall → `/Already absent: development/`。
2. `External Skill uninstall is multi-value and idempotent`：原样保留（不依赖 catalog）。
3. `Skills uninstall without Packs removes all managed state`：env=catalogEnvironment；断言改为 alpha 消失、external 保留、config/lock 删除、重复 → `/No managed project Skills installation found/`。
4. `Catalog removes multiple Skills and Packs without orphan files`：改为「对 fixture 的 git clone 副本执行维护命令」：

```js
const cloneRoot = path.join(path.dirname(catalogRoot), "catalog-work");
await gitQuiet(catalogRoot, ["clone", "--quiet", catalogRoot, cloneRoot]);
const before = await readFile(path.join(cloneRoot, "packs", "development.json"), "utf8");
const invalid = runAgent(cloneRoot, ["catalog", "remove", "test-source", "beta", "--park", "development"]);
assert.equal(invalid.status, 1);
assert.equal(await readFile(path.join(cloneRoot, "packs", "development.json"), "utf8"), before);
assert.equal(existsSync(path.join(cloneRoot, "skills", "test-source", "beta")), true);
const removed = runAgent(cloneRoot, ["catalog", "remove", "test-source", "beta", "gamma", "--pack", "development"]);
assert.equal(removed.status, 0, removed.stderr);
assert.equal(existsSync(path.join(cloneRoot, "skills", "test-source", "beta")), false);
assert.equal(existsSync(path.join(cloneRoot, "skills", "test-source", "gamma")), false);
assert.equal(existsSync(path.join(cloneRoot, "skills", "test-source", "alpha")), true);
const sourceConfig = JSON.parse(await readFile(path.join(cloneRoot, "sources.lock.json"), "utf8"));
assert.equal(sourceConfig.sources[0].skillPaths, undefined);
const repeated = runAgent(cloneRoot, ["catalog", "remove", "test-source", "beta", "gamma", "--pack", "development"]);
assert.equal(repeated.status, 0, repeated.stderr);
assert.match(repeated.stdout, /Already absent/);
const protectedPack = runAgent(cloneRoot, ["catalog", "pack-remove", "common", "development"]);
assert.equal(protectedPack.status, 1);
assert.equal(existsSync(path.join(cloneRoot, "packs", "development.json")), true);
const packRemoved = runAgent(cloneRoot, ["catalog", "pack-remove", "development"]);
assert.equal(packRemoved.status, 0, packRemoved.stderr);
assert.equal(existsSync(path.join(cloneRoot, "packs", "development.json")), false);
const packRepeated = runAgent(cloneRoot, ["catalog", "pack-remove", "development"]);
assert.equal(packRepeated.status, 0, packRepeated.stderr);
assert.match(packRepeated.stdout, /Already absent/);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/skills.test.mjs`
Expected: FAIL——`packages/cli/bin/agent.mjs` 的 dispatcher 抛 "Unknown command: skills"（或 skills-cli 缺失）。

- [ ] **Step 3: 实现 core/skills 各模块（按 Interfaces 拆分，函数体从 scripts/skills.mjs 逐字搬移 + 规则内替换）**

依次创建：`util/json.mjs`、`util/fs.mjs`、`skills/ids.mjs`、`skills/paths.mjs`、`skills/git.mjs`、`skills/ui.mjs`、`skills/sources.mjs`、`skills/packs.mjs`、`skills/vendor.mjs`、`skills/install.mjs`。搬移对照（行号指当前 `scripts/skills.mjs`）：

| 新模块 | 来源函数（当前行号区间） |
|---|---|
| util/json.mjs | readJson(166-172), writeJson(174-176) |
| util/fs.mjs | isInside(69-72), removeEmptyDirectory(519-523) |
| skills/ids.mjs | assertSafeId(82-86), assertSafeSkillName(88-92), assertSafeRelativePath(94-104), assertSafeSkillRoot(106-111), assertSafeSkillPath(113-118) |
| skills/paths.mjs | GLOBAL_* / PROJECT_* 常量(23-51) + 新 stateRoot/catalogCacheRoot/defaultCatalogFile |
| skills/git.mjs | fail(65-67), run(120-135), git(137-139), normalizeRepositoryInput(141-146), repositoryIdentity(148-155), deriveSourceId(157-164), cloneHead(808-811), cloneRevision(813-819), remoteHead(879-886), currentRepositoryState(434-451) |
| skills/ui.mjs | printTree(370-392)（io 注入） |
| skills/sources.mjs | parseFrontmatterName(212-219), readSkill(221-232), buildCatalog(234-257), loadSources(178-206), saveSources(208-210), findSource(1121-1127), registerSource(1190-1241), stageSource(821-844), discoverSourceSkills(979-1024), detectSkillRoot(1026-1046) |
| skills/packs.mjs | loadPacks(259-277), resolvePack(279-310), parsePackArguments(312-317), normalizePackIds(319-325), resolvePacks(327-368), addSkillsToPacks(1048-1105), packContainsSkill(1107-1111), skillCoveredByPacks(1113-1119), catalogReferences(1129-1139), pruneCatalogSkills(1141-1188) |
| skills/vendor.mjs | createTempDirectory(787-791), removeTempDirectory(793-806), replaceStagedFiles(846-877) |
| skills/install.mjs | createInstallContext(394-415), resolveInstallPacks(417-432), previousManagedState(491-503), installedPackIds(505-517), installCopies(525-568), writeInstallMetadata(453-489), isCatalogDirectory(74-80) |

路径/签名改动：`loadSources()` → `loadSources(catalogRoot)`；`saveSources(data)` → `saveSources(catalogRoot, data)`；`buildCatalog(config)` → `buildCatalog(config, skillsRoot)`；`loadPacks()` → `loadPacks(catalogRoot)`；`registerSource(sourceConfig, options)` → `registerSource(catalogRoot, sourceConfig, options)`；`addSkillsToPacks(packIds, ...)` → `addSkillsToPacks(catalogRoot, packIds, ...)`；`pruneCatalogSkills(sourceConfig, packs, candidates)` → `pruneCatalogSkills(catalogRoot, sourceConfig, packs, candidates)`；`writeInstallMetadata(context, resolvedPacks)` → 加第三参 `catalogInfo = { spec, repository, revision }`（本任务先用 `{ spec: null }` 兼容旧输出，Task B4 接真值）；`installCopies`/`command*` 加 `io` 注入；`createInstallContext(global, environment)` 用 `stateRoot(environment)` 派生全局文件路径。
`install.mjs` 里 `currentRepositoryState()` 改从 `git.mjs` 导入并传 catalogRoot；`loadPackageMetadata` 改为 `readJson(path.join(catalogRoot, "package.json"))`。

- [ ] **Step 4: 实现 packages/cli/src/skills-cli.mjs（组合层）**

```js
import * as install from "#core/skills/install.mjs";
import * as packs from "#core/skills/packs.mjs";
import * as sources from "#core/skills/sources.mjs";
import { fail } from "#core/skills/git.mjs";
import { printTree } from "#core/skills/ui.mjs";

function takeOption(argumentsList, option) {
  const index = argumentsList.indexOf(option);
  if (index === -1) return null;
  const value = argumentsList[index + 1];
  if (!value || value.startsWith("--")) fail(`${option} requires a value`);
  argumentsList.splice(index, 2);
  return value;
}

function parseScopeArguments(argumentsList) {
  const globalFlags = new Set(["-g", "--global"]);
  const global = argumentsList.some((argument) => globalFlags.has(argument));
  return {
    argumentsList: argumentsList.filter((argument) => !globalFlags.has(argument)),
    global,
  };
}

// commandInstall/commandUninstall/commandUninstallSkill/commandTree/commandPacks/
// commandStatus/commandDoctor：函数体从当前 scripts/skills.mjs 同名函数搬移，
// console → io.log；catalogRoot 参数化；本任务 catalog 来源先用
// AGENTHOME_CATALOG_SPEC 环境变量 + 空目录直读（Task B4 换成 ensureCatalog 缓存）。

export async function dispatchSkills(argumentsList, options = {}) { ... }
```

help 文本与 `main()` 路由逻辑照搬（维护命令组改为 `["doctor","update","add","remove","pack-add","pack-remove","source-add"]` 需先经 `install.isCatalogDirectory(cwd)` 校验）。同时导出 `dispatchCatalog`（与 `dispatchSkills` 共用同一命令表，但入口限定维护命令组），并扩展 dispatcher：新增 `catalog` 分支调用 `dispatchCatalog(remainingArguments, { io, cwd, environment })`。

- [ ] **Step 5: packages/cli/scripts/skills.mjs（agenthome bin 入口）**

```js
#!/usr/bin/env node

import process from "node:process";
import { dispatchSkills } from "../src/skills-cli.mjs";

dispatchSkills(process.argv.slice(2), { io: console, cwd: process.cwd(), environment: process.env })
  .then((status) => { process.exitCode = status; })
  .catch((error) => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
```

- [ ] **Step 6: 更新 packages/core/src/index.mjs 追加 skills 导出（`export * from "./skills/...";` 各模块）**

- [ ] **Step 7: 跑测试到绿 + 回归 + 提交**

Run: `node --test test/skills.test.mjs && npm test`
```bash
git add -A && git commit -m "refactor: split skills.mjs into core modules with fixture tests"
```

### Task B4: catalog 缓存与锁（TDD）

**Files:**
- Create: `packages/core/src/skills/catalog.mjs`、`test/catalog-cache.test.mjs`
- Modify: `packages/core/src/skills/install.mjs`（commandInstall 走 ensureCatalog + 锁写 catalogInfo）、`packages/cli/src/skills-cli.mjs`（`catalog use/sync/default` 命令）

**Interfaces:**
- `parseCatalogSpec(spec)` → `{ repository, ref }`（`owner/repo` → `https://github.com/owner/repo.git` + `ref: "main"`；`owner/repo#sha` → ref=sha；其余按 git URL 直传，ref 默认 `"main"`）
- `defaultCatalogFile(environment)` → 路径
- `loadDefaultCatalogSpec(environment)` → env `AGENTHOME_CATALOG_SPEC` > `catalog.json` 的 `spec` > `"Echo-Kang-hub/agenthome-catalog#main"`
- `setDefaultCatalogSpec(environment, spec)` → 写 catalog.json
- `ensureCatalog(spec, { environment, cwd, io })` → `{ catalogRoot, repository, revision, spec }`（clone 或 fetch ref + detach checkout）
- `catalogCacheRoot(environment)` → `<stateRoot>/catalog`；缓存目录名 `<owner>-<repo>`（deriveSourceId 风格）

- [ ] **Step 1: 写失败测试 test/catalog-cache.test.mjs**

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureCatalog,
  loadDefaultCatalogSpec,
  parseCatalogSpec,
  setDefaultCatalogSpec,
} from "../packages/core/src/skills/catalog.mjs";

function git(cwd, argumentsList) {
  const result = spawnSync("git", ["-C", cwd, ...argumentsList], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixtureCatalog(root) {
  await mkdir(path.join(root, "skills", "s"), { recursive: true });
  await mkdir(path.join(root, "packs"), { recursive: true });
  await writeFile(path.join(root, "skills", "s", "SKILL.md"), "---\nname: s\n---\nv1\n");
  await writeFile(path.join(root, "packs", "common.json"), `${JSON.stringify({ schemaVersion: 1, id: "common", name: "Common", sources: [{ source: "s-source", skills: ["s"] }] })}\n`);
  await writeFile(path.join(root, "sources.lock.json"), `${JSON.stringify({ schemaVersion: 1, sources: [{ id: "s-source", name: "S", repository: "https://github.com/example/s.git", skillRoot: "skills", revision: "a".repeat(40) }] })}\n`);
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: "fixture-catalog", version: "1.0.0" })}\n`);
  git(root, ["init", "--quiet", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "--quiet", "-m", "one"]);
}

async function withTemp(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("parseCatalogSpec handles owner/repo and pinned refs", () => {
  assert.deepEqual(parseCatalogSpec("Echo-Kang-hub/agenthome-catalog"), {
    repository: "https://github.com/Echo-Kang-hub/agenthome-catalog.git",
    ref: "main",
  });
  const pinned = parseCatalogSpec("owner/repo#abc123");
  assert.equal(pinned.repository, "https://github.com/owner/repo.git");
  assert.equal(pinned.ref, "abc123");
  const url = parseCatalogSpec("git@github.com:o/r.git#v1");
  assert.equal(url.repository, "git@github.com:o/r.git");
  assert.equal(url.ref, "v1");
});

test("ensureCatalog clones once, reuses, and pins revisions", async () => {
  await withTemp("catalog-cache-", async (root) => {
    const catalog = path.join(root, "catalog");
    const state = path.join(root, "state");
    await fixtureCatalog(catalog);
    const first = await ensureCatalog(catalog, { environment: { AGENTHOME_STATE_DIR: state } });
    assert.equal(path.basename(first.repository).replace(".git", ""), "catalog");
    // 缓存目录存在且可读
    const cached = path.join(state, "catalog", path.basename(catalog));
    assert.equal(first.catalogRoot, cached);
    // 第二次：新增远端 commit，固定旧 revision 仍取旧内容
    await writeFile(path.join(catalog, "skills", "s", "SKILL.md"), "---\nname: s\n---\nv2\n");
    git(catalog, ["add", "-A"]);
    git(catalog, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "--quiet", "-m", "two"]);
    const pinned = await ensureCatalog(`${catalog}#${first.revision}`, { environment: { AGENTHOME_STATE_DIR: state } });
    assert.equal(pinned.revision, first.revision);
    const { readFile } = await import("node:fs/promises");
    assert.match(await readFile(path.join(pinned.catalogRoot, "skills", "s", "SKILL.md"), "utf8"), /v1/);
    const latest = await ensureCatalog(catalog, { environment: { AGENTHOME_STATE_DIR: state } });
    assert.notEqual(latest.revision, first.revision);
    assert.match(await readFile(path.join(latest.catalogRoot, "skills", "s", "SKILL.md"), "utf8"), /v2/);
  });
});

test("ensureCatalog failure message mentions gh auth login", async () => {
  await withTemp("catalog-fail-", async (root) => {
    const state = path.join(root, "state");
    await assert.rejects(
      () => ensureCatalog(path.join(root, "missing-repo"), { environment: { AGENTHOME_STATE_DIR: state } }),
      /gh auth login/,
    );
  });
});

test("catalog use and sync manage the default spec", async () => {
  await withTemp("catalog-default-", async (root) => {
    const environment = { AGENTHOME_STATE_DIR: root };
    assert.equal(loadDefaultCatalogSpec(environment), "Echo-Kang-hub/agenthome-catalog#main");
    await setDefaultCatalogSpec(environment, "my/private#abc123");
    assert.equal(loadDefaultCatalogSpec(environment), "my/private#abc123");
    const overridden = { AGENTHOME_STATE_DIR: root, AGENTHOME_CATALOG_SPEC: "env/repo" };
    assert.equal(loadDefaultCatalogSpec(overridden), "env/repo");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/catalog-cache.test.mjs`
Expected: FAIL——`catalog.mjs` 不存在。

- [ ] **Step 3: 实现 catalog.mjs**

```js
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fail, git, normalizeRepositoryInput, repositoryIdentity } from "./git.mjs";
import { catalogCacheRoot, defaultCatalogFile } from "./paths.mjs";
import { readJson } from "../util/json.mjs";

const DEFAULT_CATALOG_SPEC = "Echo-Kang-hub/agenthome-catalog#main";

export function parseCatalogSpec(spec) {
  if (typeof spec !== "string" || spec.length === 0) fail(`Invalid catalog spec: ${spec}`);
  const hashIndex = spec.lastIndexOf("#");
  const repository = hashIndex === -1 ? spec : spec.slice(0, hashIndex);
  const ref = hashIndex === -1 ? "main" : spec.slice(hashIndex + 1) || "main";
  return { repository: normalizeRepositoryInput(repository), ref };
}

export async function loadDefaultCatalogSpec(environment = process.env) {
  if (environment.AGENTHOME_CATALOG_SPEC) return environment.AGENTHOME_CATALOG_SPEC;
  const file = defaultCatalogFile(environment);
  if (existsSync(file)) {
    const config = await readJson(file);
    if (typeof config.spec === "string" && config.spec.length > 0) return config.spec;
  }
  return DEFAULT_CATALOG_SPEC;
}

export async function setDefaultCatalogSpec(environment = process.env, spec) {
  const file = defaultCatalogFile(environment);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ schemaVersion: 1, spec }, null, 2)}\n`, "utf8");
}

function cacheDirectory(environment, repository) {
  const identity = repositoryIdentity(repository);
  const parts = identity.split(/[/:]/).filter(Boolean);
  const owner = parts.at(-2) ?? "catalog";
  const name = parts.at(-1) ?? "catalog";
  return path.join(catalogCacheRoot(environment), `${owner}-${name}`);
}

export async function ensureCatalog(spec, options = {}) {
  const environment = options.environment ?? process.env;
  const { repository, ref } = parseCatalogSpec(spec);
  const directory = cacheDirectory(environment, repository);
  try {
    if (existsSync(path.join(directory, ".git"))) {
      git(["-C", directory, "fetch", "--depth", "1", "origin", ref]);
    } else {
      await mkdir(directory, { recursive: true });
      git(["-C", directory, "init", "--quiet"]);
      git(["-C", directory, "remote", "add", "origin", repository]);
      git(["-C", directory, "fetch", "--depth", "1", "origin", ref]);
    }
    git(["-C", directory, "checkout", "--quiet", "--detach", "FETCH_HEAD"]);
    const revision = git(["-C", directory, "rev-parse", "HEAD"]);
    return { catalogRoot: directory, repository, ref, revision, spec };
  } catch (error) {
    fail(
      `${error.message}\nUnable to fetch catalog: ${spec}\n` +
      "Check your GitHub authentication (gh auth login, SSH key, or credential helper) and the catalog spec.",
    );
  }
}
```

- [ ] **Step 4: 接进 install 流程**

`install.mjs` 增加：

```js
export async function resolveCatalogSource(environment, io) {
  const spec = await loadDefaultCatalogSpec(environment);
  return ensureCatalog(spec, { environment, io });
}
```

`commandInstall` 改为：先 `resolveCatalogSource` → `loadSources(catalogRoot)`/`buildCatalog(config, skillsRoot)`/`loadPacks(catalogRoot)` → 解析安装 → `writeInstallMetadata(context, resolvedPacks, catalogInfo)`，其中 `catalogInfo = { spec: result.spec, repository: result.repository, revision: result.revision }`；`writeInstallMetadata` 的 lock.catalog 写 `{ spec, repository, revision }`（v3 锁）。
`commandUninstall`/`commandTree`/`commandPacks`/`commandStatus`/`commandDoctor`（维护模式除 doctor 外）同样从 catalogRoot 读（维护模式 catalogRoot=cwd，安装模式 catalogRoot=缓存）。

- [ ] **Step 5: skills-cli 增加 `catalog use/sync/default`**

`use`：`await setDefaultCatalogSpec(environment, spec)` + 输出当前值；`sync`：`resolveCatalogSource` + 输出缓存路径与 revision；`default`：打印 `loadDefaultCatalogSpec`。

- [ ] **Step 6: 全绿 + 提交**

Run: `node --test test/catalog-cache.test.mjs && npm test`
```bash
git add -A && git commit -m "feat: add catalog cache with pinned revisions"
```

### Task B5: 直接公开源 skills add（TDD）

**Files:**
- Create: `packages/core/src/skills/direct.mjs`、`test/skills-direct-add.test.mjs`
- Modify: `packages/core/src/skills/install.mjs`（v3 锁读写、direct 状态并入 installCopies/uninstall）、`skills-cli.mjs`（`add` 路由）

**Interfaces:**
- `directRoot(context)` → 项目 `.agents/direct` 或全局 `<stateRoot>/direct`
- `directLicensesRoot(context)` → 项目 `.agents/licenses` 或全局 `<stateRoot>/licenses`
- `readDirectState(context)` / `writeDirectState(context, state)`（v3 锁的 `directSources` 与 config 的 `direct`）
- `addDirectSkills(context, sourceReference, skillNames, options)` → 安装结果
- `removeDirectSkills(context, skillNames)` → 卸载结果
- `.gitignore` REQUIRED_RULES 增加 `.agents/direct/`、`.agents/licenses/`

- [ ] **Step 1: 写失败测试 test/skills-direct-add.test.mjs**（fixture upstream 仓库）

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentBin = path.join(packageRoot, "packages", "cli", "bin", "agent.mjs");

function runAgent(cwd, argumentsList, environment = {}) {
  return spawnSync(process.execPath, [agentBin, ...argumentsList], {
    cwd, encoding: "utf8", windowsHide: true, env: { ...process.env, ...environment },
  });
}
function git(cwd, argumentsList) {
  const result = spawnSync("git", ["-C", cwd, ...argumentsList], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function withTemp(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function upstreamFixture(root) {
  await mkdir(path.join(root, "skills"), { recursive: true });
  for (const name of ["direct-a", "direct-b"]) {
    await mkdir(path.join(root, "skills", name), { recursive: true });
    await writeFile(path.join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
  }
  await writeFile(path.join(root, "LICENSE"), "MIT\n");
  git(root, ["init", "--quiet", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "--quiet", "-m", "upstream"]);
  return git(root, ["rev-parse", "HEAD"]);
}

test("skills add installs direct public sources into project scope", async () => {
  await withTemp("direct-", async (root) => {
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    const upstream = path.join(root, "upstream");
    await mkdir(project);
    const revision = await upstreamFixture(upstream);
    const environment = { AGENTHOME_STATE_DIR: state };
    const added = runAgent(project, ["skills", "add", upstream], environment);
    assert.equal(added.status, 0, added.stderr);
    for (const name of ["direct-a", "direct-b"]) {
      assert.equal(existsSync(path.join(project, ".agents", "skills", name, "SKILL.md")), true);
      assert.equal(existsSync(path.join(project, ".claude", "skills", name, "SKILL.md")), true);
    }
    const config = JSON.parse(await readFile(path.join(project, ".agent-skills.json"), "utf8"));
    assert.equal(config.schemaVersion, 3);
    assert.equal(config.direct[0].skills.length, 2);
    const lock = JSON.parse(await readFile(path.join(project, ".agent-skills.lock.json"), "utf8"));
    assert.equal(lock.schemaVersion, 3);
    assert.equal(lock.directSources[0].revision, revision);
    assert.equal(existsSync(path.join(project, ".agents", "licenses", lock.directSources[0].id, "LICENSE")), true);
    // 重复添加幂等
    const repeated = runAgent(project, ["skills", "add", upstream], environment);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.match(repeated.stdout, /Already installed/);
  });
});

test("skills add supports single skill and uninstall-skill removes direct state", async () => {
  await withTemp("direct-single-", async (root) => {
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    const upstream = path.join(root, "upstream");
    await mkdir(project);
    await upstreamFixture(upstream);
    const environment = { AGENTHOME_STATE_DIR: state };
    const added = runAgent(project, ["skills", "add", upstream, "direct-a"], environment);
    assert.equal(added.status, 0, added.stderr);
    assert.equal(existsSync(path.join(project, ".agents", "skills", "direct-a")), true);
    assert.equal(existsSync(path.join(project, ".agents", "skills", "direct-b")), false);
    const removed = runAgent(project, ["skills", "uninstall-skill", "direct-a"], environment);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(existsSync(path.join(project, ".agents", "skills", "direct-a")), false);
    const lock = JSON.parse(await readFile(path.join(project, ".agent-skills.lock.json"), "utf8"));
    assert.equal(lock.directSources.length, 0);
  });
});

test("skills add refuses skills managed by catalog Packs", async () => {
  // 项目先装 fixture catalog 的 common（含 alpha），再从一个含 alpha 的 upstream 添加
  // → stderr /Managed by configured Packs/
});
```

- [ ] **Step 2: 跑测试确认失败** → **Step 3: 实现 direct.mjs 与 install 集成** → **Step 4: 全绿 + 提交**

```bash
git add -A && git commit -m "feat: add direct public source installation"
```

### Task B6: dispatcher 同进程接线、self-update、打包与集成测试

**Files:**
- Modify: `packages/cli/src/dispatcher.mjs`（dispatchSkills 同进程、catalog 命名空间、update 使用新 self-update）
- Create/Migrate: `packages/cli/src/self-update.mjs`（updateAgentHome 全量迁移 + agentHome.packageSpec）
- Modify: `test/runtime.test.mjs`（self-update 断言）、`integration/global-install.mjs`
- Create: `test/sync.test.mjs`、README.md、docs 复制

- [ ] **Step 1: dispatcher 接线**

`dispatchSkills` 改为：

```js
import { dispatchSkills } from "./skills-cli.mjs";
// ...
async function dispatchSkillsCommand(argumentsList) {
  return dispatchSkills(argumentsList, {
    io: console,
    cwd: process.cwd(),
    environment: process.env,
  });
}
```

`runCli` 的 `skills` 分支改为调用 `dispatchSkillsCommand`（删除子进程 spawn）；`catalog` 分支已在 B3 接入，保持不变。

`update` 分支：`await updateAgentHome(packagesCliRoot)`，其中 `packagesCliRoot` 由 `path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")` 得到（self-update.mjs 同目录上溯一级 = packages/cli）。

- [ ] **Step 2: self-update.mjs 全量迁移**

从当前仓库 `src/cli/self-update.mjs` 复制，字段名 `agentSkills?.packageSpec` → `agentHome?.packageSpec`，默认值 `"Echo-Kang-hub/agenthome-cli#main"`。

- [ ] **Step 3: runtime.test.mjs 的 self-update 用例恢复并更新断言**

```js
test("self update reinstalls the packaged CLI globally", async () => {
  const calls = [];
  const packageSpec = await agentHomePackageSpec(packageRoot);
  const result = await updateAgentHome(packageRoot, {
    spawn(executable, argumentsList) {
      calls.push({ executable, argumentsList });
      return { status: 0 };
    },
  });
  assert.equal(result, "Echo-Kang-hub/agenthome-cli#main");
  assert.deepEqual(calls, [
    { executable: "npm", argumentsList: ["install", "--global", "Echo-Kang-hub/agenthome-cli#main"] },
  ]);
});
```

（import 路径 `../packages/cli/src/self-update.mjs`；`packageRoot` 传 `packages/cli` 路径。）

- [ ] **Step 4: test/sync.test.mjs（vendor 同步守护）**

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("vendor core-src stays in sync with packages/core/src", async () => {
  const core = await readFile(path.join(packageRoot, "packages", "core", "src", "index.mjs"), "utf8");
  const vendor = await readFile(path.join(packageRoot, "packages", "cli", "vendor", "core-src", "index.mjs"), "utf8");
  assert.equal(vendor, core);
});
```

- [ ] **Step 5: integration/global-install.mjs 迁移（双模式）**

复制现有脚本，改造：
1. 函数 `verifyInstall(archive, environment, home)` 复用现有「安装→ax init→deinit --purge→卸载」逻辑（两个模式共用）。
2. 模式一（registry 等价）：`npm pack packages/cli --pack-destination <root>` → 安装 tarball。
3. 模式二（GitHub 等价）：`npm pack <repoRoot> --pack-destination <root>` → 安装根包 tarball。
4. 模式二追加 skills 验证：用 fixture catalog（脚本内建 createCatalogFixture 同上），`AGENTHOME_CATALOG_SPEC=<fixture>` + `AGENTHOME_STATE_DIR=<temp>` 下运行 `agent skills common` → 断言 `.claude/skills/alpha` 与 `.agents/skills/alpha` 存在、`.agent-skills.lock.json` 的 `catalog.revision` 等于 fixture HEAD。

- [ ] **Step 6: README.md（新仓库）与 docs 复制**

README 覆盖：安装（GitHub 直到发布；发布后 npm）、`agent`/`ac`/`ax`/`ao` 速查、skills 双源与作用域、catalog 命令、迁移说明（旧安装 shim 指引）、发布步骤（npm login → 翻转 private → npm publish --workspace）。`docs/` 从当前仓库复制 spec+plan。

- [ ] **Step 7: 全绿 + 提交**

Run: `npm test && npm run test:install && npm run pack:cli && npm pack --dry-run --json`
```bash
git add -A && git commit -m "feat: wire dispatcher, packaging, and integration tests"
```

## Phase C：当前仓库 → agenthome-catalog + 远程操作

### Task C1: 改造当前仓库为 catalog 形态

**Files（当前仓库 D:\FileDownload\Projects\agent-skills）:**
- Delete: `src/`、`bin/`、`test/`、`integration/`、`scripts/skills.mjs`、`docs/`、旧 `package.json`、旧 `README.md`
- Create: `package.json`（catalog 版 + shim bin）、`scripts/migration-shim.mjs`、新 `README.md`、替换 `.github/workflows/auto-update-skills.yml`
- Keep（不动）: `skills/`、`packs/`、`sources.lock.json`、`licenses/`、`.agents/`（含真实会话与安装数据！）、`.claude/`、`.gitignore`、`.gitattributes`、`skills-lock.json`（未跟踪，不 add）

- [ ] **Step 1: catalog package.json**

```json
{
  "name": "agenthome-catalog",
  "version": "1.0.0",
  "private": true,
  "description": "Private AgentHome Skills Catalog",
  "type": "module",
  "bin": {
    "agent": "scripts/migration-shim.mjs",
    "agenthome": "scripts/migration-shim.mjs",
    "agent-skills": "scripts/migration-shim.mjs",
    "ac": "scripts/migration-shim.mjs",
    "ax": "scripts/migration-shim.mjs",
    "ao": "scripts/migration-shim.mjs"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/Echo-Kang-hub/agenthome-catalog.git"
  }
}
```

- [ ] **Step 2: scripts/migration-shim.mjs**

```js
#!/usr/bin/env node

console.error(`AgentHome has been split into a public CLI and a private catalog.

This package is the private Skills Catalog (agenthome-catalog).

Install the CLI instead:
  npm install -g Echo-Kang-hub/agenthome-cli#main

After the CLI is published to npm:
  npm install -g agenthome-cli
`);
process.exitCode = 1;
```

- [ ] **Step 3: 更新 auto-update-skills.yml**

```yaml
name: Auto-update Skills

on:
  schedule:
    - cron: "17 4 * * *"
      timezone: "Asia/Shanghai"
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: auto-update-skills
  cancel-in-progress: false

jobs:
  update:
    name: Update vendored Skills
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install AgentHome CLI
        run: npm install -g Echo-Kang-hub/agenthome-cli#main
      - name: Update pinned sources
        shell: bash
        run: |
          for attempt in 1 2 3; do
            if agent catalog update; then
              exit 0
            fi
            echo "Update attempt ${attempt} failed."
            if [[ "${attempt}" -lt 3 ]]; then
              sleep "$((attempt * 15))"
            fi
          done
          echo "All update attempts failed."
          exit 1
      - name: Validate catalog
        run: |
          agent catalog doctor
          node --check scripts/migration-shim.mjs
      - name: Commit and push changes
        shell: bash
        run: |
          if git diff --quiet; then
            echo "All Skills are already up to date."
            exit 0
          fi
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add -A
          git commit -m "chore: auto-update vendored skills"
          git push origin HEAD:main
```

- [ ] **Step 4: 新 README.md（catalog 版）**：说明这是私有 catalog、内容结构、如何用 CLI 消费（默认 spec）、如何维护（`agent catalog ...`）、CI 行为。

- [ ] **Step 5: 删除 CLI 代码 + 提交**

```bash
git rm -r src bin test integration docs scripts/skills.mjs
# README.md / package.json 以新内容覆盖（git add）
git add -A && git commit -m "refactor: convert repository to private skills catalog"
```

### Task C2: 远程操作（gh 已授权）

- [ ] **Step 1: 前置检查**

```bash
gh auth status
git status && git remote -v
```

- [ ] **Step 2: 改名当前仓库**

```bash
gh repo rename agenthome-catalog --repo Echo-Kang-hub/agenthome --yes
cd /d/FileDownload/Projects/agent-skills
git remote set-url github https://github.com/Echo-Kang-hub/agenthome-catalog.git
git push github main
gh repo view Echo-Kang-hub/agenthome-catalog --json visibility,name
```

- [ ] **Step 3: 创建并推送新 CLI 仓库**

```bash
gh repo create agenthome-cli --public --description "Portable Skills, runtime configuration, and sessions for coding agents" --source /d/FileDownload/Projects/agenthome-cli --push
```

- [ ] **Step 4: 验证两个仓库状态**

```bash
gh repo view Echo-Kang-hub/agenthome-cli --json visibility,defaultBranchRef
gh repo view Echo-Kang-hub/agenthome-catalog --json visibility,defaultBranchRef
```

## Phase D：verification-before-completion（本机真实验证）

- [ ] **Step 1: 记录基线**（会话/认证数据哈希，验证后对比无变化）

```bash
find /d/FileDownload/Projects/agent-skills/.agents -type f | sort | xargs sha256sum > /tmp/baseline-agents.txt 2>/dev/null
```

- [ ] **Step 2: 本机真实全局安装（GitHub 模式，覆盖旧 5.4.0 安装——预期行为）**

```bash
npm install -g Echo-Kang-hub/agenthome-cli#main
```

- [ ] **Step 3: CLI 基本验证**

```bash
agent doctor          # 在 agent-skills 项目内：runtime config OK、三 agent 检测
agent status
agent codex status    # 会话读取（不写入）
agent skills status   # 读取现有锁，不安装
```

- [ ] **Step 4: 私有 catalog 认证 E2E（真实网络 + gh 凭据）**

```bash
agent catalog sync    # 克隆真实私有 catalog 到 ~/.config/agent-skills/catalog/
```

- [ ] **Step 5: 临时项目 E2E 安装（不动现有项目）**

```bash
mkdir /tmp/agenthome-e2e && cd /tmp/agenthome-e2e
agent skills common                       # 从私有 catalog 真装
agent skills tree && agent skills status
agent skills uninstall                    # 撤回，验证可逆
```

- [ ] **Step 6: 会话与数据完整性**：对比 Step 1 基线无差异；`.agents/sessions/codex` 文件数与内容不变。

- [ ] **Step 7: 项目/全局作用域与 Windows 路径**：fixture 覆盖（集成测试含 `-g` 用例）；本机 Windows 上全流程真实运行即为 Windows 路径验证。

- [ ] **Step 8: 全量测试终跑**

```bash
npm test && npm run test:install
```

## Phase E：requesting-code-review

- [ ] 调用 requesting-code-review skill，对新仓库全部变更做架构/兼容/安全/可维护性/发布审查，修复发现的问题后重新全绿。

## Self-Review（计划自审记录）

1. **Spec coverage**：拆仓（B1-B6/C1-C2）✓；core/CLI/VS Code 架构（B1 布局 + core io 解耦）✓；Agent 管理不变（B2）✓；project auth 桥接留待后续（spec 范围外，无任务）✓；便携会话（B2 测试迁移覆盖）✓；Skills/Packs/Catalog（B3/B4）✓；项目/全局作用域（B3 保留 -g，B5 direct 同样支持）✓；GitHub 私有 catalog 拉取与认证（B4 + D4）✓；npm 发布结构（B1/B6 + 文档，不发布）✓；向后兼容与迁移（shim C1、README B6、D2 真实安装）✓。
2. **Placeholder scan**：无 TBD/TODO；所有新代码给出完整实现。
3. **Type consistency**：`ensureCatalog`/`parseCatalogSpec`/`loadDefaultCatalogSpec`/`setDefaultCatalogSpec`/`catalogCacheRoot` 在 B4 定义并被 B5/B6/D 引用，签名一致；`dispatchSkills(argumentsList, { io, cwd, environment })` 在 B3 定义、B6 接线一致；`agentHome.packageSpec` 字段在 B1/B6 一致。

## Execution Handoff

用户已指定 inline 执行：使用 superpowers:executing-plans 按任务顺序实施，review checkpoint 为每个 Phase 结束。
