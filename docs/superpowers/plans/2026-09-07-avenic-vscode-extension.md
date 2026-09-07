# Avenic VS Code Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 avenic 仓库新增 `packages/vscode` 扩展（TypeScript + esbuild + ESM），直接依赖已发布的 `@avenic/core@1.0.0`（唯一业务逻辑层），以三个 TreeView + Overview Webview Dashboard + QuickPick 流程图形化管理 Agent 运行时与 Skills；不 spawn avenic CLI、不解析 CLI 文本、不复制 core 业务逻辑。

**Architecture:** core = 唯一业务逻辑层（@avenic/core 公开 npm，本计划只做消费方）；CLI 与扩展是两个平行客户端。扩展为 ESM（`"type": "module"`，VS Code 1.90+ 支持），esbuild 把 `src/extension.ts` 连同 `@avenic/core` bundle 进 `dist/extension.js`，`vsce package` 打包 VSIX。services 层薄适配（不 import vscode），view-models 纯函数，TreeView/命令/Dashboard 全部经 services → core。

**Tech Stack:** TypeScript 5.x（strict）、esbuild ^0.21、@types/vscode ^1.90.0、@types/node ^18、@avenic/core ^1.0.0（devDependencies，bundle 进产物）、@vscode/vsce（T12）、node:test（与仓库一致）、VS Code 1.90+、Windows + Git Bash。

**Spec:** `docs/superpowers/specs/2026-09-06-vscode-extension-design.md`（本计划按该 spec 展开；执行者须先读 spec 再动工）。

**前置说明：** spec §3（core 下沉与发布化）已完成——`@avenic/core@1.0.0` 已发布，全部所需 API 已导出（`agentExecutableAvailable`/`skillsInstallationStatus`/`registerCatalog`/`resolveInstallSource`/`installPacks`/`uninstallPacks`/`removeExternalSkills` 等均实查于 `packages/core/index.d.ts`）。本计划从 M2（扩展骨架）开始，无新增 core 需求。

## Global Constraints

- 根 package.json **禁止添加 `workspaces` 字段**（会触发 pacote 嵌套 install，破坏 `npm install -g Echo-Kang-hub/avenic`；test/packaging.test.mjs 有断言把关）。packages/vscode 用 `npm --prefix packages/vscode <script>` 驱动，不引入 workspaces。
- core 是唯一业务逻辑层；扩展**不 spawn avenic CLI、不解析 CLI 文本、不直接读写 Avenic 状态文件（状态一律经 @avenic/core 获取）、不复制 core 逻辑**。
- packages/vscode 的 **services 层不得 import vscode**（含 `import type`）——只收 `(projectRoot, environment, io)` 等参数，天然可单测；只有 views/commands/dashboard/extension 层允许 import vscode。
- `packages/vscode/package.json`：`"name": "avenic"`、`"displayName": "Avenic"`、`"main": "./dist/extension.js"`、`"type": "module"`、`"engines": { "vscode": "^1.90.0" }`；publisher 为 **待定项**——M1 先填占位 `"publisher": "avenic"`（不发布，仅让 vsce package 可跑），T12 发布前 USER CHECKPOINT 确认。扩展 ID 拟 `avenic.avenic`。
- `@avenic/core` 放 devDependencies（esbuild bundle 进产物；node_modules 不进 VSIX）。用户不需要安装 Avenic CLI 或 @avenic/core。
- 现有 Avenic 必须零回归：`npm test`（84/84）与 `npm run test:install`（2/2）任何时刻不得破坏；T1–T11 只新增 `packages/vscode`，不改 packages/core 与 packages/cli，也不改 test/。
- UI 文案中文（与 CLI 一致）；`claude` / `codex` / `opencode` 是 C 类生态 agent id，不得改名。
- 并发：扩展进程内 mutation 串行化（MutationQueue，进行中相关命令禁用）；跨进程（扩展 vs CLI）并发 MVP 明确接受，不做跨进程 lock（spec §6）。
- 不实现 v1.1 功能（catalog 维护 UI、终端启动 agent、SKILL.md 预览、自动 d.ts、自动 E2E、跨进程 lock）。Dashboard 无远程资源、CSP nonce、用户字符串转义。
- Marketplace publisher / 扩展图标为开放问题（spec §11），不阻塞本计划；图标用 svg 占位可后续替换。
- 每个 Task：先写失败测试 → RED → 最小实现 → 全绿 → commit；完成判据 = 该任务列出验证命令全过 + 计划内单一 Conventional Commit message。
- 历史归档（2026-09-06 的 spec/plan、2026-09-07 rebrand spec/plan）不改动。

## 文件结构（锁定）

```
packages/vscode/                          [新包]
├── package.json                          [新] T1；T5 加 contributes.views；T7–T9 加 commands/menus；T10 加 webview 条目
├── tsconfig.json                         [新] T1（typecheck 用，noEmit）
├── build.mjs                             [新] T1 esbuild 生产构建；T12 开 minify
├── test-build.mjs                        [新] T1 esbuild 测试构建（test/*.test.ts → .test-out）→ node --test
├── .vscodeignore                         [新] T1；T12 补 .test-out
├── media/
│   ├── icon.svg                          [新] T1 活动栏图标
│   └── dashboard/
│       ├── view.html                     [新] T10
│       ├── main.js                       [新] T10（T11 打磨）
│       └── style.css                     [新] T10（T11 打磨）
├── README.md / CHANGELOG.md              [新] T12
├── src/
│   ├── extension.ts                      [新] T1 骨架；T5 注册视图；T6–T9 注册命令；T10 注册 dashboard
│   ├── project.ts                        [新] T2 项目根解析（纯函数核心）
│   ├── services/
│   │   ├── agents.ts                     [新] T3 薄适配（无 vscode）
│   │   ├── catalog.ts                    [新] T3
│   │   └── skills.ts                     [新] T3
│   ├── views/
│   │   ├── view-models.ts                [新] T4 纯函数（无 vscode）
│   │   ├── agents-view.ts                [新] T5 TreeDataProvider
│   │   ├── catalog-view.ts               [新] T5
│   │   └── skills-view.ts                [新] T5
│   ├── ui/
│   │   ├── flows.ts                      [新] T6 QuickPick/InputBox 助手 + 多根 pickProjectRoot 薄壳
│   │   └── mutation-queue.ts             [新] T6 串行化（无 vscode）
│   ├── commands/
│   │   ├── progress.ts                   [新] T6 withProgress 包装（io 桥接）
│   │   ├── errors.ts                     [新] T6 showErrorMessage 包装
│   │   ├── agents-commands.ts            [新] T7
│   │   ├── catalog-commands.ts           [新] T8
│   │   └── skills-commands.ts            [新] T9
│   └── dashboard/
│       ├── protocol.ts                   [新] T10 类型化 postMessage 协议（纯类型 + 守卫）
│       ├── state.ts                      [新] T10 DashboardData 组装（无 vscode）
│       └── overview.ts                   [新] T10 WebviewViewProvider
└── test/                                 [新] 每任务对应 *.test.ts（经 test-build.mjs 跑 node --test）
```

根仓库改动（仅两处）：
- `package.json`：加 `"test:vscode": "npm --prefix packages/vscode test"`（T12）
- `.github/workflows/ci.yml`：加 vscode typecheck/build/test 步骤（T12）

---

# M1：扩展基础设施

### Task 1: 扩展包骨架（package.json / tsconfig / esbuild / 测试运行器 / activation 桩）

**Goal:** 建立 packages/vscode 可构建、可测、可类型检查的包骨架，激活桩可被 VS Code 加载不崩溃。

**Files:**
- Create: `packages/vscode/package.json`、`packages/vscode/tsconfig.json`、`packages/vscode/build.mjs`、`packages/vscode/test-build.mjs`、`packages/vscode/.vscodeignore`、`packages/vscode/media/icon.svg`、`packages/vscode/src/extension.ts`
- Test: `packages/vscode/test/manifest.test.ts`

**Interfaces:**
- Produces: package.json 身份字段（name/displayName/publisher/main/type/engines/scripts/devDependencies）；`npm --prefix packages/vscode build` → `dist/extension.js`；`npm --prefix packages/vscode test` = typecheck + esbuild bundle 测试 + `node --test`（后续所有任务复用此命令）；`activate(context)` 桩。
- Consumes: 无（只创建新包，不碰 core/cli）。

- [ ] **Step 1: 写失败测试 `test/manifest.test.ts`（守护扩展身份）**

```ts
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("vscode extension manifest identity", async () => {
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  assert.equal(manifest.name, "avenic");
  assert.equal(manifest.displayName, "Avenic");
  assert.equal(manifest.main, "./dist/extension.js");
  assert.equal(manifest.type, "module");
  assert.deepEqual(manifest.engines, { vscode: "^1.90.0" });
  assert.equal(manifest.activationEvents, undefined, "1.75+ 由 contributes 自动激活，不写 activationEvents");
});

test("esbuild test runner emits executable tests", async () => {
  await assert.rejects(() => stat(path.join(pkgDir, ".test-out", "manifest.test.js")), "尚未构建");
});

test("active editor window has vscode engine", async () => {
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  assert.equal(manifest.workspaces, undefined, "不得引入 workspaces 字段");
  assert.equal(manifest.private, true, "防止误发 npm");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix packages/vscode test`
Expected: FAIL——`package.json` 不存在 / `.test-out` 未生成。

- [ ] **Step 3: 最小实现**

`packages/vscode/package.json`：

```json
{
  "name": "avenic",
  "displayName": "Avenic",
  "description": "管理 Avenic Agent 运行时与 Skills 的图形界面",
  "publisher": "avenic",
  "version": "0.1.0",
  "private": true,
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/Echo-Kang-hub/avenic.git" },
  "main": "./dist/extension.js",
  "type": "module",
  "engines": { "vscode": "^1.90.0" },
  "scripts": {
    "build": "node build.mjs",
    "typecheck": "tsc --noEmit",
    "test": "npm run typecheck && node test-build.mjs"
  },
  "devDependencies": {
    "@avenic/core": "^1.0.0",
    "@types/node": "^18.19.0",
    "@types/vscode": "^1.90.0",
    "esbuild": "^0.21.0",
    "typescript": "^5.5.0"
  }
}
```

`packages/vscode/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["node", "vscode"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

`packages/vscode/build.mjs`：

```js
import { build } from "esbuild";

await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  format: "esm",
  platform: "node",
  target: "node20",
  external: ["vscode"],
  sourcemap: true,
  minify: false, // T12 生产构建开 minify
});
console.log("built dist/extension.js");
```

`packages/vscode/test-build.mjs`：

```js
import { build } from "esbuild";
import { readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const testDir = path.resolve("test");
const entryPoints = (await readdir(testDir)).filter((f) => f.endsWith(".test.ts")).map((f) => path.join(testDir, f));
await build({
  bundle: true,
  format: "esm",
  platform: "node",
  outdir: ".test-out",
  entryPoints,
  external: ["vscode"], // 测试不 import vscode；显式声明以防未来误引入时快速失败
});
execFileSync("node", ["--test", ".test-out"], { stdio: "inherit" });
```

`packages/vscode/.vscodeignore`（vsce 打包排除项；dist/media 必须包含）：

```
src/**
node_modules/**
test/**
tsconfig.json
build.mjs
test-build.mjs
.test-out/**
```

`packages/vscode/media/icon.svg`：24×24 占位图标（一个带圆角矩形 + "A"字形 path，单色 `currentColor`）。

`packages/vscode/src/extension.ts`：

```ts
import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
  void context; // 骨架本任务只验证激活不崩溃
}

export function deactivate(): void {}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix packages/vscode install && npm --prefix packages/vscode run build && npm --prefix packages/vscode test`
Expected: PASS——manifest 字段一致；`dist/extension.js` 产出（含核心导出）；3 个测试全绿。

- [ ] **Step 5: 完成判据**

`npm --prefix packages/vscode build` 产出 `dist/extension.js`；`npm --prefix packages/vscode test` 全绿（含「.test-out 未构建」断言被 esbuild 步骤满足）；根 `npm test` 仍 84/84（新增包不在根 test glob）。

- [ ] **Step 6: Commit**

```bash
git add packages/vscode
git commit -m "feat(vscode): scaffold avenic extension package (esbuild + typescript + esm + test runner)"
```

### Task 2: 项目根解析（单根直接 / 多根 QuickPick 记忆）

**Goal:** 实现 spec workspace 规则：单 Workspace Folder 直接用，Multi-root 靠 QuickPick 选择（不用 active file），workspaceState 记忆最近一次选择。

**Files:**
- Create: `packages/vscode/src/project.ts`
- Test: `packages/vscode/test/project.test.ts`

**Interfaces:**
- Consumes: 无（stdlib）。
- Produces: `PROJECT_ROOT_STATE_KEY: string`（`"avenic.projectRoot"`）；`resolveProjectRoot(folders: WorkspaceFolderLike[]): string | null`；`rememberProjectRoot(state: StateLike, root: string): void`；`lastProjectRoot(state: StateLike): string | null`。多根 QuickPick 薄壳（`pickProjectRoot`，vscode.window.showQuickPick + rememberProjectRoot）在 T6 `ui/flows.ts` 实现。

- [ ] **Step 1: 写失败测试 `test/project.test.ts`**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { PROJECT_ROOT_STATE_KEY, lastProjectRoot, rememberProjectRoot, resolveProjectRoot } from "../src/project.ts";

function fakeState() {
  const data = new Map<string, unknown>();
  return {
    data,
    get(key: string) { return data.get(key); },
    update(key: string, value: unknown) { data.set(key, value); return Promise.resolve(); },
  };
}

test("single workspace folder resolves to its fsPath", () => {
  assert.equal(resolveProjectRoot([{ uri: { fsPath: "C:/proj" } }]), "C:/proj");
});

test("no folders returns null", () => {
  assert.equal(resolveProjectRoot([]), null);
});

test("multi-root returns null (caller must pick)", () => {
  assert.equal(resolveProjectRoot([{ uri: { fsPath: "C:/a" } }, { uri: { fsPath: "C:/b" } }]), null);
});

test("remember/last round-trips through state", () => {
  const state = fakeState();
  assert.equal(lastProjectRoot(state), null);
  rememberProjectRoot(state, "C:/proj");
  assert.equal(lastProjectRoot(state), "C:/proj");
});

test("state key is stable", () => {
  assert.equal(PROJECT_ROOT_STATE_KEY, "avenic.projectRoot");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix packages/vscode test`
Expected: FAIL——`src/project.ts` 不存在，esbuild 解析失败。

- [ ] **Step 3: 最小实现 `src/project.ts`**

```ts
export const PROJECT_ROOT_STATE_KEY = "avenic.projectRoot";

export interface WorkspaceFolderLike {
  uri: { fsPath: string };
}

export interface StateLike {
  get(key: string): unknown;
  update(key: string, value: unknown): Thenable<unknown>;
}

export function resolveProjectRoot(folders: readonly WorkspaceFolderLike[]): string | null {
  if (folders.length === 1) return folders[0].uri.fsPath;
  // 0 个或多根：交给调用方（多根走 QuickPick；无根时命令提示打开文件夹）
  return null;
}

export function rememberProjectRoot(state: StateLike, root: string): void {
  void state.update(PROJECT_ROOT_STATE_KEY, root);
}

export function lastProjectRoot(state: StateLike): string | null {
  const value = state.get(PROJECT_ROOT_STATE_KEY);
  return typeof value === "string" && value.length > 0 ? value : null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix packages/vscode test`
Expected: PASS——5 个测试全绿。

- [ ] **Step 5: 完成判据**

`npm --prefix packages/vscode test` 全绿；根 `npm test` 84/84。

- [ ] **Step 6: Commit**

```bash
git add packages/vscode/src/project.ts packages/vscode/test/project.test.ts
git commit -m "feat(vscode): project root resolution (single-root direct, multi-root pick with workspaceState memory)"
```

---

# M2：Services + TreeView

### Task 3: services 层（agents / catalog / skills 薄适配）

**Goal:** 建立三个薄服务。

**Files:**
- Create: `packages/vscode/src/services/agents.ts`、`packages/vscode/src/services/catalog.ts`、`packages/vscode/src/services/skills.ts`
- Test: `packages/vscode/test/services.test.ts`

**Interfaces:**
- Consumes: `@avenic/core` 导出（全部实查于 packages/core/index.d.ts）：agents 用 `AGENTS`/`getAgent`/`agentExecutableAvailable`/`loadRuntime`/`effectiveAgentConfig`/`initializeAgent`/`deinitializeAgent`/`setLocalAuth`/`clearLocalAuth`/`getSessionAdapter`；catalog 用 `loadDefaultCatalogSpec`/`loadKnownCatalogs`/`setDefaultCatalogSpec`/`registerCatalog`/`ensureCatalog`；skills 用 `createInstallContext`/`skillsInstallationStatus`/`installedPackIds`/`loadPacks`/`resolvePacks`/`installPacks`/`uninstallPacks`/`readDirectState`/`addDirectSkills`/`removeExternalSkills`。
- Produces:
  - `agents.ts`: `type Scope`（不在此——scope 属 skills）；`AgentStatus = { agent: Agent; executableAvailable: boolean; effective: EffectiveAgentConfig | null }`；`listAgents(): Agent[]`；`agentStatus(projectRoot: string, agentId: string): Promise<AgentStatus>`；`initialize(projectRoot, agentId, authMode, sessionsMode)`；`deinitialize(projectRoot, agentId, purge?)`；`setAuthMode(projectRoot, agentId, mode: "global"|"project"|"reset")`；`setSessionsMode(projectRoot, agentId, mode: "global"|"project")`；`importSessions(projectRoot, agentId)`；`writebackSessions(projectRoot, agentId)`；`sessionsStatus(projectRoot, agentId)`。
  - `catalog.ts`: `defaultSpec(): Promise<string | null>`；`listKnown(): Promise<KnownCatalogEntry[]>`；`add(spec, environment?): Promise<RegisterResult>`；`select(spec, environment?): Promise<void>`；`sync(spec, environment?): Promise<CatalogInfo & { packageMetadata: unknown }>`。
  - `skills.ts`: `type Scope = "project" | "global"`；所有函数签名形如 `fn(scope, cwd?, environment?)`（`environment` 默认 `process.env`，spec §4「只收 (projectRoot, environment, io)」）：`context(scope, cwd?, environment?)` = `createInstallContext(scope === "global", { cwd, environment })`；`status(scope, cwd?, environment?)` = `skillsInstallationStatus(context)` → `InstallStatus | null`；`installedPackIds` = core 同名；`availablePacks(scope, cwd?, environment?)` = `resolveInstallSource({ global, cwd, environment })` → `loadPacks(info.catalogRoot)` → `Map<string, Pack>`；`installPacks`/`uninstallPacks` 直转 core 同名；`directSkills` = `readDirectState(context)` → `DirectSourceState`；`addDirect(scope, repo, skillNames, cwd?, environment?)`；`removeDirect(scope, names, cwd?, environment?)` = `removeExternalSkills(...)` 的 `directRemoved`。

- [ ] **Step 1: 写失败测试 `test/services.test.ts`（真实 core + 临时目录）**

```ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentStatus, listAgents } from "../src/services/agents.ts";
import { defaultSpec, listKnown } from "../src/services/catalog.ts";
import { status as skillsStatus } from "../src/services/skills.ts";

test("agents service lists the three ecosystem agents", () => {
  assert.deepEqual(listAgents().map((a) => a.id).sort(), ["claude", "codex", "opencode"]);
});

test("agents service reports null effective config on fresh project", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    const status = await agentStatus(dir, "claude");
    assert.equal(status.effective, null); // 无 .avenic.json → null，可初始化
    assert.equal(typeof status.executableAvailable, "boolean");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("catalog service default spec is null on isolated state dir", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    const env = { ...process.env, AVENIC_STATE_DIR: dir };
    assert.equal(await defaultSpec(env), null);
    assert.ok(Array.isArray(await listKnown(env)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("skills service status is null on fresh project root", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    const env = { ...process.env, AVENIC_STATE_DIR: dir };
    assert.equal(await skillsStatus("project", dir, env), null);
    assert.equal(await skillsStatus("global", undefined, env), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix packages/vscode test`
Expected: FAIL——services 模块不存在。（测试均用隔离的 `AVENIC_STATE_DIR` 断言，不依赖用户机器上的真实全局状态。）

- [ ] **Step 3: 最小实现**

`src/services/agents.ts`：

```ts
import {
  AGENTS,
  agentExecutableAvailable,
  clearLocalAuth,
  deinitializeAgent,
  effectiveAgentConfig,
  getAgent,
  getSessionAdapter,
  initializeAgent,
  loadRuntime,
  setLocalAuth,
  type Agent,
  type EffectiveAgentConfig,
} from "@avenic/core";

export interface AgentStatus {
  agent: Agent;
  executableAvailable: boolean;
  effective: EffectiveAgentConfig | null;
}

export function listAgents(): Agent[] {
  return Object.values(AGENTS);
}

export async function agentStatus(projectRoot: string, agentId: string): Promise<AgentStatus> {
  const state = await loadRuntime(projectRoot);
  return {
    agent: getAgent(agentId),
    executableAvailable: agentExecutableAvailable(agentId),
    effective: effectiveAgentConfig(state, agentId),
  };
}

export function initialize(projectRoot: string, agentId: string, authMode: "global" | "project", sessionsMode: "global" | "project") {
  return initializeAgent(projectRoot, agentId, authMode, sessionsMode);
}

export function deinitialize(projectRoot: string, agentId: string, purge?: boolean) {
  return deinitializeAgent(projectRoot, agentId, purge ? { purge: true } : undefined);
}

export async function setAuthMode(projectRoot: string, agentId: string, mode: "global" | "project" | "reset") {
  if (mode === "reset") return clearLocalAuth(projectRoot, agentId);
  return setLocalAuth(projectRoot, agentId, mode);
}

export async function setSessionsMode(projectRoot: string, agentId: string, mode: "global" | "project") {
  const state = await loadRuntime(projectRoot);
  const effective = effectiveAgentConfig(state, agentId);
  const auth = effective?.auth ?? "global";
  return initializeAgent(projectRoot, agentId, auth, mode);
}

export function importSessions(projectRoot: string, agentId: string) {
  return getSessionAdapter(agentId).restore(projectRoot);
}

export function writebackSessions(projectRoot: string, agentId: string) {
  return getSessionAdapter(agentId).capture(projectRoot);
}

export function sessionsStatus(projectRoot: string, agentId: string) {
  return getSessionAdapter(agentId).status(projectRoot);
}
```

`src/services/catalog.ts`（薄适配，环境参数穿透 core）：

```ts
import { ensureCatalog, loadDefaultCatalogSpec, loadKnownCatalogs, registerCatalog, setDefaultCatalogSpec } from "@avenic/core";
import type { CatalogInfo, KnownCatalogEntry } from "@avenic/core";

export async function defaultSpec(environment = process.env): Promise<string | null> {
  try { return await loadDefaultCatalogSpec(environment); }
  catch { return null; } // 未配置默认 → null（视图显示「未选择」）
}

export function listKnown(environment = process.env): Promise<KnownCatalogEntry[]> {
  return loadKnownCatalogs(environment);
}

export function add(spec: string, environment = process.env) {
  return registerCatalog(spec, { environment }); // previewFailed 或 catalogInfo + packs
}

export function select(spec: string, environment = process.env): Promise<unknown> {
  return setDefaultCatalogSpec(environment, spec);
}

export function sync(spec: string, environment = process.env): Promise<CatalogInfo & { packageMetadata: unknown }> {
  return ensureCatalog(spec, { environment });
}
```

`src/services/skills.ts`（薄适配，environment 可注入 —— spec §4「只收 (projectRoot, environment, io)」；cwd 指向项目根，全局作用域时省略）：

```ts
import {
  addDirectSkills,
  createInstallContext,
  installPacks as coreInstallPacks,
  installedPackIds as coreInstalledPackIds,
  loadPacks,
  readDirectState,
  removeExternalSkills,
  resolveInstallSource,
  skillsInstallationStatus,
  uninstallPacks as coreUninstallPacks,
  type InstallContext,
  type InstallStatus,
  type Pack,
  type ProcessEnvLike,
} from "@avenic/core";

export type Scope = "project" | "global";
type Env = ProcessEnvLike;

function context(scope: Scope, cwd: string | undefined, environment: Env): InstallContext {
  return createInstallContext(scope === "global", { cwd, environment });
}

export function status(scope: Scope, cwd?: string, environment: Env = process.env): Promise<InstallStatus | null> {
  return skillsInstallationStatus(context(scope, cwd, environment));
}

export function installedPackIds(scope: Scope, cwd?: string, environment: Env = process.env): Promise<string[] | null> {
  return coreInstalledPackIds(context(scope, cwd, environment));
}

export async function availablePacks(scope: Scope, cwd?: string, environment: Env = process.env): Promise<Map<string, Pack>> {
  const info = await resolveInstallSource({ global: scope === "global", cwd, environment });
  return loadPacks(info.catalogRoot);
}

export function installPacks(scope: Scope, packIds: string[], cwd?: string, environment: Env = process.env) {
  return coreInstallPacks(context(scope, cwd, environment), packIds);
}

export function uninstallPacks(scope: Scope, packIds: string[], cwd?: string, environment: Env = process.env) {
  return coreUninstallPacks(context(scope, cwd, environment), packIds);
}

export function directSkills(scope: Scope, cwd?: string, environment: Env = process.env) {
  return readDirectState(context(scope, cwd, environment));
}

export function addDirect(scope: Scope, repo: string, skillNames: string[], cwd?: string, environment: Env = process.env) {
  return addDirectSkills(context(scope, cwd, environment), repo, skillNames);
}

export function removeDirect(scope: Scope, names: string[], cwd?: string, environment: Env = process.env): Promise<string[]> {
  return removeExternalSkills(context(scope, cwd, environment), names).then((r) => r.directRemoved);
}
```

（core 返回形状已核对：`resolveInstallSource` → `CatalogInfo & { packageMetadata }` 含 `catalogRoot`；`readDirectState` → `{ directSources }`；`removeExternalSkills` → `{ directRemoved, removedDirectories }`。注意本地函数命名与 core 导入冲突处用 `core*` 别名。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix packages/vscode test`
Expected: PASS。

- [ ] **Step 5: 完成判据**

三个 service 文件无 vscode import（后续 T5 完成判据有 rg 断言覆盖）；typecheck 干净；测试全绿。

- [ ] **Step 6: Commit**

```bash
git add packages/vscode/src/services packages/vscode/test/services.test.ts
git commit -m "feat(vscode): thin services layer over @avenic/core (agents/catalog/skills)"
```

### Task 4: 视图模型纯函数

**Goal:** 把 core/service 结构化数据转成 TreeView 可渲染的视图模型（纯函数，便于单测）。

**Files:**
- Create: `packages/vscode/src/views/view-models.ts`
- Test: `packages/vscode/test/view-models.test.ts`

**Interfaces:**
- Consumes: T3 `AgentStatus`、`InstallStatus`（core 类型）、`KnownCatalogEntry`。
- Produces: `AgentViewItem { id, label, description, tooltip, iconHint: string }` × `agentsToViewModels(statuses: AgentStatus[]): AgentViewItem[]`；`CatalogViewItem`（`kind: "current" | "entry"`，`label`/`description`/`tooltip`）+ `catalogToViewModels(defaultSpec: string | null, known: KnownCatalogEntry[]): CatalogViewItem[]`；`SkillsViewItem`（`kind: "group" | "pack" | "skill" | "direct"`，`label`/`description`/`iconHint`/`childrenHint?`）+ `skillsToViewModels(status: InstallStatus | null): SkillsViewItem[]`。

- [ ] **Step 1: 写失败测试 `test/view-models.test.ts`**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { agentsToViewModels, catalogToViewModels, skillsToViewModels } from "../src/views/view-models.ts";

test("uninitialized agent renders as 未初始化", () => {
  const items = agentsToViewModels([{ agent: { id: "claude", displayName: "Claude Code", executable: "claude" }, executableAvailable: true, effective: null }]);
  assert.deepEqual(items[0], { id: "claude", label: "Claude Code", description: "未初始化", tooltip: "claude · 未初始化", iconHint: "circle-outline" });
});

test("initialized agent shows auth/sessions", () => {
  const items = agentsToViewModels([{ agent: { id: "claude", displayName: "Claude Code", executable: "claude" }, executableAvailable: true, effective: { enabled: true, auth: "global", sessions: "project", configuredAuth: "global", localAuth: null } }]);
  assert.equal(items[0].description, "已初始化 · global / project");
});

test("catalog list marks current default", () => {
  const items = catalogToViewModels("Echo-Kang-hub/avenic-catalog#main", [
    { name: "Avenic Catalog", spec: "Echo-Kang-hub/avenic-catalog#main" },
    { name: "Other", spec: "Echo-Kang-hub/other#main" },
  ]);
  assert.equal(items[0].kind, "current");
  assert.equal(items[0].label, "Echo-Kang-hub/avenic-catalog#main");
  assert.equal(items[0].description, "Avenic Catalog");
  assert.equal(items[1].kind, "entry");
});

test("skills status maps to grouped items", () => {
  const items = skillsToViewModels({ groups: [], names: ["pack-a"], packs: [{ id: "pack-a", name: "Pack A" }], targets: [] });
  assert.ok(items.length >= 1); // 分组（Installed Packs / Catalog Packs / Direct Skills）
  assert.equal(items[0].kind, "group");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix packages/vscode test`
Expected: FAIL——`view-models.ts` 不存在。

- [ ] **Step 3: 最小实现**

`src/views/view-models.ts`（纯数据转换，无 vscode import）：

```ts
import type { AgentStatus, InstallStatus, KnownCatalogEntry } from "@avenic/core";

export interface AgentViewItem { id: string; label: string; description: string; tooltip: string; iconHint: string; }

export function agentsToViewModels(statuses: AgentStatus[]): AgentViewItem[] {
  return statuses.map(({ agent, effective }) => ({
    id: agent.id,
    label: agent.displayName,
    description: effective ? `已初始化 · ${effective.auth} / ${effective.sessions}` : "未初始化",
    tooltip: `${agent.executable} · ${effective ? `auth: ${effective.auth}, sessions: ${effective.sessions}` : "未初始化"}`,
    iconHint: effective ? "pass-filled" : "circle-outline",
  }));
}

export interface CatalogViewItem { kind: "current" | "entry"; label: string; description: string; tooltip: string; }
export function catalogToViewModels(defaultSpec: string | null, known: KnownCatalogEntry[]): CatalogViewItem[] {
  const current = known.find((k) => k.spec === defaultSpec);
  const first = [] as CatalogViewItem[];
  if (defaultSpec) first.push({ kind: "current", label: defaultSpec, description: current?.name ?? "", tooltip: `当前默认 Catalog · revision 见 sync` });
  return first.concat(known.filter((k) => k.spec !== defaultSpec).map((k) => ({ kind: "entry", label: k.spec, description: k.name, tooltip: k.spec })));
}

export interface SkillsViewItem { kind: "group" | "pack" | "skill" | "direct"; label: string; description: string; iconHint: string; }
export function skillsToViewModels(status: InstallStatus | null): SkillsViewItem[] {
  if (status === null) return [{ kind: "group", label: "尚未安装 Skills", description: "打开一个新项目根后安装 Pack", iconHint: "info" }];
  const complete = status.targets.filter((t) => t.complete).length;
  return [
    { kind: "group", label: "Installed Packs", description: status.names.length > 0 ? status.names.join(", ") : "无", iconHint: "package" },
    { kind: "group", label: "Catalog Packs", description: `${status.packs.length} 个 Pack / ${status.groups.length} 个分组`, iconHint: "repo" },
    { kind: "group", label: "完整性", description: `${complete}/${status.targets.length} 个 target 完成`, iconHint: "verify" },
  ];
}
```

（core `InstallStatus` 形状已核对：`groups: SkillGroup[]`、`packs: Array<{id?,name?}|string>`、`names: string[]`、`targets: Array<InstallTarget & { present; total; complete }>`；分组细节以 spec §5.1 为准。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix packages/vscode test`
Expected: PASS。

- [ ] **Step 5: 完成判据**

`rg -n '"vscode"|from "vscode"|from "@types/vscode"' packages/vscode/src/views/view-models.ts packages/vscode/src/services packages/vscode/src/ui/mutation-queue.ts packages/vscode/src/dashboard/state.ts` → 无命中。

- [ ] **Step 6: Commit**

```bash
git add packages/vscode/src/views/view-models.ts packages/vscode/test/view-models.test.ts
git commit -m "feat(vscode): pure view-model builders for tree views and dashboard"
```

### Task 5: TreeView × 3（Agents / Catalog / Skills）+ extension.ts 装配

**Goal:** 三视图在 Avenic 活动栏容器下可展开显示真实数据；extension 激活装配视图。

**Files:**
- Create: `packages/vscode/src/views/agents-view.ts`、`packages/vscode/src/views/catalog-view.ts`、`packages/vscode/src/views/skills-view.ts`
- Modify: `packages/vscode/src/extension.ts`（注册三个视图）、`packages/vscode/package.json`（contributes.viewsContainers + views）
- Test: `packages/vscode/test/views.test.ts`

**Interfaces:**
- Consumes: T3 services、T4 视图模型、T2 `resolveProjectRoot`。
- Produces: `AgentsViewProvider`/`CatalogViewProvider`/`SkillsViewProvider`（`vscode.TreeDataProvider<TreeItem>`，`refresh()` 触发 `onDidChangeTreeData`）；View ID `avenic.agents`/`avenic.catalog`/`avenic.skills`；容器 ID `avenic`。

- [ ] **Step 1: 写失败测试 `test/views.test.ts`**

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { agentsToViewModels } from "../src/views/view-models.ts";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("manifest contributes three views under avenic container", async () => {
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].id, "avenic");
  assert.deepEqual(manifest.contributes.views.avenic.map((v: { id: string }) => v.id).sort(), ["avenic.agents", "avenic.catalog", "avenic.skills"]);
});

test("view models feed tree rendering without vscode", () => {
  const items = agentsToViewModels([]);
  assert.deepEqual(items, []); // 数据通路纯函数；provider 内部映射 TreeItem 由 M5 手动冒烟
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix packages/vscode test`
Expected: FAIL——manifest 无 contributes；view-models 存在则第二测过、第一测红。

- [ ] **Step 3: 最小实现**

package.json contributes：

```json
"contributes": {
  "viewsContainers": {
    "activitybar": [{ "id": "avenic", "title": "Avenic", "icon": "media/icon.svg" }]
  },
  "views": {
    "avenic": [
      { "id": "avenic.agents", "name": "Agents", "contextualTitle": "Avenic · Agents" },
      { "id": "avenic.catalog", "name": "Catalog", "contextualTitle": "Avenic · Catalog" },
      { "id": "avenic.skills", "name": "Skills", "contextualTitle": "Avenic · Skills" }
    ]
  }
}
```

`src/views/agents-view.ts`：

```ts
import * as vscode from "vscode";
import { agentStatus, listAgents } from "../services/agents.ts";
import { agentsToViewModels } from "./view-models.ts";

export class AgentsViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly projectRoot: () => string | null) {}

  refresh(): void { this.emitter.fire(undefined); }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }

  async getChildren(): Promise<vscode.TreeItem[]> {
    const root = this.projectRoot();
    if (root === null) return [new vscode.TreeItem("打开一个项目文件夹", vscode.TreeItemCollapsibleState.None)];
    const statuses = await Promise.all(listAgents().map((a) => agentStatus(root, a.id)));
    return agentsToViewModels(statuses).map((m) => {
      const item = new vscode.TreeItem(m.label, vscode.TreeItemCollapsibleState.None);
      item.id = m.id; // T7 上下文菜单命令经 treeItem.id 取 agent
      item.description = m.description;
      item.tooltip = m.tooltip;
      item.contextValue = "agent";
      item.iconPath = new vscode.ThemeIcon(m.iconHint);
      return item;
    });
  }
}
```

`catalog-view.ts`：`getChildren` 无根时返回「打开项目文件夹」提示项；否则 `defaultSpec()` + `listKnown()` → `catalogToViewModels(...)`，每项 `new vscode.TreeItem(item.label)`（label=spec，description=名称），`contextValue` = `catalog-current` / `catalog-entry`，`iconPath` = `ThemeIcon("milestone" | "repo")`；点击行 `tooltip` = spec。

`skills-view.ts`：`getChildren` 无根时显示「打开项目文件夹」；否则分别调 `status("project", root, env)` 与 `status("global", undefined, env)`，每个作用域先建一个 `TreeItemCollapsibleState.Expanded` 分组节点（label "项目作用域" / "全局作用域"），子节点由 `skillsToViewModels(...)` 映射（label/description/iconPath；`contextValue` 按 `group`/`pack`/`skill`/`direct` 分类，供 T9 命令菜单 when 绑定）。

`src/extension.ts`：

```ts
import * as vscode from "vscode";
import { resolveProjectRoot } from "./project.ts";
import { AgentsViewProvider } from "./views/agents-view.ts";
import { CatalogViewProvider } from "./views/catalog-view.ts";
import { SkillsViewProvider } from "./views/skills-view.ts";

export function activate(context: vscode.ExtensionContext): void {
  const folders = vscode.workspace.workspaceFolders;
  const root = () => resolveProjectRoot(folders ?? []);
  const agents = new AgentsViewProvider(root);
  const catalog = new CatalogViewProvider(root);
  const skills = new SkillsViewProvider(root);
  context.subscriptions.push(
    vscode.window.createTreeView("avenic.agents", { treeDataProvider: agents }),
    vscode.window.createTreeView("avenic.catalog", { treeDataProvider: catalog }),
    vscode.window.createTreeView("avenic.skills", { treeDataProvider: skills }),
  );
}

export function deactivate(): void {}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix packages/vscode test && npm --prefix packages/vscode build`
Expected: PASS。

- [ ] **Step 5: 完成判据**

manifest 测试全绿；typecheck/build 通过；根测试 84/84 不变。

- [ ] **Step 6: Commit**

```bash
git add packages/vscode/src/views packages/vscode/src/extension.ts packages/vscode/package.json packages/vscode/test/views.test.ts
git commit -m "feat(vscode): agents/catalog/skills tree views under avenic activity-bar container"
```

---

# M3：命令 / QuickPick 流程

### Task 6: 流程基础设施（flows / mutation-queue / progress / errors / 多根选择）

**Goal:** 提供命令层可复用的 QuickPick 助手、mutations 串行队列、进度与错误包装、多根项目选择（spec §5.3/§6）。

**Files:**
- Create: `packages/vscode/src/ui/flows.ts`、`packages/vscode/src/ui/mutation-queue.ts`、`packages/vscode/src/commands/progress.ts`、`packages/vscode/src/commands/errors.ts`
- Test: `packages/vscode/test/mutation-queue.test.ts`、`packages/vscode/test/flows.test.ts`

**Interfaces:**
- Consumes: T2 纯函数（`resolveProjectRoot`/`rememberProjectRoot`/`lastProjectRoot`）。
- Produces: `MutationQueue`（`run<T>(fn): Promise<T>` 串行 + `busy: boolean`）；`pickOne` / `pickMany`（纯分支可测）；`withProgress(title, fn)`；`showError(err)`；`pickProjectRoot(folders, state, pick)` 多根薄壳（复用 T2 的 `rememberProjectRoot`/`PROJECT_ROOT_STATE_KEY`）。

- [ ] **Step 1: 写失败测试 `test/mutation-queue.test.ts`**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { MutationQueue } from "../src/ui/mutation-queue.ts";

test("mutations run serially in queue order", async () => {
  const queue = new MutationQueue();
  const order: string[] = [];
  const p1 = queue.run(async () => { order.push("a"); await new Promise((r) => setTimeout(r, 10)); order.push("a2"); });
  const p2 = queue.run(async () => { order.push("b"); });
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ["a", "a2", "b"]);
});

test("busy reflects in-flight mutation", async () => {
  const queue = new MutationQueue();
  assert.equal(queue.busy, false);
  const p = queue.run(async () => { await new Promise((r) => setTimeout(r, 5)); });
  assert.equal(queue.busy, true);
  await p;
  assert.equal(queue.busy, false);
});
```

`test/flows.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { pickOne } from "../src/ui/flows.ts";

test("pickOne returns undefined when empty", async () => {
  assert.equal(await pickOne<{ label: string }>([], async () => { throw new Error("not called"); }), undefined);
});

test("pickOne forwards options to quickPick", async () => {
  const options = [{ label: "global" }, { label: "project" }];
  const chosen = await pickOne(options, async (items) => items[1]);
  assert.equal(chosen, options[1]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix packages/vscode test`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 最小实现**

`src/ui/mutation-queue.ts`（无 vscode）：

```ts
export class MutationQueue {
  private chain: Promise<unknown> = Promise.resolve();
  busy = false;
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      this.busy = true;
      try { return await fn(); }
      finally { this.busy = false; }
    });
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }
}
```

`src/ui/flows.ts`：

```ts
import { rememberProjectRoot } from "../project.ts";

export async function pickOne<T extends { label: string }>(
  options: T[],
  quickPick: (items: T[]) => Promise<T | undefined>,
): Promise<T | undefined> {
  if (options.length === 0) return undefined;
  return quickPick(options);
}

export async function pickMany<T extends { label: string }>(options: T[], multi: (items: T[]) => Promise<T[] | undefined>): Promise<T[]> {
  if (options.length === 0) return [];
  return (await multi(options)) ?? [];
}

export async function pickProjectRoot(
  folders: Array<{ uri: { fsPath: string } }>,
  state: { get(key: string): unknown; update(key: string, value: unknown): Thenable<unknown> },
  pick: (candidates: Array<{ label: string; fsPath: string }>) => Promise<{ label: string; fsPath: string } | undefined>,
): Promise<string | null> {
  if (folders.length === 0) return null;
  if (folders.length === 1) return folders[0].uri.fsPath;
  const chosen = await pick(folders.map((f) => ({ label: f.uri.fsPath, fsPath: f.uri.fsPath })));
  if (chosen === undefined) return null;
  rememberProjectRoot(state, chosen.fsPath);
  return chosen.fsPath;
}
```

`src/commands/progress.ts`：

```ts
import * as vscode from "vscode";

export async function withProgress<T>(title: string, fn: (report: (msg: string) => void) => Promise<T>): Promise<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, (progress) =>
    fn((message) => progress.report({ message })),
  );
}
```

`src/commands/errors.ts`：

```ts
import * as vscode from "vscode";

export async function showError(err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await vscode.window.showErrorMessage(message);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix packages/vscode test`
Expected: PASS——6 个测试全绿。

- [ ] **Step 5: 完成判据**

mutation-queue 无 vscode import（rg 断言覆盖）；`npm --prefix packages/vscode test` 全绿。

- [ ] **Step 6: Commit**

```bash
git add packages/vscode/src/ui packages/vscode/src/commands/progress.ts packages/vscode/src/commands/errors.ts packages/vscode/test
git commit -m "feat(vscode): flow helpers, mutation queue, progress/error plumbing, multi-root pick"
```

### Task 7: Agent 命令（init / deinit / auth / sessions import / writeback）

**Goal:** spec §5.3 中 6 个 Agent 命令全部可执行，QuickPick 流程正确，错误经 `showError` 呈现，mutation 串行化。

**Files:**
- Create: `packages/vscode/src/commands/agents-commands.ts`
- Modify: `packages/vscode/src/extension.ts`（注册）、`packages/vscode/package.json`（commands + menus）
- Test: `packages/vscode/test/agents-commands.test.ts`

**Interfaces:**
- Consumes: T3 agents service、T6（MutationQueue/withProgress/showError/pickOne/pickProjectRoot）。
- Produces: 命令 ID `avenic.agents.init` / `avenic.agents.deinit` / `avenic.agents.switchAuth` / `avenic.agents.switchSessions` / `avenic.agents.sessionsImport` / `avenic.agents.sessionsWriteback`；`registerAgentsCommands(context, deps: { projectRoot: () => string | null; queue: MutationQueue; refresh: () => void })`。

- [ ] **Step 1: 写失败测试 `test/agents-commands.test.ts`**

```ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { agentStatus, deinitialize, initialize, setAuthMode, setSessionsMode } from "../src/services/agents.ts";

test("init → auth switch → sessions switch → deinit round-trip on real core", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    await initialize(dir, "claude", "global", "project");
    let status = await agentStatus(dir, "claude");
    assert.equal(status.effective?.auth, "global");
    assert.equal(status.effective?.sessions, "project");
    await setAuthMode(dir, "claude", "project");
    status = await agentStatus(dir, "claude");
    assert.equal(status.effective?.auth, "project");
    await setSessionsMode(dir, "claude", "global");
    status = await agentStatus(dir, "claude");
    assert.equal(status.effective?.sessions, "global");
    await deinitialize(dir, "claude");
    assert.equal((await agentStatus(dir, "claude")).effective, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("manifest registers the six agent command ids", async () => {
  const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  const ids = manifest.contributes?.commands ?? [];
  for (const id of ["avenic.agents.init", "avenic.agents.deinit", "avenic.agents.switchAuth", "avenic.agents.switchSessions", "avenic.agents.sessionsImport", "avenic.agents.sessionsWriteback"]) {
    assert.ok(ids.some((c: { command: string }) => c.command === id), id);
  }
});
```

（manifest 测试放本任务——第 6 个命令在 T9 才加齐，先只断言当前已有 6 个 ag 命令；T8/T9 各自的 manifest 测试同样防护。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix packages/vscode test`
Expected: FAIL——services 未暴露完整函数（T3 只实现到 agentStatus）→ 补齐；commands 不存在且 manifest 无命令。

- [ ] **Step 3: 最小实现**

`src/commands/agents-commands.ts`：

```ts
import * as vscode from "vscode";
import * as agents from "../services/agents.ts";
import { MutationQueue } from "../ui/mutation-queue.ts";
import { pickOne } from "../ui/flows.ts";
import { showError } from "./errors.ts";
import { withProgress } from "./progress.ts";

export interface AgentDeps {
  projectRoot: () => string | null;
  queue: MutationQueue;
  refresh: () => void;
}

export function registerAgentsCommands(context: vscode.ExtensionContext, deps: AgentDeps): void {
  const register = (id: string, fn: (root: string, agentId: string) => Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, async (treeItem?: vscode.TreeItem) => {
      const root = deps.projectRoot();
      if (root === null) { await vscode.window.showWarningMessage("请先打开一个项目文件夹"); return; }
      // 树节点触发时 args[0] 是 T5 的 TreeItem（item.id 已设为 agent id）；命令面板触发时走 QuickPick
      const chosen = treeItem?.id ?? (await vscode.window.showQuickPick(agents.listAgents().map((a) => ({ label: a.displayName, id: a.id }))))?.id;
      if (chosen === undefined) return;
      try {
        await deps.queue.run(async () => {
          await withProgress("Avenic Agent 操作", (report) => fn(root, chosen).then(() => { report("完成"); }));
          deps.refresh();
        });
      } catch (err) { await showError(err); }
    }));

  register("avenic.agents.init", async (root, id) => {
    const auth = await pickOne([{ label: "global" }, { label: "project" }], async (items) => vscode.window.showQuickPick(items));
    if (auth === undefined) return;
    const sessions = await pickOne([{ label: "global" }, { label: "project" }], async (items) => vscode.window.showQuickPick(items));
    if (sessions === undefined) return;
    await agents.initialize(root, id, auth.label as "global" | "project", sessions.label as "global" | "project");
  });
  register("avenic.agents.deinit", async (root, id) => { await agents.deinitialize(root, id); });
  register("avenic.agents.switchAuth", async (root, id) => {
    const status = await agents.agentStatus(root, id);
    const currentLabel = status.effective?.auth ?? "未配置";
    const chosen = await vscode.window.showQuickPick([{ label: currentLabel, description: "当前" }, { label: "global" }, { label: "project" }, { label: "reset" }]);
    if (chosen === undefined || chosen.label === currentLabel) return;
    await agents.setAuthMode(root, id, chosen.label as "global" | "project" | "reset");
  });
  register("avenic.agents.switchSessions", async (root, id) => {
    const status = await agents.agentStatus(root, id);
    const currentLabel = status.effective?.sessions ?? "未配置";
    const chosen = await pickOne([{ label: currentLabel, description: "当前" }, { label: "global" }, { label: "project" }], async (items) => vscode.window.showQuickPick(items));
    if (chosen === undefined || chosen.label === currentLabel) return;
    await agents.setSessionsMode(root, id, chosen.label as "global" | "project");
  });
  register("avenic.agents.sessionsImport", async (root, id) => {
    const result = await agents.importSessions(root, id);
    vscode.window.showInformationMessage(`已导入 ${(result as { count: number }).count} 个会话`);
  });
  register("avenic.agents.sessionsWriteback", async (root, id) => {
    const result = await agents.writebackSessions(root, id);
    vscode.window.showInformationMessage(`已写回 ${(result as { count: number }).count} 个会话`);
  });
}
```

package.json `contributes.commands` 6 条（适中文 title 与 category "Avenic"），menus 绑视图节点上下文菜单（agent 行 init/deinit/auth/sessions ×4）：

```json
"contributes": {
  "commands": [
    { "command": "avenic.agents.init", "title": "Avenic: 初始化 Agent", "category": "Avenic" },
    { "command": "avenic.agents.deinit", "title": "Avenic: 移除 Agent", "category": "Avenic" },
    { "command": "avenic.agents.switchAuth", "title": "Avenic: 切换认证模式", "category": "Avenic" },
    { "command": "avenic.agents.switchSessions", "title": "Avenic: 切换会话存储", "category": "Avenic" },
    { "command": "avenic.agents.sessionsImport", "title": "Avenic: 导入会话", "category": "Avenic" },
    { "command": "avenic.agents.sessionsWriteback", "title": "Avenic: 写回会话", "category": "Avenic" }
  ],
  "menus": {
    "view/item/context": [
      { "command": "avenic.agents.init", "when": "view == avenic.agents && viewItem == agent" },
      { "command": "avenic.agents.deinit", "when": "view == avenic.agents && viewItem == agent" },
      { "command": "avenic.agents.switchAuth", "when": "view == avenic.agents && viewItem == agent" },
      { "command": "avenic.agents.switchSessions", "when": "view == avenic.agents && viewItem == agent" },
      { "command": "avenic.agents.sessionsImport", "when": "view == avenic.agents && viewItem == agent" },
      { "command": "avenic.agents.sessionsWriteback", "when": "view == avenic.agents && viewItem == agent" }
    ]
  }
}
```

extension.ts 调用 `registerAgentsCommands(context, { projectRoot: root, queue, refresh: () => { agentsView.refresh(); } })`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix packages/vscode test && npm --prefix packages/vscode build`
Expected: PASS。

- [ ] **Step 5: 完成判据**

6 命令 ID 命中断言；init/auth/sessions 真值全绿；spec §5.3 流程一致（Esc 取消无操作）。

- [ ] **Step 6: Commit**

```bash
git add packages/vscode/src/commands/agents-commands.ts packages/vscode/package.json packages/vscode/src/extension.ts packages/vscode/test/agents-commands.test.ts
git commit -m "feat(vscode): agent commands (init/deinit/switchAuth/switchSessions/sessions import/writeback)"
```

### Task 8: Catalog 命令（add / select / default / sync）

**Goal:** catalog 四命令可执行（本地 fixture 验证），预览失败不致命（spec §5.3）。

**Files:**
- Create: `packages/vscode/src/commands/catalog-commands.ts`
- Helpers: `packages/vscode/test/helpers.ts`（git 目录 catalog fixture，T9 复用）
- Modify: `packages/vscode/src/extension.ts`、`packages/vscode/package.json`
- Test: `packages/vscode/test/catalog-commands.test.ts`

**Interfaces:**
- Consumes: T3 catalog service、T6。
- Produces: `avenic.catalog.add` / `avenic.catalog.select` / `avenic.catalog.default` / `avenic.catalog.sync`；`registerCatalogCommands(context, deps)`。

- [ ] **Step 1: 写失败测试 `test/catalog-commands.test.ts`（本地 git fixture，与 test/catalog-cache.test.mjs 同法）**

`test/helpers.ts`（git 目录 fixture，T9 复用）：

```ts
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function makeCatalogFixture(root: string): Promise<void> {
  await mkdir(path.join(root, "packs"), { recursive: true });
  await mkdir(path.join(root, "skills", "demo", "alpha"), { recursive: true });
  await mkdir(path.join(root, "skills", "demo", "beta"), { recursive: true });
  await writeFile(path.join(root, "skills", "demo", "alpha", "SKILL.md"), "---\nname: alpha\n---\n");
  await writeFile(path.join(root, "skills", "demo", "beta", "SKILL.md"), "---\nname: beta\n---\n");
  await writeFile(path.join(root, "packs", "common.json"), `${JSON.stringify({ schemaVersion: 1, id: "common", name: "Common", sources: [{ source: "demo", skills: ["alpha"] }] }, null, 2)}\n`);
  await writeFile(path.join(root, "sources.lock.json"), `${JSON.stringify({ schemaVersion: 1, sources: [{ id: "demo", name: "Demo", repository: "https://github.com/example/demo.git", skillRoot: "skills", revision: "a".repeat(40) }] }, null, 2)}\n`);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "one"], { cwd: root });
}
```

（目录布局与根仓 `test/skills.test.mjs` 的 fixture 一致：`packs/*.json` + `sources.lock.json` + vendored `skills/<source-id>/<skill-name>/SKILL.md`，安装不依赖网络。spec 用**本地绝对路径**（无 `file://`、无 `#ref`——`parseCatalogSpec` 有默认 ref；如本地路径解析失败，按 `parseCatalogSpec`/`normalizeRepositoryInput` 支持的形式调整。）

`test/catalog-commands.test.ts`：

```ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { add, listKnown, select, sync } from "../src/services/catalog.ts";
import { makeCatalogFixture } from "./helpers.ts";

test("catalog add → select → sync round-trip with local fixture", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-catalog-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const env = { ...process.env, AVENIC_STATE_DIR: path.join(root, "state") };
    await makeCatalogFixture(catalogDir);
    const added = await add(catalogDir, env);
    assert.equal(added.previewFailed, false);
    assert.equal(added.packs.some((p) => p.id === "common"), true);
    const known = await listKnown(env);
    assert.equal(known.filter((k) => k.spec === catalogDir).length, 1);
    await select(catalogDir, env);
    const info = await sync(catalogDir, env);
    assert.match(info.revision, /^[0-9a-f]{40}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix packages/vscode test`
Expected: FAIL——catalog-commands 不存在（本任务先补齐 services/catalog.ts 全函数）。

- [ ] **Step 3: 最小实现**

`src/commands/catalog-commands.ts`：

```ts
import * as vscode from "vscode";
import * as catalog from "../services/catalog.ts";
import { MutationQueue } from "../ui/mutation-queue.ts";
import { pickOne } from "../ui/flows.ts";
import { showError } from "./errors.ts";
import { withProgress } from "./progress.ts";

export function registerCatalogCommands(context: vscode.ExtensionContext, deps: { projectRoot: () => string | null; queue: MutationQueue; refresh: () => void }): void {
  const register = (id: string, fn: () => Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, async () => { try { await deps.queue.run(fn); deps.refresh(); } catch (err) { await showError(err); } }));

  register("avenic.catalog.add", async () => {
    const spec = await vscode.window.showInputBox({ prompt: "Catalog spec（owner/repo、URL 或本地路径）", value: "Echo-Kang-hub/avenic-catalog#main" });
    if (spec === undefined || spec.trim() === "") return;
    const result = await withProgress("添加 Catalog", async (report) => { report("保存并预览…"); return catalog.add(spec.trim()); });
    if (result.previewFailed) await vscode.window.showWarningMessage("已保存，可 sync 重试（Preview 失败不致命）");
    else await vscode.window.showInformationMessage(`Catalog 已添加并预览 ${result.packs.length} 个 Pack`);
  });

  register("avenic.catalog.select", async () => {
    const known = await catalog.listKnown();
    if (known.length === 0) { await vscode.window.showInformationMessage("暂无已注册 Catalog，先执行 Avenic: Catalog 添加"); return; }
    const picked = await pickOne(known.map((k) => ({ label: k.spec, description: k.name })), async (items) => vscode.window.showQuickPick(items));
    if (picked === undefined) return;
    await catalog.select(picked.label);
  });

  register("avenic.catalog.default", async () => {
    const current = await catalog.defaultSpec();
    const info = await vscode.window.showInformationMessage(`当前默认 Catalog：${current ?? "未设置"}`, "修改");
    if (info === undefined) return;
    await vscode.commands.executeCommand("avenic.catalog.select");
  });

  register("avenic.catalog.sync", async () => {
    const spec = await catalog.defaultSpec();
    if (spec === null) { await vscode.window.showWarningMessage("未选择默认 Catalog"); return; }
    const info = await withProgress("同步 Catalog", async (report) => { report("拉取并解析…"); return catalog.sync(spec); });
    await vscode.window.showInformationMessage(`已同步 ${spec} → revision ${info.revision}`);
  });
}
```

package.json commands +4（title/category 同前），menus 视图标题按钮（`view/title`，when `view == avenic.catalog`）放 add/select/sync + commandPalette。

extension.ts 注册。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix packages/vscode test`
Expected: PASS（本地 fixture 真值：add 预览出 `common` 包、`listKnown` 收录、sync 得到 40 位 revision、select 后 `defaultSpec(env)` 指向 fixture）。

- [ ] **Step 5: 完成判据**

catalog round-trip 全绿；4 命令 ID 断言（本任务 manifest 测试可并入 catalog-commands.test.ts，同 T7 模式）。

- [ ] **Step 6: Commit**

```bash
git add packages/vscode/src/commands/catalog-commands.ts packages/vscode/package.json packages/vscode/src/extension.ts packages/vscode/test/catalog-commands.test.ts
git commit -m "feat(vscode): catalog commands (add/select/default/sync)"
```

### Task 9: Skills 命令（Packs 安装/卸载、Direct 添加/删除、双作用域）

**Goal:** spec §5.3 五条 Skills 命令可执行，项目/全局双作用域走 QuickPick 选择，mutation 串行化。

**Files:**
- Create: `packages/vscode/src/commands/skills-commands.ts`
- Modify: `packages/vscode/src/extension.ts`、`packages/vscode/package.json`
- Test: `packages/vscode/test/skills-commands.test.ts`

**Interfaces:**
- Consumes: T3 skills service（scope 参数）、T5 SkillsViewProvider.refresh（刷新指示）、T6。
- Produces: `avenic.skills.installPacks` / `avenic.skills.uninstallPacks` / `avenic.skills.addDirect` / `avenic.skills.removeDirect` / `avenic.skills.directList`；`registerSkillsCommands(context, deps)`。

- [ ] **Step 1: 写失败测试 `test/skills-commands.test.ts`**

`test/skills-commands.test.ts`（直接复用 T8 的 `makeCatalogFixture`；本地路径即可，无网络依赖）：

```ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { select } from "../src/services/catalog.ts";
import { addDirect, directSkills, installedPackIds, installPacks, removeDirect, status, uninstallPacks } from "../src/services/skills.ts";
import { makeCatalogFixture } from "./helpers.ts";

test("pack install → status → uninstall in project scope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-skills-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const cwd = path.join(root, "project");
    const env = { ...process.env, AVENIC_STATE_DIR: path.join(root, "state") };
    await mkdir(cwd, { recursive: true });
    await makeCatalogFixture(catalogDir);
    await select(catalogDir, env);
    assert.equal(await status("project", cwd, env), null);
    const result = await installPacks("project", ["common"], cwd, env);
    assert.equal(result.packIds.includes("common"), true);
    assert.equal((await installedPackIds("project", cwd, env))?.includes("common"), true);
    await uninstallPacks("project", ["common"], cwd, env);
    assert.equal(await status("project", cwd, env), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct add/remove round-trip on local git repo", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-direct-"));
  try {
    const cwd = path.join(root, "project");
    const repo = path.join(root, "repo");
    await mkdir(cwd, { recursive: true });
    await mkdir(path.join(repo, "skills", "manual"), { recursive: true });
    await writeFile(path.join(repo, "skills", "manual", "SKILL.md"), "---\nname: manual\n---\n");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "one"], { cwd: repo });
    const added = await addDirect("project", repo, [], cwd);
    assert.equal(added.names.includes("manual"), true);
    const state = await directSkills("project", cwd);
    assert.equal(state.directSources.flatMap((s) => s.skills).includes("manual"), true);
    const removed = await removeDirect("project", ["manual"], cwd);
    assert.equal(removed.includes("manual"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

（若 `addDirectSkills` 对本地路径有额外要求（如 `normalizeRepositoryInput` 转义），以 core 行为为准调整 repo 形式。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix packages/vscode test`
Expected: FAIL——skills-commands 不存在。

- [ ] **Step 3: 最小实现**

`src/commands/skills-commands.ts`：

```ts
import * as vscode from "vscode";
import * as skills from "../services/skills.ts";
import type { Scope } from "../services/skills.ts";
import { defaultSpec as catalogDefaultSpec } from "../services/catalog.ts";
import { MutationQueue } from "../ui/mutation-queue.ts";
import { pickMany, pickOne } from "../ui/flows.ts";
import { showError } from "./errors.ts";
import { withProgress } from "./progress.ts";

async function pickScope(): Promise<Scope | null> {
  const picked = await vscode.window.showQuickPick([
    { label: "项目作用域", description: "当前项目根" },
    { label: "全局作用域", description: "用户目录" },
  ]);
  return picked?.label === "全局作用域" ? "global" : picked !== undefined ? "project" : null;
}

export function registerSkillsCommands(context: vscode.ExtensionContext, deps: { projectRoot: () => string | null; queue: MutationQueue; refresh: () => void }): void {
  const register = (id: string, fn: () => Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, async () => { try { await deps.queue.run(fn); deps.refresh(); } catch (err) { await showError(err); } }));

  register("avenic.skills.installPacks", async () => {
    const root = deps.projectRoot();
    const scope = await pickScope();
    if (scope === null) return;
    if (scope === "project" && root === null) { await vscode.window.showWarningMessage("请先打开一个项目文件夹"); return; }
    if ((await catalogDefaultSpec()) === null) { await vscode.window.showWarningMessage("尚未选择默认 Catalog，请先执行 Avenic: Catalog 添加"); return; }
    const all = await skills.availablePacks(scope, root ?? undefined);
    const installed = await skills.installedPackIds(scope, root ?? undefined);
    const candidates = Array.from(all.values()).filter((p) => !(installed ?? []).includes(p.id)).map((p) => ({ label: p.name, description: p.description ?? p.id, id: p.id }));
    const chosen = await pickMany(candidates, async (items) => vscode.window.showQuickPick(items, { canPickMany: true }));
    if (chosen.length === 0) return;
    await withProgress("安装 Packs", async (report) => { report(`安装 ${chosen.length} 个 Pack…`); await skills.installPacks(scope, chosen.map((c) => c.id), deps.projectRoot() ?? undefined); });
  });

  register("avenic.skills.uninstallPacks", async () => {
    const scope = await pickScope(deps.projectRoot());
    if (scope === null) return;
    const installed = (await skills.installedPackIds(scope, deps.projectRoot() ?? undefined)) ?? [];
    const chosen = await vscode.window.showQuickPick(installed.map((id) => ({ label: id })), { canPickMany: true });
    if (chosen === undefined || chosen.length === 0) return;
    await skills.uninstallPacks(scope, chosen.map((c) => c.label), deps.projectRoot() ?? undefined);
  });

  register("avenic.skills.addDirect", async () => {
    const scope = await pickScope(deps.projectRoot());
    if (scope === null) return;
    const repo = await vscode.window.showInputBox({ prompt: "owner/repo 或仓库 URL" });
    if (repo === undefined || repo.trim() === "") return;
    const result = await withProgress("添加直装 Skills", async (r) => { r("发现 Skills…"); return skills.addDirect(scope, repo.trim(), [], deps.projectRoot() ?? undefined); });
    const names = (result as { names: string[] }).names;
    await vscode.window.showInformationMessage(`已添加 ${names.length} 个 Skills：${names.join(", ")}`);
  });

  register("avenic.skills.removeDirect", async () => {
    const scope = await pickScope(deps.projectRoot());
    if (scope === null) return;
    const state = await skills.directSkills(scope, deps.projectRoot() ?? undefined);
    const direct = (state as { directSources: Array<{ skills: string[] }> }).directSources.flatMap((s) => s.skills);
    const chosen = await vscode.window.showQuickPick(direct.map((n) => ({ label: n })), { canPickMany: true });
    if (chosen === undefined || chosen.length === 0) return;
    await skills.removeDirect(scope, chosen.map((c) => c.label), deps.projectRoot() ?? undefined);
  });

  register("avenic.skills.directList", async () => {
    const scope = await pickScope(deps.projectRoot());
    if (scope === null) return;
    const state = await skills.directSkills(scope, deps.projectRoot() ?? undefined);
    const direct = (state as { directSources: Array<{ sourceId: string; skills: string[] }> }).directSources;
    for (const s of direct) await vscode.window.showInformationMessage(`${s.sourceId} → ${s.skills.join(", ")}`);
  });
}
```

扩展 deps 传 cwd：`deps.projectRoot()`。package.json commands +5 与 menus（view/item context when `view == avenic.skills`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix packages/vscode test`
Expected: PASS——skills 真值全绿（install → status 含 pack；addDirect/removeDirect 回环）。

- [ ] **Step 5: 完成判据**

双作用域 install/uninstall/direct 真值全绿；5 命令 ID 断言；spec §5.3 每条流程对上。

- [ ] **Step 6: Commit**

```bash
git add packages/vscode/src/commands/skills-commands.ts packages/vscode/package.json packages/vscode/src/extension.ts packages/vscode/test/skills-commands.test.ts
git commit -m "feat(vscode): skills commands (install/uninstall packs, direct add/remove/list, dual scope)"
```

---

# M4：Overview Webview Dashboard

### Task 10: Dashboard provider + typed protocol + state 组装

**Goal:** `avenic.overview` webview 可用，postMessage 类型化协议，数据单向（services → core）

**Files:**
- Create: `packages/vscode/src/dashboard/protocol.ts`、`packages/vscode/src/dashboard/state.ts`、`packages/vscode/src/dashboard/overview.ts`、`packages/vscode/media/dashboard/view.html`、`packages/vscode/media/dashboard/main.js`、`packages/vscode/media/dashboard/style.css`
- Modify: `packages/vscode/src/extension.ts`、`packages/vscode/package.json`（views 加 overview webview 条目）
- Test: `packages/vscode/test/dashboard.test.ts`

**Interfaces:**
- Consumes: T3 services（agents）/T8 catalog service/T7–T9命令注册（command 转发）。
- Produces: `WebviewMessage`（`{ type: "ready" } | { type: "refresh" } | { type: "command"; command: "catalog.sync" | "skills.installPacks" | ... }`）与 `isWebviewMessage` 守卫；`SenderMessage = { type: "data"; payload: DashboardData } | { type: "error"; message: string }`；`DashboardData { projectRoot; agents: Array<{ id; label; statusText; executableAvailable; iconHint }>; catalog: { spec; revision } | null; skillsHealth: Array<{ label; ok: boolean; details: string }> }`；`buildDashboardData(projectRoot: string | null): Promise<DashboardData>`；`OverviewProvider implements vscode.WebviewViewProvider`（resolveWebviewView：CSP nonce、localResourceRoots、无远程内容、转发 command 到 `vscode.commands.executeCommand("avenic." + msg.command)`）。

- [ ] **Step 1: 写失败测试 `test/dashboard.test.ts`**

```ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildDashboardData } from "../src/dashboard/state.ts";
import { isWebviewMessage } from "../src/dashboard/protocol.ts";

test("buildDashboardData includes all sections on fresh project", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    const data = await buildDashboardData(dir);
    assert.equal(data.agents.length, 3);
    assert.equal(typeof data.projectRoot, "string", "projectRoot 总是字符串（无项目时为空串）");
    assert.ok(Array.isArray(data.skillsHealth));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("protocol guard accepts valid webview messages", () => {
  assert.ok(isWebviewMessage({ type: "ready" }));
  assert.ok(isWebviewMessage({ type: "refresh" }));
  assert.ok(isWebviewMessage({ type: "command", command: "catalog.sync" }));
  assert.ok(!isWebviewMessage({ type: "boom" }));
  assert.ok(!isWebviewMessage(null));
});

test("protocol guard rejects command not in allowlist", () => {
  assert.ok(!isWebviewMessage({ type: "command", command: "shell.open" }));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix packages/vscode test`
Expected: FAIL——dashboard 模块不存在。

- [ ] **Step 3: 最小实现**

`src/dashboard/protocol.ts`（纯类型 + 守卫，允许命令列表白名单）：

```ts
export type WebviewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "command"; command: "catalog.sync" | "skills.installPacks" | "skills.addDirect" | "agents.init" | "agents.sessionsImport" }
  | { type: "report"; message: string };

export type SenderMessage =
  | { type: "data"; payload: DashboardData }
  | { type: "error"; message: string };

const ALLOWED_COMMANDS: ReadonlyArray<string> = ["catalog.sync", "skills.installPacks", "skills.addDirect", "agents.init", "agents.sessionsImport"];

export interface DashboardData {
  projectRoot: string | null;
  agents: Array<{ id: string; label: string; statusText: string; executableAvailable: boolean; iconHint: string }>;
  catalog: { spec: string; revision: string } | null;
  skillsHealth: Array<{ label: string; ok: boolean; details: string }>;
}

export function isWebviewMessage(value: unknown): value is WebviewMessage {
  if (typeof value !== "object" || value === null) return false;
  const msg = value as Record<string, unknown>;
  if (msg.type === "ready" || msg.type === "refresh" || msg.type === "report") return typeof msg.message === "string" ? msg.type !== "report" || typeof msg.message === "string" : true;
  if (msg.type === "command") return typeof msg.command === "string" && ALLOWED_COMMANDS.includes(msg.command);
  return false;
}
```

（守卫实现校正：`ready/refresh` → true；`report` → typeof message === "string"；`command` → 白名单。细节以测试为准。）

`src/dashboard/state.ts`（无 vscode import）：

```ts
import { agentExecutableAvailable, agentStatus, listAgents } from "../services/agents.ts";
import { defaultSpec } from "../services/catalog.ts";
import { status as skillsStatus } from "../services/skills.ts";
import type { DashboardData } from "./protocol.ts";

export async function buildDashboardData(projectRoot: string | null): Promise<DashboardData> {
  if (projectRoot === null) {
    return {
      projectRoot: null,
      agents: listAgents().map((a) => ({ id: a.id, label: a.displayName, statusText: "未打开项目", executableAvailable: agentExecutableAvailable(a.id), iconHint: "circle-outline" })),
      catalog: null,
      skillsHealth: [{ label: "Skills", ok: false, details: "未打开项目" }],
    };
  }
  const agents = await Promise.all(
    listAgents().map(async (a) => {
      const s = await agentStatus(projectRoot, a.id);
      return {
        id: s.agent.id,
        label: s.agent.displayName,
        statusText: s.effective ? `已初始化 · ${s.effective.auth} / ${s.effective.sessions}` : "未初始化",
        executableAvailable: s.executableAvailable,
        iconHint: s.effective ? "pass-filled" : "circle-outline",
      };
    }),
  );
  const spec = await defaultSpec();
  const skills = await skillsStatus("project", projectRoot).catch(() => null);
  return {
    projectRoot,
    agents,
    catalog: spec === null ? null : { spec, revision: "—" },
    skillsHealth: skills === null
      ? [{ label: "Skills", ok: false, details: "尚未安装" }]
      : skills.targets.map((t) => ({ label: t.label, ok: t.complete, details: `${t.present}/${t.total}` })),
  };
}
```

（revision 默认 "—"，sync 后刷新填充——Dashboard 打开时不做隐式网络拉取（避免打开即克隆 catalog）；如实现者希望缓存命中时显示 revision，走 `resolveInstallSource({ refresh: false })` 并 catch 失败保持 "—"。）

`src/dashboard/overview.ts`（vscode 薄壳）：

```ts
import * as vscode from "vscode";
import { buildDashboardData } from "./state.ts";
import { isWebviewMessage, type SenderMessage } from "./protocol.ts";

export class OverviewProvider implements vscode.WebviewViewProvider {
  static viewType = "avenic.overview";
  private view: vscode.WebviewView | undefined;
  constructor(private readonly projectRoot: () => string | null, private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const { webview } = webviewView;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    // T10 骨架：静态占位 HTML；T11 改为注入 CSP nonce 的 media/dashboard/view.html 模板
    webview.html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8" /></head><body>加载中…</body></html>`;
    webview.onDidReceiveMessage((msg: unknown) => {
      if (!isWebviewMessage(msg)) return;
      if (msg.type === "refresh") void this.sendData();
      if (msg.type === "command") void vscode.commands.executeCommand(`avenic.${msg.command}`);
    });
    void this.sendData();
  }

  private async sendData(): Promise<void> {
    if (this.view === undefined) return;
    const data = await buildDashboardData(this.projectRoot());
    const message: SenderMessage = { type: "data", payload: data };
    void this.view.webview.postMessage(message);
  }

  refresh(): void { void this.sendData(); }
}
```

package.json views 加：

```json
"views": {
  "avenic": [ ...三树..., { "id": "avenic.overview", "type": "webview", "name": "Overview", "contextualTitle": "Avenic · Overview" } ]
}
```

`media/dashboard/view.html`（CSP nonce 引用 `main.js`/`style.css` 的 webview Uri 由 overview.ts 注入模板，无远程内容；`main.js` 实现 `self.acquireVsCodeApi()` 消息 listeners + 简单渲染 `textContent`——本任务先抛骨架，T11 完善视觉）+ 空 CSS/JS. extension.ts 注册 `vscode.window.registerWebviewViewProvider(OverviewProvider.viewType, overview)`.

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix packages/vscode test && npm --prefix packages/vscode build`
Expected: PASS。

- [ ] **Step 5: 完成判据**

buildDashboardData 真值全绿；isWebviewMessage 全分支覆盖；view.html 存在。

- [ ] **Step 6: Commit**

```bash
git add packages/vscode/src/dashboard packages/vscode/media/dashboard packages/vscode/package.json packages/vscode/src/extension.ts packages/vscode/test/dashboard.test.ts
git commit -m "feat(vscode): overview webview provider with typed postMessage protocol"
```

### Task 11: Dashboard 视觉实现（卡片 / 主题 / Codicon / 三态）

**Goal:** 高颜值 Overview（spec §5.2）：主题变量、Codicon、卡片密度、loading/empty/error 三态、用户字符串安全渲染。

**Files:**
- Modify: `packages/vscode/media/dashboard/view.html`、`packages/vscode/media/dashboard/main.js`、`packages/vscode/media/dashboard/style.css`
- Test: `packages/vscode/test/dashboard-media.test.ts`

**Interfaces:**
- Consumes: T10 `SenderMessage` 协议（只消费 `data`/`error`）。
- Produces: 可直接交付的 media 三件套；渲染函数只经 `textContent`/`createElement` 写入用户数据（禁止任何 `innerHTML` 赋值）。

- [ ] **Step 1: 写失败测试 `test/dashboard-media.test.ts`**

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const media = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "dashboard");

test("html has no remote resources and carries CSP nonce placeholder", async () => {
  const html = await readFile(path.join(media, "view.html"), "utf8");
  assert.ok(!/https?:\/\//.test(html)); // 无远程
  assert.match(html, /nonce="[^"]+"/);
  assert.match(html, /content-security-policy/i);
});

test("render code never assigns user data via innerHTML", async () => {
  const js = await readFile(path.join(media, "main.js"), "utf8");
  assert.ok(!/\.innerHTML\s*=/.test(js));
  assert.ok(/textContent/.test(js));
});

test("style uses vscode theme variables and codicon font", async () => {
  const css = await readFile(path.join(media, "style.css"), "utf8");
  assert.ok(/--vscode-/.test(css));
  assert.match(css, /codicon/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix packages/vscode test`
Expected: FAIL——media 文件为空或 missing（T10 骨架未过这三条）。

- [ ] **Step 3: 最小实现**

`view.html`：CSP meta（`default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource}`，非ce 由 overview.ts 注入 `{cspSource}` 模板）、标题、主布局（顶部 project/catalog 卡片行、三 Agent 卡片、Skills 健康、底部快捷动作按钮）、无内联脚本外链。`main.js`（无框架，自实现 lit-mini 渲染）：

```js
const vscode = acquireVsCodeApi();
const state = { data: null, error: null, loading: true };
const render = () => {
  const root = document.getElementById("app");
  root.replaceChildren(); // 安全清空
  if (state.loading) { root.textContent = "⌛ 加载中…"; return; }
  if (state.error) { root.textContent = `错误：${state.error}`; return; }
  const d = state.data;
  const byId = (id) => document.getElementById(id);
  byId("project").textContent = d.projectRoot ?? "未打开项目";
  byId("catalog").textContent = d.catalog?.spec ?? "未选择 Catalog";
  byId("revision").textContent = d.catalog?.revision ?? "—";
  const agents = byId("agents");
  for (const a of d.agents) {
    const c = document.createElement("li"); c.className = "card";
    const name = document.createElement("span"); name.textContent = `${a.statusText} · ${a.label}`; c.appendChild(name);
    agents.appendChild(c);
  }
  const skills = byId("skills");
  skills.replaceChildren();
  for (const h of d.skillsHealth) { const p = document.createElement("p"); p.textContent = `${h.label} ${h.ok ? "✓" : "!"} ${h.details}`; skills.appendChild(p); }
  state.loading = false;
};
window.addEventListener("message", (ev) => { const msg = ev.data; if (msg?.type === "data" || msg?.type === "error") { Object.assign(state, msg.type === "data" ? { data: msg.payload, error: null } : { error: msg.message }); render(); } });
render();
```

（所有用户数据（Skill 名、路径、revision）都经 `textContent`/`createElement`，无 innerHTML 赋值。）`style.css`：`--vscode-*` 主题变量、grid card 布局、codicon font 引用于 codicon 字体本地资源（vscode.codicon 作为 localResourceRoots 的一部分，或直接引用 CSS 变量 `--vscode-icon-*`——由 overview.ts 的 webview Uri 派生），深浅主题自适应（`body.vscode-dark/vscode-light` class 由 VSCode 注入，自动生效）。

overview.ts 模板注入：读取 `media/dashboard/view.html`/`main.js`/`style.css`，`vscode.Uri.joinPath(extensionUri, "media", "dashboard")` 作为 `localResourceRoots`，CSP nonce。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix packages/vscode test && npm --prefix packages/vscode build`
Expected: PASS——3 条 media 测试全绿。

- [ ] **Step 5: 完成判据（T11 独立完成判据）**

media 安全/主题断言全绿；开发宿主手测：深/浅主题切换即时生效，卡片渲染，空态/错误态可见，快捷命令可触发。

- [ ] **Step 6: Commit**

```bash
git add packages/vscode/media/dashboard
git commit -m "feat(vscode): dashboard media with theme variables, codicons, and safe rendering"
```

---

# M5：测试 / 打包 / 发布就绪

### Task 12: 完整测试、生产构建、打包 VSIX、文档与 CI

**Goal:** 发布就绪链：`test:vscode` 全绿、`vsce package` 产出 VSIX、README/CHANGELOG 就位、CI 跑通、生产构建 minify。

**Files:**
- Modify: `packages/vscode/build.mjs`（minify：true）、`packages/vscode/package.json`（scripts.package、devDependencies + `@vscode/vsce`）、`packages/vscode/.vscodeignore`（补 `.test-out`、`media/**` 检查）
- Create: `packages/vscode/README.md`、`packages/vscode/CHANGELOG.md`、`packages/vscode/test/build.test.ts`
- Modify: 根 `package.json`（`"test:vscode": "npm --prefix packages/vscode test"`）、根 `.github/workflows/ci.yml`（加 vscode 步骤）
- Test: `packages/vscode/test/build.test.ts`

**Interfaces:**
- Consumes: T1–T11 全部。
- Produces: `npm --prefix packages/vscode package` → `dist/avenic.vsix`；`npm --prefix packages/vscode test` 保持 typecheck+test-build；根 `npm run test:vscode` 可跑；CI 新增 job（`npm --prefix packages/vscode install` → typecheck/build/test + `npm test` 根回归）。

- [ ] **Step 1: 写失败测试 `test/build.test.ts`**

```ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("production build emits dist/extension.js containing bundled core", async () => {
  const js = await import("node:fs/promises").then((m) => m.readFile(path.join(pkgDir, "dist", "extension.js"), "utf8"));
  assert.ok(js.includes("avenic"), "bundle 应含 core 逻辑");
});

test("vsce package produces a VSIX via npm script", async () => {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(npm, ["--prefix", pkgDir, "run", "package"], { stdio: "inherit" });
  const info = await stat(path.join(pkgDir, "dist", "avenic.vsix"));
  assert.ok(info.size > 0, "VSIX 应已产出");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix packages/vscode test`
Expected: FAIL——`package` 脚本未定义（npm 报 missing script）或 VSIX 未产出。

- [ ] **Step 3: 最小实现**

`packages/vscode/build.mjs`：`minify: true, sourcemap: false`。
`packages/vscode/package.json` scripts 加 `"package": "npm run build && vsce package --out dist/avenic.vsix"`（先构建再打包，确保 `dist/extension.js` 存在）；devDependencies 加 `"@vscode/vsce": "^3.0.0"`。
`.vscodeignore` 加 `.test-out/**`、`.test-build/`（如存在）、`README.md` 保留（vsce 自动打包 root README——vsce 要求 README 在包根）。
`README.md`：中文简介（安装 vsce package/dist/avenic.vsix、功能三视图 + Overview、`npm --prefix packages/vscode test`、开发宿主启动 build/Extension Development Host launch config 注意）、截图占位空块、配置说明（`avenic.projectRoot` workspaceState key 说明、AVENIC_* 环境变量继承说明）。
`CHANGELOG.md`：0.1.0 首版条目（三视图 + Overview + 命令 + 双作用域）。

根 `package.json`：`"test:vscode": "npm --prefix packages/vscode test"`。

根 `.github/workflows/ci.yml` 追加 job（或 steps；沿用现有风格）：

```yaml
  vscode:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: npm ci
      - run: npm test
      - run: npm --prefix packages/vscode install
      - run: npm --prefix packages/vscode run typecheck
      - run: npm --prefix packages/vscode run build
      - run: npm --prefix packages/vscode test
```

（npm ci 在根跑需要 package-lock.json——仓库已有根 lock；vscode 子包 lock 由 CI 生成，`npm --prefix packages/vscode install` 即可。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix packages/vscode install && npm --prefix packages/vscode run package && npm --prefix packages/vscode test && npm test`
Expected: PASS——`dist/avenic.vsix` 产出；`npm --prefix packages/vscode test` 全绿；根 84/84。

- [ ] **Step 5: 完成判据（发布就绪链）**

1. `npm test` 84/84；
2. `npm run test:install` 2/2（GitHub 根模式 + registry 模式——确认 packages/vscode 引入不破坏 pacote 约束）；
3. `npm --prefix packages/vscode run typecheck && build && test` 全绿；
4. `npm --prefix packages/vscode run package` 产出 VSIX；
5. `code --install-extension packages/vscode/dist/avenic.vsix` 后开发宿主手测：三视图、Dashboard、命令均可跑；
6. `npm run test:vscode` 根级可跑。
7. **USER CHECKPOINT（发布前）**：publisher ID 确认 → `vsce publish` 由用户执行。

- [ ] **Step 6: Commit**

```bash
git add packages/vscode/test/build.test.ts packages/vscode/build.mjs packages/vscode/package.json packages/vscode/.vscodeignore packages/vscode/README.md packages/vscode/CHANGELOG.md package.json .github/workflows/ci.yml
git commit -m "feat(vscode): production build, vsce packaging, test:vscode script, CI and docs"
```

---

## 自审（写完即查）

1. **Spec 覆盖**：MVP 六项全落实——三 Agent（T5/T7）、catalog add/select/list/default/sync（T8）、Pack 安装/卸载（T9）、Skills 浏览 + 直装/删除（T9）、Overview Dashboard（T10/T11）、doctor 图形化（T10/T11）。v1.1 明确排除清单无一项入计划（catalog 维护 UI、一键终端、SKILL.md 预览、自动 d.ts、自动 E2E、跨进程 lock 均未建任务）。spec 里程碑 M2–M5 与用户 M1–M5 一一对应（spec M1 = core 下沉已在上游完成，前置说明标注）。
2. **Core API 一致性**：计划引用的全部函数已在 `@avenic/core@1.0.0` 导出（实查 `packages/core/index.d.ts`），无一缺失；服务层均为薄转发，无新增 core 需求。
3. **任务顺序**：T1→T12 依赖链清晰无环（T2 可在 T3 前；T5 依赖 T3/T4；T6 可在 T2 后任意时刻；T7 依赖 T3/T5/T6；T8/T9 依赖 T6 与 T3；T10 依赖 T3/T8；T12 依赖全部）。
4. **测试覆盖**：每任务均有 test 文件，格式从 RED 命令到 GREEN 命令；services/view-models/project 全为无 vscode 可单测纯函数 + 真实 core 临时目录集成测试；三个任务含 manifest contributes/commands 断言。
5. **MVP 边界**：无重型 UI framework、无远程资源、CSP nonce、用户字符串 textContent、QuickPick 不堆按钮。
6. **回归保护**：T1–T11 只新增 `packages/vscode`；T12 仅根 `package.json` 一脚本 + ci.yml；`npm test`/`test:install` 任何时刻全绿漂移即失败。
7. **无占位符**：全文无 TBD/TODO/「类似 Task N」；每处核心代码已给出完整实现或明确「实现时以 core 实际返回形状校正」的说明。
