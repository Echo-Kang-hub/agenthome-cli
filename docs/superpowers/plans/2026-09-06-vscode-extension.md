# AgentHome VS Code 扩展实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 agenthome-cli monorepo 新增 `packages/vscode` VS Code 扩展，通过公开发布的 `@agenthome/core` 复用全部业务逻辑，图形化管理 Agent 运行时与 Skills。

**Architecture:** core = 唯一业务逻辑层（下沉 CLI 编排语义后公开发布）；CLI 与扩展是两个平行客户端。扩展为 TypeScript，esbuild 打包 core 进 `dist/extension.js`，vsce 打包/发布 VSIX。UI = 三个极简 TreeView + Webview Overview Dashboard + QuickPick 流程。

**Tech Stack:** Node ≥18.17、TypeScript 5.x、esbuild、@vscode/vsce、@types/vscode ^1.90、node:test（与仓库一致）、VS Code 1.90+。

**Spec:** `docs/superpowers/specs/2026-09-06-vscode-extension-design.md`（本计划按该 spec 展开；执行者须先读 spec 再动工）。

## Global Constraints

- 根 package.json **禁止添加 `workspaces` 字段**（会触发 pacote 嵌套 install，破坏 `npm install -g <owner/repo>`；test/packaging.test.mjs 有断言把关）。
- core 是唯一业务逻辑层；扩展不 spawn agenthome CLI、不解析 CLI 文本；CLI 继续 sync-core/vendor。
- 现有 68 个测试（`npm test`）与 `npm run test:install` 每一步后必须全绿。
- packages/vscode 的 services 层**不 import vscode**，UI 层不直接读写 AgentHome 状态文件，所有业务状态重新从 core 获取。
- packages/vscode 为独立 npm 包（无 workspaces）；`engines.vscode: ^1.90.0`；构建产物为 ESM `dist/extension.js`。
- 不实现 v1.1 功能（catalog 维护 UI、终端启动 agent、SKILL.md 预览、自动 d.ts、自动 E2E、跨进程 lock）。
- 用户执行发布（npm publish / vsce publish）；本计划只到"打包就绪 + 发布命令就绪"。
- UI 文案中文（与 CLI 一致）。
- 仓库根：`D:\FileDownload\Projects\agenthome-cli`，Windows + Git Bash。

## 文件结构（锁定）

```
packages/core/
├── package.json                  [改] 发布化（T1）
├── index.d.ts                    [新] 类型契约（T9）
├── LICENSE                       [新] 从根复制（T1）
└── src/
    ├── index.mjs                 [改] 导出新增函数（T2–T8）
    ├── runtime/agents.mjs        [改] + agentExecutableAvailable（T2）
    ├── skills/install.mjs        [改] + skillsInstallationStatus/resolveInstallSource/installPacks/uninstallPacks（T3/T5/T6/T7）
    ├── skills/catalog.mjs        [改] + registerCatalog（T4）
    └── skills/direct.mjs         [改] + removeExternalSkills（T8）

packages/cli/src/cli/
├── dispatcher.mjs                [改] executableAvailable 改用 core（T2）
└── skills-cli.mjs                [改] commandStatus/commandCatalogAdd/commandInstall/commandUninstall/commandUninstallSkill 改用 core（T3–T8）

packages/vscode/                  [新包]
├── package.json                  [新] T10（T19 加 overview view，T20 加 category）
├── tsconfig.json / tsconfig.test.json / build.mjs   [新] T10
├── .vscodeignore                 [新] T10（T21 校验）
├── .vscode/launch.json / .vscode/tasks.json         [新] T10
├── media/icon.svg                [新] T10
├── media/main.js / media/style.css                  [新] T19（包根 media/，与运行时路径一致）
├── README.md / CHANGELOG.md      [新] T20
├── src/
│   ├── extension.ts              [新] activate 装配（T10，随 M3/M4 增补）
│   ├── project.ts                [新] T11（T16 加 pickProjectRoot）
│   ├── mutation-queue.ts         [新] T15
│   ├── services/agents.ts        [新] T12
│   ├── services/skills.ts        [新] T13（T18 加 packCandidates/uninstallCandidates）
│   ├── services/catalog.ts       [新] T13
│   ├── views/view-models.ts      [新] T14（纯数据，无 vscode）
│   ├── views/agents-view.ts / catalog-view.ts / skills-view.ts   [新] T10 骨架，T14 实装
│   ├── ui/adapter.ts / ui/flows.ts                 [新] T15
│   ├── ui/messages.ts            [新] T17
│   ├── commands/progress.ts      [新] T16
│   ├── commands/agents-commands.ts   [新] T16
│   ├── commands/catalog-commands.ts  [新] T17
│   ├── commands/skills-commands.ts   [新] T18
│   └── dashboard/protocol.ts / state.ts / html.ts / overview.ts  [新] T19
└── test/                         [新] T11–T19 各任务

test/                             [改] 根测试：runtime/skills/skills-direct-add/catalog-cache/packaging（T1–T9）
docs/development.md               [改] T9（简版）、T21（完整版）
.github/workflows/ci.yml          [改] T22
```

---

# M1：core 下沉与发布化

> 顺序执行 T1→T9。每个任务结束跑 `npm test`（必须全绿）。T1–T8 均不得动 packages/vscode。

### Task 1: core 发布配置 + LICENSE

**Files:** Modify `packages/core/package.json`；Create `packages/core/LICENSE`；Test: Modify `test/packaging.test.mjs`

**Interfaces:** Produces: npm 包 `@agenthome/core@5.8.0`（M2 起扩展依赖它）。

- [ ] **Step 1: 写失败测试（packaging.test.mjs 追加）**

```js
test("core manifest is configured for public publishing", async () => {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "packages", "core", "package.json"), "utf8"));
  assert.equal(manifest.name, "@agenthome/core");
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.version, "5.8.0");
  assert.deepEqual(manifest.files, ["src/", "index.d.ts", "LICENSE"]);
  assert.equal(manifest.exports["."].types, "./index.d.ts");
  assert.equal(manifest.exports["."].import, "./src/index.mjs");
  assert.equal(manifest.types, "./index.d.ts");
  assert.deepEqual(manifest.engines, { node: ">=18.17" });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL——断言失败（version/files/exports 与现状不符）。

- [ ] **Step 3: 最小实现**

`packages/core/package.json` 改为：

```json
{
  "name": "@agenthome/core",
  "version": "5.8.0",
  "license": "MIT",
  "type": "module",
  "main": "src/index.mjs",
  "types": "./index.d.ts",
  "exports": {
    ".": {
      "types": "./index.d.ts",
      "import": "./src/index.mjs",
      "default": "./src/index.mjs"
    }
  },
  "files": ["src/", "index.d.ts", "LICENSE"],
  "engines": { "node": ">=18.17" }
}
```

复制 LICENSE：`cp LICENSE packages/core/LICENSE`（根目录已有 MIT LICENSE）。
注意：`index.d.ts` 尚不存在（T9 创建）——files 列表先声明无妨，T9 前 npm pack 会警告缺失，T9 后消失。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS（全部旧测试 + 新测试）。

- [ ] **Step 5: Commit**

```bash
git add packages/core/package.json packages/core/LICENSE test/packaging.test.mjs
git commit -m "chore(core): publish config — public package, exports/types, LICENSE"
```

### Task 2: core 新增 `agentExecutableAvailable`，dispatcher 改用

**Files:** Modify `packages/core/src/runtime/agents.mjs`、`packages/core/src/index.mjs`、`packages/cli/src/cli/dispatcher.mjs`；Test: Modify `test/runtime.test.mjs`

**Interfaces:** Produces: `agentExecutableAvailable(agentId: string, environment?: NodeJS.ProcessEnv): boolean`（同步，探测 `--version` 退出码为 0）。CLI 的 `executableAvailable(executable)` 删除。

- [ ] **Step 1: 写失败测试（runtime.test.mjs 追加）**

```js
test("agentExecutableAvailable probes the official CLI on PATH", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-cli-"));
  try {
    const fake = path.join(dir, process.platform === "win32" ? "claude.cmd" : "claude");
    const content = process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n";
    await writeFile(fake, content);
    if (process.platform !== "win32") await chmod(fake, 0o755);
    assert.equal(agentExecutableAvailable("claude", { ...process.env, PATH: dir }), true);
    assert.equal(agentExecutableAvailable("claude", { ...process.env, PATH: "" }), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

（文件顶部 import 追加：`agentExecutableAvailable` 加入现有 `../packages/core/src/index.mjs` 的 import 列表；`chmod` 加入 `node:fs/promises` import。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL——`agentExecutableAvailable` 未导出。

- [ ] **Step 3: 最小实现**

`packages/core/src/runtime/agents.mjs`（文件顶部加 `import process from "node:process";` 与 `import { spawnExecutableSync } from "./process.mjs";`，文件末尾追加）：

```js
export function agentExecutableAvailable(agentId, environment = process.env) {
  const agent = getAgent(agentId);
  try {
    const result = spawnExecutableSync(agent.executable, ["--version"], {
      env: environment,
      stdio: "pipe",
      windowsHide: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}
```

`packages/core/src/index.mjs` 的 agents 导出行改为：

```js
export { AGENTS, agentExecutableAvailable, getAgent } from "./runtime/agents.mjs";
```

`packages/cli/src/cli/dispatcher.mjs`：删除 `executableAvailable` 函数（`launchExecutable --version capture === 0` 那个）；顶部 import 加入 `agentExecutableAvailable`；把三处调用（`printAgentStatus` 内、`dispatchStatus`、`dispatchDoctor`）改为 `agentExecutableAvailable(agent.id)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS——含新测试；`test/cli-surface.test.mjs`（status/doctor 输出）必须仍绿（输出不变）。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/agents.mjs packages/core/src/index.mjs test/runtime.test.mjs
git commit -m "feat(core): agentExecutableAvailable — official CLI probe"
git add packages/cli/src/cli/dispatcher.mjs
git commit -m "refactor(cli): use core agentExecutableAvailable"
```

### Task 3: core 新增 `skillsInstallationStatus`，commandStatus 改用

**Files:** Modify `packages/core/src/skills/install.mjs`、`packages/core/src/index.mjs`、`packages/cli/src/cli/skills-cli.mjs`；Test: Modify `test/skills.test.mjs`

**Interfaces:** Produces: `skillsInstallationStatus(context: InstallContext): Promise<InstallStatus | null>`（无锁文件返回 null）。`InstallStatus = { groups: SkillGroup[]; packs: Array<{id?,name?}|string>; names: string[]; targets: Array<InstallTarget & {present:number; total:number; complete:boolean}> }`。

- [ ] **Step 1: 写失败测试（skills.test.mjs 追加）**

```js
test("skillsInstallationStatus reports manifest packs and target presence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skills-status-"));
  try {
    const context = createInstallContext(false, { cwd: root, environment: process.env });
    assert.equal(await skillsInstallationStatus(context), null);
    await writeJson(context.lockFile, {
      schemaVersion: 3,
      packs: [{ id: "common", name: "Common" }],
      sources: [{ id: "s-source", name: "S", repository: "https://github.com/example/s.git", revision: "a".repeat(40), skills: ["s"] }],
    });
    await mkdir(path.join(context.targets[0].destination, "s"), { recursive: true });
    await writeFile(path.join(context.targets[0].destination, "s", "SKILL.md"), "---\nname: s\n---\n");
    const status = await skillsInstallationStatus(context);
    assert.equal(status.names.length, 1);
    assert.equal(status.packs[0].id, "common");
    assert.equal(status.targets[0].complete, true);
    assert.equal(status.targets[1].complete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

（import 列表加 `skillsInstallationStatus`。）

- [ ] **Step 2: 跑测试确认失败** → Run: `npm test` → FAIL（未导出）。

- [ ] **Step 3: 最小实现**

`packages/core/src/skills/install.mjs` 末尾追加：

```js
// Structured `skills status` data: the manifest's packs and per-target
// presence counts. Returns null when nothing is installed.
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
  const names = groups.flatMap((group) => group.skills.map((skill) => skill.name));
  const targets = context.targets.map((targetConfig) => {
    const directory = targetConfig.destination;
    const present = names.filter((name) => existsSync(path.join(directory, name, "SKILL.md"))).length;
    return { ...targetConfig, present, total: names.length, complete: present === names.length };
  });
  return { groups, packs: manifestPacks, names, targets };
}
```

`index.mjs` 的 install 导出块加入 `skillsInstallationStatus`。

`skills-cli.mjs` 的 `commandStatus` 替换为：

```js
async function commandStatus(options = {}) {
  const io = options.io ?? console;
  const context = createInstallContext(options.global ?? false, options);
  const status = await skillsInstallationStatus(context);
  if (!status) {
    fail(`${context.label} scope has no lock file; install a Pack first`);
  }
  printTree(status.groups, `Current ${context.label} Skills`, [
    `Packs: ${status.packs.map((pack) => pack.name ?? pack.id ?? pack).join(" + ")}`,
  ], io);
  for (const targetConfig of status.targets) {
    io.log(`${targetConfig.complete ? "✓" : "!"} ${targetConfig.label}: ${targetConfig.present}/${targetConfig.total}`);
  }
}
```

（import 列表加 `skillsInstallationStatus`；仅当无其他引用时删 `readJson`——`commandAdd` 仍用则保留。）

- [ ] **Step 4: 跑测试确认通过** → Run: `npm test` → PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/skills/install.mjs packages/core/src/index.mjs test/skills.test.mjs
git commit -m "feat(core): skillsInstallationStatus — structured skills status"
git add packages/cli/src/cli/skills-cli.mjs
git commit -m "refactor(cli): commandStatus uses core skillsInstallationStatus"
```

### Task 4: core 新增 `registerCatalog`，commandCatalogAdd 改用

**Files:** Modify `packages/core/src/skills/catalog.mjs`、`packages/core/src/index.mjs`、`packages/cli/src/cli/skills-cli.mjs`；Test: Modify `test/catalog-cache.test.mjs`

**Interfaces:** Produces: `registerCatalog(spec: string, options?: {environment?: ProcessEnv; io?: Io}): Promise<{spec: string; catalogInfo?: CatalogInfo; packs: Pack[]; previewFailed: boolean; error?: Error}>`。语义：解析校验 → 保存默认 spec → 登记已知 catalog → 尝试 ensureCatalog+loadPacks 预览（失败不致命，返回 `previewFailed: true`）。

- [ ] **Step 1: 写失败测试（catalog-cache.test.mjs 追加，复用文件内 `withTemp`/`fixtureCatalog`/`git` helper 与 import）**

```js
test("registerCatalog saves the spec and tolerates preview failure", async () => {
  await withTemp("catalog-register-", async (root) => {
    const state = path.join(root, "state");
    const environment = { AGENTHOME_STATE_DIR: state };
    const missing = path.join(root, "no-such-catalog");
    const failed = await registerCatalog(missing, { environment, io: { log() {} } });
    assert.equal(failed.previewFailed, true);
    assert.equal(await loadDefaultCatalogSpec(environment), missing);
    assert.equal((await loadKnownCatalogs(environment))[0].spec, missing);

    const catalog = path.join(root, "catalog");
    await fixtureCatalog(catalog);
    const ok = await registerCatalog(catalog, { environment, io: { log() {} } });
    assert.equal(ok.previewFailed, false);
    assert.equal(ok.packs.length, 1);
    assert.equal(ok.packs[0].id, "common");
  });
});
```

（import 列表加 `registerCatalog`。）

- [ ] **Step 2: 跑测试确认失败** → `npm test` → FAIL。

- [ ] **Step 3: 最小实现**

`catalog.mjs`（import 加 `import { loadPacks } from "./packs.mjs";`——packs.mjs 不 import catalog.mjs，无环；末尾追加）：

```js
// Register a catalog: save the default spec and the known-catalog entry
// first, then try to fetch and preview its Packs. The spec stays configured
// even when the preview fails (offline, missing credentials, no Packs yet).
export async function registerCatalog(spec, options = {}) {
  const io = options.io ?? console;
  parseCatalogSpec(spec);
  await setDefaultCatalogSpec(options.environment, spec);
  await registerKnownCatalog(options.environment, spec);
  try {
    const catalogInfo = await ensureCatalog(spec, { environment: options.environment, io });
    const packs = [...(await loadPacks(catalogInfo.catalogRoot)).values()];
    return { spec, catalogInfo, packs, previewFailed: false };
  } catch (error) {
    return { spec, packs: [], previewFailed: true, error };
  }
}
```

`index.mjs` 的 catalog 导出块加入 `registerCatalog`。

`skills-cli.mjs` 的 `commandCatalogAdd` 替换为：

```js
async function commandCatalogAdd(argumentsList, options = {}) {
  const io = options.io ?? console;
  const [spec] = argumentsList;
  if (!spec || argumentsList.length !== 1) {
    fail("Usage: agenthome catalog add <spec>");
  }
  const result = await registerCatalog(spec, { environment: options.environment, io });
  io.log(`Default catalog: ${spec}`);
  if (result.previewFailed) {
    io.log("\nSpec saved. Catalog preview unavailable:");
    io.log(`  ${String(result.error.message).split("\n")[0]}`);
  } else {
    io.log(`\nPacks · ${result.packs.length}`);
    result.packs.forEach((pack, packIndex) => {
      const lastPack = packIndex === result.packs.length - 1;
      const label = pack.name && pack.name !== pack.id ? `${pack.id} (${pack.name})` : pack.id;
      const purpose = pack.description ? ` — ${pack.description}` : "";
      io.log(`${lastPack ? "└──" : "├──"} ${label}${purpose}`);
    });
    io.log("\nInstall: agenthome skills install [pack...]");
  }
  io.log("Run: agenthome catalog sync");
}
```

（import 列表加 `registerCatalog`；删去仅本函数使用、文件内无其他引用的 `parseCatalogSpec`/`setDefaultCatalogSpec`/`registerKnownCatalog`/`ensureCatalog`/`loadPacks`——逐个 grep 确认后再删，有引用的一律保留。）

- [ ] **Step 4: 跑测试确认通过** → `npm test` → PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/skills/catalog.mjs packages/core/src/index.mjs test/catalog-cache.test.mjs
git commit -m "feat(core): registerCatalog — save-first catalog registration with tolerant preview"
git add packages/cli/src/cli/skills-cli.mjs
git commit -m "refactor(cli): catalog add uses core registerCatalog"
```

### Task 5: core 新增 `resolveInstallSource`，skills-cli 的 tree/packs/兜底改用

**Files:** Modify `packages/core/src/skills/install.mjs`、`packages/core/src/index.mjs`、`packages/cli/src/cli/skills-cli.mjs`；Test: Modify `test/skills.test.mjs`

**Interfaces:** Produces: `resolveInstallSource(options: {global?: boolean; cwd?: string; environment?: ProcessEnv; io?: Io}, {refresh?: boolean}): Promise<CatalogInfo & {packageMetadata: unknown}>`。语义：默认 spec → 项目锁 pin catalog commit（refresh=true 绕过 pin）→ ensureCatalog → 读 package.json。

- [ ] **Step 1: 写失败测试（skills.test.mjs 追加，helper 放文件内）**

```js
test("resolveInstallSource pins the lock revision unless refreshing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resolve-source-"));
  try {
    const state = path.join(root, "state");
    const catalog = path.join(root, "catalog");
    await fixtureCatalog(catalog);
    const environment = { ...process.env, AGENTHOME_STATE_DIR: state };
    await setDefaultCatalogSpec(environment, catalog);
    const first = await resolveInstallSource({ cwd: root, environment }, {});
    assert.equal(first.revision.length, 40);
    await writeFile(path.join(catalog, "skills", "s", "SKILL.md"), "---\nname: s\n---\nv2\n");
    git(catalog, ["add", "-A"]);
    git(catalog, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "--quiet", "-m", "two"]);
    await writeJson(path.join(root, ".agent-skills.lock.json"), {
      schemaVersion: 3,
      catalog: { repository: catalog, revision: first.revision },
    });
    const pinned = await resolveInstallSource({ cwd: root, environment }, {});
    assert.equal(pinned.revision, first.revision);
    const refreshed = await resolveInstallSource({ cwd: root, environment }, { refresh: true });
    assert.notEqual(refreshed.revision, first.revision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixtureCatalog(root) {
  await mkdir(path.join(root, "skills", "s"), { recursive: true });
  await mkdir(path.join(root, "packs"), { recursive: true });
  await writeFile(path.join(root, "skills", "s", "SKILL.md"), "---\nname: s\n---\nv1\n");
  await writeFile(path.join(root, "packs", "common.json"), `${JSON.stringify({ schemaVersion: 1, id: "common", name: "Common", sources: [{ source: "s", skills: ["s"] }] })}\n`);
  await writeFile(path.join(root, "sources.lock.json"), `${JSON.stringify({ schemaVersion: 1, sources: [{ id: "s", name: "S", repository: "https://github.com/example/s.git", skillRoot: "skills", revision: "a".repeat(40) }] })}\n`);
  git(root, ["init", "--quiet", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "--quiet", "-m", "one"]);
}

function git(cwd, argumentsList) {
  const result = spawnSync("git", ["-C", cwd, ...argumentsList], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
```

（import 列表加 `resolveInstallSource`、`setDefaultCatalogSpec`；`spawnSync` 从 node:child_process 导入若未导入。fixture 要点：source id 必须与 skills 目录名一致——用 `"s"`，这样 buildCatalog 能找到 skills/s。）

- [ ] **Step 2: 跑测试确认失败** → `npm test` → FAIL。

- [ ] **Step 3: 最小实现**

`install.mjs`（import 加 `import { ensureCatalog, loadDefaultCatalogSpec, parseCatalogSpec } from "./catalog.mjs";`——catalog.mjs 不 import install.mjs，无环；末尾追加）：

```js
async function pinnedCatalogSpec(spec, context) {
  if (!existsSync(context.lockFile)) {
    return spec;
  }
  const lock = await readJson(context.lockFile);
  const { repository, revision } = lock.catalog ?? {};
  if (!repository || !revision) {
    return spec;
  }
  if (parseCatalogSpec(spec).repository !== repository) {
    return spec;
  }
  return `${repository}#${revision}`;
}

// Resolve the catalog for an install context. The project lock pins the
// catalog commit for cross-device reproducibility; a refresh (bare
// `agenthome skills`) intentionally bypasses the pin to pick up the latest.
export async function resolveInstallSource(options, { refresh = false } = {}) {
  const spec = await loadDefaultCatalogSpec(options.environment);
  const context = createInstallContext(options.global ?? false, options);
  const pinnedSpec = refresh ? spec : await pinnedCatalogSpec(spec, context);
  const catalogInfo = await ensureCatalog(pinnedSpec, {
    environment: options.environment,
    io: options.io ?? console,
  });
  const packageMetadata = existsSync(path.join(catalogInfo.catalogRoot, "package.json"))
    ? await readJson(path.join(catalogInfo.catalogRoot, "package.json"))
    : null;
  return { ...catalogInfo, packageMetadata };
}
```

`index.mjs` 的 install 导出块加入 `resolveInstallSource`。

`skills-cli.mjs`：本任务只把 **`commandTree`、`commandPacks`、`dispatchSkills` 兜底**三处的 `resolveCatalogSource(commandOptions)` 改为 `resolveInstallSource(commandOptions)`；import 列表加 `resolveInstallSource`。**不删除** `resolveCatalogSource`/`pinnedCatalogSpec`——`commandInstall`/`commandUninstall` 仍在使用，T6/T7 迁移后（T7 结束时）再删除。

- [ ] **Step 4: 跑测试确认通过** → `npm test` → PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/skills/install.mjs packages/core/src/index.mjs test/skills.test.mjs
git commit -m "feat(core): resolveInstallSource — lock-pinned catalog resolution"
git add packages/cli/src/cli/skills-cli.mjs
git commit -m "refactor(cli): tree/packs/fallback use core resolveInstallSource"
```

### Task 6: core 新增 `installPacks`，commandInstall 改用

**Files:** Modify `packages/core/src/skills/install.mjs`、`packages/core/src/index.mjs`、`packages/cli/src/cli/skills-cli.mjs`；Test: Modify `test/skills.test.mjs`

**Interfaces:** Produces: `installPacks(context: InstallContext, explicitPacks?: string[], options?: {io?: Io; onPlan?: (resolvedPacks: ResolvedPacks) => void}): Promise<{catalogInfo: CatalogInfo; packIds: string[]; resolvedPacks: ResolvedPacks}>`。语义：catalog 目录守卫 → resolveInstallSource(refresh = 无显式 Pack) → buildCatalog → loadPacks → resolveInstallPacks → resolvePacks → **onPlan 呈现钩子** → installCopies → writeInstallMetadata。

- [ ] **Step 1: 写失败测试（skills.test.mjs 追加，复用 T5 的 helper）**

```js
test("installPacks installs the resolved packs and writes metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "install-packs-"));
  try {
    const state = path.join(root, "state");
    const catalog = path.join(root, "catalog");
    await fixtureCatalog(catalog);
    const environment = { ...process.env, AGENTHOME_STATE_DIR: state };
    await setDefaultCatalogSpec(environment, catalog);
    const context = createInstallContext(false, { cwd: root, environment });
    const planned = [];
    const result = await installPacks(context, [], { io: { log() {} }, onPlan: (resolved) => planned.push(resolved.names.length) });
    assert.equal(result.resolvedPacks.names[0], "s");
    assert.deepEqual(planned, [1]);
    assert.equal(existsSync(path.join(context.targets[0].destination, "s", "SKILL.md")), true);
    const lock = await readJson(context.lockFile);
    assert.equal(lock.catalog.revision.length, 40);
    assert.equal(lock.packs[0].id, "common");
    await assert.rejects(() => installPacks(createInstallContext(false, { cwd: catalog, environment }), [], { io: { log() {} } }), /not from the AgentHome catalog/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败** → `npm test` → FAIL。

- [ ] **Step 3: 最小实现**

`install.mjs`（import 加 `import { buildCatalog, loadSources } from "./sources.mjs";` 与 `import { loadPacks, resolvePacks } from "./packs.mjs";`——两者均不 import install.mjs，无环；末尾追加）：

```js
// Install Packs into a scope: resolve the catalog, resolve the Packs,
// hand the plan to the presentation hook, copy the Skills, and write the
// config/lock metadata. Bare invocations (no explicit Packs) refresh the
// configured Packs against the latest catalog.
export async function installPacks(context, explicitPacks = [], options = {}) {
  const io = options.io ?? console;
  if (!context.global && isCatalogDirectory(context.root)) {
    fail("Run installation from a work project, not from the AgentHome catalog");
  }
  const catalogInfo = await resolveInstallSource({
    global: context.global,
    cwd: context.root,
    environment: context.environment,
    io,
  }, { refresh: explicitPacks.length === 0 });
  const sourceConfig = await loadSources(catalogInfo.catalogRoot);
  const catalog = await buildCatalog(sourceConfig, path.join(catalogInfo.catalogRoot, "skills"));
  const packs = await loadPacks(catalogInfo.catalogRoot);
  const packIds = await resolveInstallPacks(context, explicitPacks);
  const resolvedPacks = resolvePacks(catalog, sourceConfig, packs, packIds);
  await options.onPlan?.(resolvedPacks);
  await installCopies(context, resolvedPacks, io);
  await writeInstallMetadata(context, resolvedPacks, catalogInfo);
  return { catalogInfo, packIds, resolvedPacks };
}
```

`index.mjs` 的 install 导出块加入 `installPacks`。

`skills-cli.mjs` 的 `commandInstall` 替换为：

```js
async function commandInstall(explicitPacks = [], options = {}) {
  const io = options.io ?? console;
  const context = createInstallContext(options.global ?? false, options);
  const { resolvedPacks } = await installPacks(context, explicitPacks, {
    io,
    onPlan: (resolved) => {
      printTree(resolved.groups, "Skill Installation Plan", [
        `Packs: ${resolved.packs.map((pack) => pack.name).join(" + ")}`,
        `Scope: ${context.label}`,
        `Root: ${context.root}`,
        `Duplicate selections removed: ${resolved.duplicateSelections}`,
      ], io);
    },
  });
  io.log(`\nInstallation complete: ${resolvedPacks.names.length} unique Skills`);
  io.log(`Config: ${context.configFile}`);
  io.log(`Lock:   ${context.lockFile}`);
}
```

（import 列表加 `installPacks`；`commandInstall` 不再用到的 import 逐个 grep 确认无其他引用后删除——`resolvePacks`/`installCopies`/`writeInstallMetadata` 仍被 commandUninstall/其他函数使用则保留。本任务**不删** `resolveCatalogSource`/`pinnedCatalogSpec`。）

- [ ] **Step 4: 跑测试确认通过** → `npm test` → PASS（cli-surface 若有安装流程输出断言必须仍绿）。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/skills/install.mjs packages/core/src/index.mjs test/skills.test.mjs
git commit -m "feat(core): installPacks — pack install orchestration"
git add packages/cli/src/cli/skills-cli.mjs
git commit -m "refactor(cli): skills install uses core installPacks"
```

### Task 7: core 新增 `uninstallPacks`，commandUninstall 的 Pack 路径改用

**Files:** Modify `packages/core/src/skills/install.mjs`、`packages/core/src/index.mjs`、`packages/cli/src/cli/skills-cli.mjs`；Test: Modify `test/skills.test.mjs`

**Interfaces:** Produces: `uninstallPacks(context, packArguments?: string[], options?: {io?: Io; onPlan?: (resolvedPacks: ResolvedPacks, removed: string[]) => void}): Promise<{changed: boolean; removed: string[]; absent: string[]; skippedCommon: boolean; current: string[] | null; resolvedPacks?: ResolvedPacks}>`。语义：common 不可卸/总是包含 → 剩余 Pack 重装（installCopies + writeInstallMetadata）。CLI 的"无参数全量卸载"路径**不迁移**（保留在 commandUninstall 内）。

- [ ] **Step 1: 写失败测试（skills.test.mjs 追加）**

fixture 升级（改 T5 已加的 `fixtureCatalog`，追加第二个 Pack 与 Skill；旧测试不受影响）：

```js
  await mkdir(path.join(root, "skills", "s2"), { recursive: true });
  await writeFile(path.join(root, "skills", "s2", "SKILL.md"), "---\nname: s2\n---\nv1\n");
  await writeFile(path.join(root, "packs", "development.json"), `${JSON.stringify({ schemaVersion: 1, id: "development", name: "Development", sources: [{ source: "s", skills: ["s2"] }] })}\n`);
```

测试：

```js
test("uninstallPacks keeps common and reinstalls remaining packs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "uninstall-packs-"));
  try {
    const state = path.join(root, "state");
    const catalog = path.join(root, "catalog");
    await fixtureCatalog(catalog);
    const environment = { ...process.env, AGENTHOME_STATE_DIR: state };
    await setDefaultCatalogSpec(environment, catalog);
    const context = createInstallContext(false, { cwd: root, environment });
    await installPacks(context, ["development"], { io: { log() {} } });
    assert.equal((await installedPackIds(context)).includes("development"), true);

    const nothing = await uninstallPacks(context, ["common"], { io: { log() {} } });
    assert.equal(nothing.changed, false);
    assert.equal(nothing.skippedCommon, true);
    const missing = await uninstallPacks(context, ["unknown-pack"], { io: { log() {} } });
    assert.equal(missing.changed, false);
    assert.deepEqual(missing.absent, ["unknown-pack"]);

    const result = await uninstallPacks(context, ["development"], { io: { log() {} } });
    assert.equal(result.changed, true);
    assert.deepEqual(result.removed, ["development"]);
    const lock = await readJson(context.lockFile);
    assert.deepEqual(lock.packs.map((pack) => pack.id), ["common"]);
    assert.equal(existsSync(path.join(context.targets[0].destination, "s2")), false);
    assert.equal(existsSync(path.join(context.targets[0].destination, "s", "SKILL.md")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败** → `npm test` → FAIL。

- [ ] **Step 3: 最小实现**

`install.mjs` 末尾追加（`assertSafeId` 从 `./ids.mjs` 加入 import）：

```js
// Uninstall Packs from a scope: validate the request, reinstall the
// remaining Packs (common is always included and can never be removed),
// and rewrite the metadata. The no-argument full cleanup stays in the CLI.
export async function uninstallPacks(context, packArguments = [], options = {}) {
  const io = options.io ?? console;
  const requested = parsePackArguments(packArguments);
  requested.forEach((packId) => assertSafeId(packId, "Pack id"));
  const current = await installedPackIds(context);
  if (!current) {
    io.log(`No managed ${context.label.toLowerCase()} skills installation found`);
    return { changed: false, removed: [], absent: requested, skippedCommon: false, current: null };
  }
  const removable = new Set(requested.filter((packId) => packId !== "common"));
  const removed = current.filter((packId) => removable.has(packId));
  const absent = requested.filter((packId) => packId !== "common" && !current.includes(packId));
  const skippedCommon = requested.includes("common");
  if (removed.length === 0) {
    return { changed: false, removed: [], absent, skippedCommon, current };
  }
  const catalogInfo = await resolveInstallSource({
    global: context.global,
    cwd: context.root,
    environment: context.environment,
    io,
  });
  const sourceConfig = await loadSources(catalogInfo.catalogRoot);
  const catalog = await buildCatalog(sourceConfig, path.join(catalogInfo.catalogRoot, "skills"));
  const packs = await loadPacks(catalogInfo.catalogRoot);
  const remaining = current.filter((packId) => !removable.has(packId));
  const resolvedPacks = resolvePacks(catalog, sourceConfig, packs, remaining);
  await options.onPlan?.(resolvedPacks, removed);
  await installCopies(context, resolvedPacks, io);
  await writeInstallMetadata(context, resolvedPacks, catalogInfo);
  return { changed: true, removed, absent, skippedCommon, current, resolvedPacks };
}
```

实现说明：Step 4 的测试断言卸载后 `s2` 目录已删除。若 `installCopies` 本身不清理已移除 Pack 的目录（以测试失败为准），在 `installCopies` 之前补：`removedSkillNames` = `previousManagedState(context)` 的键集合减去 remaining 解析出的 names，然后 `await removeSkillDirectories(context, removedSkillNames, io);`。

`index.mjs` 的 install 导出块加入 `uninstallPacks`。

`skills-cli.mjs` 的 `commandUninstall`：**保留无参数全量卸载分支原样**（`packArguments.length === 0` 时走 `removeAllManagedSkills`/`removeInstallationFiles` 的现有代码不动）；Pack 参数路径替换为：

```js
  const result = await uninstallPacks(context, packArguments, {
    io,
    onPlan: (resolved, removedPacks) => {
      printTree(resolved.groups, "Skill Uninstall Plan", [
        `Remove Packs: ${removedPacks.join(" + ")}`,
        `Keep Packs: ${resolved.packs.map((pack) => pack.name).join(" + ")}`,
        `Scope: ${context.label}`,
        `Root: ${context.root}`,
      ], io);
    },
  });
  if (result.current === null) return;
  if (result.skippedCommon) {
    io.log("Skipped: common is always included");
  }
  if (result.absent.length > 0) {
    io.log(`Already absent: ${result.absent.join(", ")}`);
  }
  if (!result.changed) {
    io.log("No Pack changes");
    return;
  }
  io.log(`\nUninstall complete: ${result.removed.join(", ")}`);
```

本任务结束时 `resolveCatalogSource`/`pinnedCatalogSpec` 已无引用——删除两个私有函数并清理 import（`commandTree`/`commandPacks` 的 `resolveInstallSource` 已在 T5 切换）。

- [ ] **Step 4: 跑测试确认通过** → `npm test` → PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/skills/install.mjs packages/core/src/index.mjs test/skills.test.mjs
git commit -m "feat(core): uninstallPacks — pack uninstall orchestration"
git add packages/cli/src/cli/skills-cli.mjs
git commit -m "refactor(cli): skills uninstall uses core uninstallPacks"
```

### Task 8: core 新增 `removeExternalSkills`，commandUninstallSkill 改用

**Files:** Modify `packages/core/src/skills/direct.mjs`、`packages/core/src/index.mjs`、`packages/cli/src/cli/skills-cli.mjs`；Test: Modify `test/skills-direct-add.test.mjs`

**Interfaces:** Produces: `removeExternalSkills(context: InstallContext, skillNames: string[], options?: {io?: Io}): Promise<{directRemoved: string[]; removedDirectories: number}>`。语义：受管理 Skill 拒绝删除 → 移除直装记录 → 删除目录。

- [ ] **Step 1: 写失败测试（skills-direct-add.test.mjs 追加）**

```js
test("removeExternalSkills refuses managed skills and removes direct ones", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remove-direct-"));
  try {
    const context = createInstallContext(false, { cwd: root, environment: process.env });
    await writeJson(context.lockFile, {
      schemaVersion: 3,
      sources: [{ id: "s-source", name: "S", repository: "https://github.com/example/s.git", revision: "a".repeat(40), skills: ["managed-skill"] }],
    });
    await assert.rejects(
      () => removeExternalSkills(context, ["managed-skill"], { io: { log() {} } }),
      /Managed by configured Packs/,
    );
    await writeJson(context.lockFile, {
      schemaVersion: 3,
      directSources: [{ id: "d-source", name: "D", repository: "https://github.com/example/d.git", revision: "a".repeat(40), skillRoot: "skills", skills: ["d-skill"] }],
    });
    const target = path.join(context.targets[0].destination, "d-skill");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), "---\nname: d-skill\n---\n");
    const result = await removeExternalSkills(context, ["d-skill"], { io: { log() {} } });
    assert.deepEqual(result.directRemoved, ["d-skill"]);
    assert.equal(existsSync(target), false);
    assert.deepEqual((await readDirectState(context)).directSources, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

（import 列表加 `removeExternalSkills`。）

- [ ] **Step 2: 跑测试确认失败** → `npm test` → FAIL。

- [ ] **Step 3: 最小实现**

`direct.mjs` 末尾追加（`assertSafeSkillName`/`previousManagedState`/`removeSkillDirectories` 均已在文件内 import 或由文件内现有 import 覆盖；若缺则补）：

```js
// Remove externally installed Skills: managed Skills are rejected (they
// belong to Packs), then the direct records and the target directories go.
export async function removeExternalSkills(context, skillNames, options = {}) {
  const io = options.io ?? console;
  const uniqueNames = [...new Set(skillNames)];
  uniqueNames.forEach(assertSafeSkillName);
  const managed = await previousManagedState(context);
  const managedNames = uniqueNames.filter((skillName) => managed.has(skillName));
  if (managedNames.length > 0) {
    fail(
      `Managed by configured Packs: ${managedNames.join(", ")}. Uninstall the Pack or remove the Skill from the Catalog`,
    );
  }
  const directRemoved = await removeDirectSkills(context, uniqueNames);
  const removedDirectories = await removeSkillDirectories(context, uniqueNames, io);
  return { directRemoved, removedDirectories };
}
```

`index.mjs` 的 direct 导出块加入 `removeExternalSkills`。

`skills-cli.mjs` 的 `commandUninstallSkill` 替换为：

```js
async function commandUninstallSkill(skillArguments, options = {}) {
  const io = options.io ?? console;
  if (skillArguments.length === 0) {
    fail("Usage: remove <skill...> [-g]");
  }
  const skillNames = [...new Set(skillArguments)];
  const context = createInstallContext(options.global ?? false, options);
  const result = await removeExternalSkills(context, skillNames, { io });
  io.log(
    result.removedDirectories > 0 || result.directRemoved.length > 0
      ? `Removed external Skills: ${skillNames.join(", ")}`
      : `Already absent: ${skillNames.join(", ")}`,
  );
}
```

- [ ] **Step 4: 跑测试确认通过** → `npm test` → PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/skills/direct.mjs packages/core/src/index.mjs test/skills-direct-add.test.mjs
git commit -m "feat(core): removeExternalSkills — direct skill removal orchestration"
git add packages/cli/src/cli/skills-cli.mjs
git commit -m "refactor(cli): skills remove uses core removeExternalSkills"
```

### Task 9: 手写 `index.d.ts` 类型契约 + 版本收尾

**Files:** Create `packages/core/index.d.ts`；Modify `test/packaging.test.mjs`；Modify `packages/cli/package.json`（version 5.8.0）；Modify `docs/development.md`（发布纪律简版）

**Interfaces:** Produces: `@agenthome/core` 的类型契约（扩展 M2 起 `import ... from "@agenthome/core"` 全类型化）。

- [ ] **Step 1: 写失败测试（packaging.test.mjs 追加）**

```js
test("core type declarations cover the extension contract", async () => {
  const dts = await readFile(path.join(packageRoot, "packages", "core", "index.d.ts"), "utf8");
  for (const name of [
    "AGENTS", "getAgent", "agentExecutableAvailable",
    "initializeAgent", "deinitializeAgent", "setLocalAuth", "clearLocalAuth",
    "effectiveAgentConfig", "loadRuntime", "getSessionAdapter", "spawnExecutableSync",
    "createInstallContext", "installedPackIds", "installPacks", "uninstallPacks",
    "skillsInstallationStatus", "resolveInstallSource", "addDirectSkills", "removeExternalSkills",
    "readDirectState", "loadKnownCatalogs", "setDefaultCatalogSpec", "loadDefaultCatalogSpec",
    "registerCatalog", "ensureCatalog", "buildCatalog", "loadPacks", "resolvePacks",
    "cloneHead", "detectSkillRoot", "discoverSourceSkills", "locateProjectRoot",
  ]) {
    assert.match(dts, new RegExp(`\\b${name}\\b`), name);
  }
});
```

- [ ] **Step 2: 跑测试确认失败** → `npm test` → FAIL（文件不存在）。

- [ ] **Step 3: 最小实现**——创建 `packages/core/index.d.ts`，完整内容：

```ts
// Type declarations for @agenthome/core.
// Hand-maintained next to src/index.mjs; update both in the same change.

export interface ProcessEnvLike {
  [key: string]: string | undefined;
}

export interface Agent {
  id: string;
  displayName: string;
  executable: string;
}

export interface Io {
  log(message?: string): void;
}

// ---- runtime: agents ----

export const AGENTS: Record<string, Agent>;
export function getAgent(agentId: string): Agent;
export function agentExecutableAvailable(agentId: string, environment?: ProcessEnvLike): boolean;

// ---- runtime: config ----

export interface AgentRuntimeConfig {
  enabled?: boolean;
  auth?: "global" | "project";
  sessions?: "global" | "project";
  [key: string]: unknown;
}

export interface EffectiveAgentConfig {
  enabled?: boolean;
  auth: "global" | "project";
  sessions: "global" | "project";
  configuredAuth: "global" | "project";
  localAuth: "global" | "project" | null;
}

export interface RuntimePaths {
  localRoot: string;
  runtimeFile: string;
  localRuntimeFile: string;
  sessionsRoot: string;
}

export interface RuntimeState {
  paths: RuntimePaths;
  runtime: { schemaVersion?: number; agents?: Record<string, AgentRuntimeConfig> };
  local: { schemaVersion?: number; agents?: Record<string, { auth?: "global" | "project" }> };
}

export function validateAuthMode(authMode: unknown): "global" | "project";
export function validateSessionsMode(sessionsMode: unknown): "global" | "project";
export function runtimePaths(projectRoot: string): RuntimePaths;
export function loadRuntime(projectRoot: string): Promise<RuntimeState>;
export function initializeAgent(
  projectRoot: string,
  agentId: string,
  authMode?: "global" | "project",
  sessionsMode?: "global" | "project",
): Promise<RuntimeState & { authMode: string; sessionsMode: string; configChanged: boolean; gitignoreChanged: boolean; structureRepaired: boolean }>;
export function projectAuthEnvironment(agentId: string, projectRoot: string): Record<string, string>;
export function deinitializeAgent(
  projectRoot: string,
  agentId: string,
  options?: { purge?: boolean },
): Promise<{ agent: Agent; changed: boolean; purged: boolean; remaining: number }>;
export function setLocalAuth(projectRoot: string, agentId: string, authMode: "global" | "project"): Promise<EffectiveAgentConfig>;
export function clearLocalAuth(projectRoot: string, agentId: string): Promise<EffectiveAgentConfig>;
export function effectiveAgentConfig(state: RuntimeState, agentId: string): EffectiveAgentConfig | null;

// ---- runtime: gitignore / project-root / process / sessions / adapters ----

export const REQUIRED_RULES: readonly string[];
export const SESSIONS_RULE: string;
export function ensureRuntimeGitignore(projectRoot: string): Promise<boolean>;
export function removeRuntimeGitignore(projectRoot: string, options?: { sessions?: boolean }): Promise<unknown>;
export function sessionsGitIgnored(projectRoot: string): Promise<boolean>;
export function setSessionsGitIgnored(projectRoot: string, ignored: boolean): Promise<boolean>;

export function locateProjectRoot(startDirectory?: string): string;
export function spawnExecutableSync(
  executable: string,
  argumentsList: string[],
  options?: {
    cwd?: string;
    env?: ProcessEnvLike;
    stdio?: "pipe" | "inherit" | "ignore";
    encoding?: string;
    windowsHide?: boolean;
    capture?: boolean;
  },
): { status: number | null; stdout?: string; stderr?: string; error?: Error };

export const PROJECT_ROOT_TOKEN: string;
export interface SessionLease {
  member: string;
  stateDir: string;
  release: () => Promise<unknown>;
}
export interface SessionLeaseCallbacks {
  onFirst?: (recovering: boolean) => Promise<void>;
  onLast?: () => Promise<void>;
}
export function acquireSessionLease(agentId: string, projectRoot: string, callbacks?: SessionLeaseCallbacks): Promise<SessionLease>;
export function releaseSessionLease(agentId: string, projectRoot: string, member: string, callbacks?: SessionLeaseCallbacks): Promise<unknown>;
export function sessionLeasePath(agentId: string, projectRoot: string): string;
export function processAlive(pid: number): boolean;
export function samePath(left: string, right: string): boolean;
export function hashContent(content: string): string;
export function readFirstJsonLine(file: string): unknown | null;
export function listFiles(sourcePath: string): Promise<string[]>;
export function snapshotFiles(sourcePaths: string[], source: string, destination: string): Promise<unknown>;
export function snapshotInto(source: string, destination: string): Promise<unknown>;
export function revertFrom(snapshot: string, source: string): Promise<unknown>;
export function replaceDirectory(sourcePath: string, destinationPath: string, filter?: (relativePath: string) => boolean): Promise<unknown>;
export function mergeFiles(sourcePath: string, destinationPath: string, filter?: (relativePath: string) => boolean): Promise<unknown>;
export function transformJsonLines(sourcePath: string, transform: (value: unknown) => unknown, encoding?: string): Promise<unknown>;

export interface SessionAdapterResult {
  count: number;
  changed?: boolean;
  added?: number;
  updated?: number;
  conflicts?: number;
}
export interface SessionAdapter {
  capture(projectRoot: string, options?: { environment?: ProcessEnvLike }): Promise<SessionAdapterResult>;
  restore(projectRoot: string, options?: { environment?: ProcessEnvLike }): Promise<SessionAdapterResult>;
  status(projectRoot: string, options?: { environment?: ProcessEnvLike }): Promise<{ count: number }>;
  snapshotNative?: (projectRoot: string, snapshotRoot: string, options?: { environment?: ProcessEnvLike }) => Promise<void>;
  revertNative?: (snapshotRoot: string, projectRoot: string, options?: { environment?: ProcessEnvLike }) => Promise<void>;
}
export function getSessionAdapter(agentId: string): SessionAdapter;

// ---- util ----

export function fail(message: string): never;
export function isInside(directory: string, target: string): boolean;
export function removeEmptyDirectory(directory: string): Promise<unknown>;
export function readJson(file: string): Promise<any>;
export function writeJson(file: string, value: unknown): Promise<unknown>;

// ---- skills: ids ----

export function assertSafeId(value: string, label?: string): string;
export function assertSafeSkillName(value: string): string;
export function assertSafeSkillPath(value: string): string;
export function assertSafeSkillRoot(value: string): string;
export function assertSafeRelativePath(value: string): string;

// ---- skills: paths ----

export const PROJECT_CONFIG_FILE: string;
export const PROJECT_LOCK_FILE: string;
export const LEGACY_PROFILE_FILE: string;
export interface InstallTarget {
  agents: string[];
  label: string;
  destination: string;
  relativePath?: string[];
}
export const PROJECT_TARGETS: Array<{ agents: string[]; label: string; relativePath: string[] }>;
export const GLOBAL_TARGETS: InstallTarget[];
export function stateRoot(environment?: ProcessEnvLike): string;
export function catalogCacheRoot(environment?: ProcessEnvLike): string;
export function defaultCatalogFile(environment?: ProcessEnvLike): string;
export function knownCatalogsFile(environment?: ProcessEnvLike): string;
export function globalConfigFile(environment?: ProcessEnvLike): string;
export function globalLockFile(environment?: ProcessEnvLike): string;

// ---- skills: git / catalog / sources / packs ----

export function git(argumentsList: string[], options?: { cwd?: string; capture?: boolean; environment?: ProcessEnvLike }): string;
export function run(argumentsList: string[], options?: unknown): string;
export function normalizeRepositoryInput(reference: string): string;
export function deriveSourceId(repository: string): string;
export function repositoryIdentity(repository: string): string;
export function remoteHead(source: Source): string;
export function cloneHead(source: { repository: string }, directory: string): Promise<string>;
export function cloneRevision(source: Source, directory: string): Promise<string>;
export function currentRepositoryState(catalogRoot: string): Promise<unknown>;

export interface KnownCatalogEntry {
  name: string;
  spec: string;
}
export function parseCatalogSpec(spec: string): { repository: string; ref: string };
export function catalogDisplayName(spec: string): string;
export function loadDefaultCatalogSpec(environment?: ProcessEnvLike): Promise<string>;
export function setDefaultCatalogSpec(environment: ProcessEnvLike | undefined, spec: string): Promise<unknown>;
export function loadKnownCatalogs(environment?: ProcessEnvLike): Promise<KnownCatalogEntry[]>;
export function registerKnownCatalog(environment: ProcessEnvLike | undefined, spec: string): Promise<unknown>;
export interface CatalogInfo {
  catalogRoot: string;
  repository: string;
  ref: string;
  revision: string;
  spec: string;
}
export function ensureCatalog(spec: string, options?: { environment?: ProcessEnvLike; io?: Io }): Promise<CatalogInfo>;
export function registerCatalog(spec: string, options?: { environment?: ProcessEnvLike; io?: Io }): Promise<{
  spec: string;
  catalogInfo?: CatalogInfo;
  packs: Pack[];
  previewFailed: boolean;
  error?: Error;
}>;

export interface Source {
  id: string;
  name: string;
  repository: string;
  revision: string;
  skillRoot?: string;
  licenseFile?: string;
  skillPaths?: Record<string, string>;
}
export interface SourcesConfig {
  schemaVersion?: number;
  sources: Source[];
}
export function loadSources(catalogRoot: string): Promise<SourcesConfig>;
export function saveSources(catalogRoot: string, sourceConfig: SourcesConfig): Promise<unknown>;
export function registerSource(catalogRoot: string, sourceConfig: SourcesConfig, input: Partial<Source>, io?: Io): Promise<Source>;
export function findSource(sourceConfig: SourcesConfig, reference: string): Source | null;
export function detectSkillRoot(cloneDirectory: string): Promise<string>;
export function discoverSourceSkills(source: Source, cloneDirectory: string): Promise<{ names: string[]; mappingsChanged: boolean }>;
export function readSkill(source: Source, cloneDirectory: string, skillName: string): Promise<unknown>;
export function parseFrontmatterName(content: string, file: string): string;
export function stageSource(source: Source, cloneDirectory: string, stageDirectory: string, skillNames: string[]): Promise<unknown>;
export interface CatalogSkill {
  name: string;
  directory: string;
  source: Source;
}
export interface Catalog {
  groups: SkillGroup[];
  byName: Map<string, CatalogSkill>;
}
export function buildCatalog(sourceConfig: SourcesConfig, skillsRoot: string): Promise<Catalog>;
export function printTree(groups: SkillGroup[], title: string, header: string[], io?: Io): void;

export interface PackSelection {
  source: string;
  skills: string[];
}
export interface Pack {
  schemaVersion?: number;
  id: string;
  name: string;
  description?: string;
  sources: PackSelection[];
}
export interface SkillGroup {
  source: Source;
  skills: CatalogSkill[];
}
export interface ResolvedPacks {
  groups: SkillGroup[];
  names: string[];
  packs: Pack[];
  duplicateSelections: number;
}
export function loadPacks(catalogRoot: string): Promise<Map<string, Pack>>;
export function parsePackArguments(argumentsList: string[]): string[];
export function normalizePackIds(packIds: string[]): string[];
export function resolvePack(catalog: Catalog, sourceConfig: SourcesConfig, pack: Pack): { groups: SkillGroup[]; names: string[]; pack: Pack };
export function resolvePacks(catalog: Catalog, sourceConfig: SourcesConfig, packs: Map<string, Pack>, requestedPackIds: string[]): ResolvedPacks;
export function packContainsSkill(pack: Pack, sourceId: string, skillName: string): boolean;
export function skillCoveredByPacks(packs: Map<string, Pack>, packIds: string[], sourceId: string, skillName: string): boolean;
export function catalogReferences(packs: Map<string, Pack>): Set<string>;
export function addSkillsToPacks(catalogRoot: string, packIds: string[], sourceId: string, skillNames: string[]): Promise<{ added: Array<{ packId: string; skillName: string }>; inherited: string[] }>;
export function pruneCatalogSkills(catalogRoot: string, sourceConfig: SourcesConfig, packs: Map<string, Pack>, candidates: Array<{ sourceId: string; skillName: string }>): Promise<{ removed: Array<{ sourceId: string; skillName: string }>; removedSources: string[] }>;

// ---- skills: vendor / install / direct ----

export function createTempDirectory(catalogRoot: string): Promise<string>;
export function removeTempDirectory(directory: string): Promise<unknown>;
export function replaceStagedFiles(replacements: Array<{ relativePath: string; staged: string; target: string }>, tempDirectory: string): Promise<unknown>;

export interface InstallContext {
  configFile: string;
  environment: ProcessEnvLike;
  global: boolean;
  label: string;
  legacyProfileFile?: string;
  lockFile: string;
  root: string;
  targets: InstallTarget[];
}
export function isCatalogDirectory(directory: string): boolean;
export function createInstallContext(global: boolean, options?: { cwd?: string; environment?: ProcessEnvLike }): InstallContext;
export function resolveInstallPacks(context: InstallContext, explicitPacks: string[]): Promise<string[]>;
export function previousManagedState(context: InstallContext): Promise<Map<string, { sourceId: string; revision: string }>>;
export function installedPackIds(context: InstallContext): Promise<string[] | null>;
export function installCopies(context: InstallContext, resolvedPacks: ResolvedPacks, io?: Io): Promise<unknown>;
export function writeInstallMetadata(context: InstallContext, resolvedPacks: ResolvedPacks, catalogInfo?: Partial<CatalogInfo> & { packageMetadata?: unknown }): Promise<unknown>;
export function removeAllManagedSkills(context: InstallContext, managed: Map<string, unknown>, io?: Io): Promise<number>;
export function removeSkillDirectories(context: InstallContext, skillNames: string[], io?: Io): Promise<number>;
export function removeInstallationFiles(context: InstallContext): Promise<unknown>;
export function resolveInstallSource(options: { global?: boolean; cwd?: string; environment?: ProcessEnvLike; io?: Io }, opts?: { refresh?: boolean }): Promise<CatalogInfo & { packageMetadata: unknown }>;
export function installPacks(context: InstallContext, explicitPacks?: string[], options?: { io?: Io; onPlan?: (resolvedPacks: ResolvedPacks) => void }): Promise<{ catalogInfo: CatalogInfo; packIds: string[]; resolvedPacks: ResolvedPacks }>;
export function uninstallPacks(context: InstallContext, packArguments?: string[], options?: { io?: Io; onPlan?: (resolvedPacks: ResolvedPacks, removed: string[]) => void }): Promise<{ changed: boolean; removed: string[]; absent: string[]; skippedCommon: boolean; current: string[] | null; resolvedPacks?: ResolvedPacks }>;
export interface InstallStatus {
  groups: SkillGroup[];
  packs: Array<{ id?: string; name?: string } | string>;
  names: string[];
  targets: Array<InstallTarget & { present: number; total: number; complete: boolean }>;
}
export function skillsInstallationStatus(context: InstallContext): Promise<InstallStatus | null>;

export interface DirectSourceState {
  directSources: Array<Source & { skills: string[] }>;
}
export function directRoot(context: InstallContext): string;
export function directLicensesRoot(context: InstallContext): string;
export function readDirectState(context: InstallContext): Promise<DirectSourceState>;
export function writeDirectState(context: InstallContext, state: DirectSourceState): Promise<unknown>;
export function addDirectSkills(context: InstallContext, sourceReference: string, skillNames: string[], options?: { io?: Io }): Promise<{ names: string[]; sourceId: string; revision: string; alreadyInstalled?: boolean }>;
export function removeDirectSkills(context: InstallContext, skillNames: string[]): Promise<string[]>;
export function removeExternalSkills(context: InstallContext, skillNames: string[], options?: { io?: Io }): Promise<{ directRemoved: string[]; removedDirectories: number }>;
```

**重要提示（执行者必读）**：本 d.ts 是给扩展消费的契约，签名必须与 `src/index.mjs` 实际导出逐一对应；若有签名不符（如 `snapshotFiles`/`mergeFiles` 的参数序），以 `packages/core/src/runtime/sessions.mjs` 源码为准修正 d.ts，不要改实现。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`（packaging 新测试通过）→ `npx -y tsc --noEmit packages/core/index.d.ts`（声明文件语法与自洽检查）→ `cd packages/core && npm pack --dry-run --json`（files 清单含 index.d.ts）。
Expected: 全部通过；pack 清单含 `index.d.ts`/`LICENSE`。

- [ ] **Step 5: 版本收尾与 Commit**

`packages/cli/package.json` 的 `version` 改为 `5.8.0`（core 与 cli 独立 semver，此处两者同发 5.8.0）。在 `docs/development.md` 追加一节（T21 细化）：

```markdown
## core 发布纪律

core 变更 → bump `packages/core/package.json` 版本 → `cd packages/core && npm publish`（由维护者执行）→ CLI `npm run sync-core` 照旧。
```

```bash
git add packages/core/index.d.ts packages/cli/package.json test/packaging.test.mjs docs/development.md
git commit -m "feat(core): hand-written type contract index.d.ts; version 5.8.0"
```

- [ ] **Step 6: 发布 gate（用户执行）**

```bash
cd packages/core && npm publish
```

**M1 完成判据**：`npm test` 全绿（68 + 新增测试）；`npm run test:install` 全绿；`npm run pack:cli` 无异常；core 5.8.0 已发布到 npm（用户执行）；CLI 输出与重构前逐字节一致（cli-surface 测试把关）。

---

# M2：VS Code 扩展骨架

> 依赖：core 5.8.0 已发布（M1 Step 6）。packages/vscode 内命令在 `packages/vscode` 目录执行；根命令在仓库根执行。

### Task 10: 扩展工程搭建（build + typecheck + 空视图激活）

**Files:** Create `packages/vscode/package.json`、`tsconfig.json`、`tsconfig.test.json`、`build.mjs`、`.vscodeignore`、`media/icon.svg`、`.vscode/launch.json`、`.vscode/tasks.json`、`src/extension.ts`、`src/views/{agents-view,catalog-view,skills-view}.ts`、`src/views/view-models.ts`（占位返回空数组，T14 替换）；Modify 根 `package.json`（加 `test:vscode` 脚本）

**Interfaces:** Produces: 可构建、可 F5 调试的空扩展（三个空视图 + refresh 命令）；根脚本 `npm run test:vscode`。

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "agenthome-vscode",
  "displayName": "AgentHome",
  "description": "Manage Claude Code, Codex, and OpenCode runtimes and Skills catalogs from VS Code.",
  "version": "0.1.0",
  "publisher": "agenthome",
  "private": true,
  "license": "MIT",
  "type": "module",
  "main": "./dist/extension.js",
  "engines": { "vscode": "^1.90.0" },
  "categories": ["Other"],
  "keywords": ["claude", "codex", "opencode", "skills", "catalog", "agenthome"],
  "activationEvents": [],
  "contributes": {
    "viewsContainers": {
      "activitybar": [{ "id": "agenthome", "title": "AgentHome", "icon": "media/icon.svg" }]
    },
    "views": {
      "agenthome": [
        { "id": "agenthome.agents", "name": "Agents" },
        { "id": "agenthome.catalog", "name": "Catalog" },
        { "id": "agenthome.skills", "name": "Skills" }
      ]
    },
    "commands": [
      { "command": "agenthome.agents.init", "title": "AgentHome: Initialize Agent" },
      { "command": "agenthome.agents.deinit", "title": "AgentHome: Deinitialize Agent" },
      { "command": "agenthome.agents.switchAuth", "title": "AgentHome: Switch Authentication" },
      { "command": "agenthome.agents.switchSessions", "title": "AgentHome: Switch Sessions Mode" },
      { "command": "agenthome.agents.sessionsImport", "title": "AgentHome: Import Sessions" },
      { "command": "agenthome.agents.sessionsWriteback", "title": "AgentHome: Write Back Sessions" },
      { "command": "agenthome.catalog.add", "title": "AgentHome: Add Catalog", "icon": "$(add)" },
      { "command": "agenthome.catalog.select", "title": "AgentHome: Select Catalog" },
      { "command": "agenthome.catalog.sync", "title": "AgentHome: Sync Catalog", "icon": "$(sync)" },
      { "command": "agenthome.catalog.default", "title": "AgentHome: Show Default Catalog" },
      { "command": "agenthome.skills.installPacks", "title": "AgentHome: Install Packs", "icon": "$(cloud-download)" },
      { "command": "agenthome.skills.uninstallPacks", "title": "AgentHome: Uninstall Packs" },
      { "command": "agenthome.skills.addDirect", "title": "AgentHome: Add Skills from Repository" },
      { "command": "agenthome.skills.removeDirect", "title": "AgentHome: Remove Direct Skills" },
      { "command": "agenthome.overview.show", "title": "AgentHome: Overview" },
      { "command": "agenthome.refresh", "title": "AgentHome: Refresh", "icon": "$(refresh)" },
      { "command": "agenthome.doctor", "title": "AgentHome: Doctor" }
    ],
    "menus": {
      "view/title": [
        { "command": "agenthome.refresh", "when": "view == agenthome.agents", "group": "navigation" },
        { "command": "agenthome.catalog.add", "when": "view == agenthome.catalog", "group": "navigation" },
        { "command": "agenthome.catalog.sync", "when": "view == agenthome.catalog", "group": "navigation" },
        { "command": "agenthome.skills.installPacks", "when": "view == agenthome.skills", "group": "navigation" },
        { "command": "agenthome.overview.show", "when": "view == agenthome.agents", "group": "navigation@2" }
      ],
      "view/item/context": [
        { "command": "agenthome.agents.init", "when": "view == agenthome.agents && viewItem == agentNotInitialized" },
        { "command": "agenthome.agents.switchAuth", "when": "view == agenthome.agents && viewItem == agentInitialized" },
        { "command": "agenthome.agents.switchSessions", "when": "view == agenthome.agents && viewItem == agentInitialized" },
        { "command": "agenthome.agents.sessionsImport", "when": "view == agenthome.agents && viewItem == agentInitialized" },
        { "command": "agenthome.agents.sessionsWriteback", "when": "view == agenthome.agents && viewItem == agentInitialized" },
        { "command": "agenthome.agents.deinit", "when": "view == agenthome.agents && viewItem == agentInitialized" },
        { "command": "agenthome.catalog.select", "when": "view == agenthome.catalog && viewItem == catalogEntry" },
        { "command": "agenthome.catalog.default", "when": "view == agenthome.catalog && viewItem == catalogEntry" },
        { "command": "agenthome.skills.installPacks", "when": "view == agenthome.skills && viewItem == scopeNode" },
        { "command": "agenthome.skills.uninstallPacks", "when": "view == agenthome.skills && viewItem == scopeNode" },
        { "command": "agenthome.skills.addDirect", "when": "view == agenthome.skills && viewItem == scopeNode" },
        { "command": "agenthome.skills.removeDirect", "when": "view == agenthome.skills && viewItem == scopeNode" }
      ]
    }
  },
  "scripts": {
    "build": "node build.mjs",
    "typecheck": "tsc -p tsconfig.json",
    "build:test": "tsc -p tsconfig.test.json",
    "test": "npm run build:test && node --test dist-test/",
    "package": "vsce package"
  },
  "devDependencies": {
    "@agenthome/core": "^5.8.0",
    "@types/node": "^20.14.0",
    "@types/vscode": "^1.90.0",
    "@vscode/vsce": "^2.26.0",
    "esbuild": "^0.21.5",
    "typescript": "^5.4.5"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json / tsconfig.test.json / build.mjs / .vscodeignore / icon**

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "lib": ["ES2022"],
    "strict": true,
    "noEmit": true,
    "types": ["node"],
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
```

`tsconfig.test.json`：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist-test",
    "rootDir": ".",
    "sourceMap": true
  },
  "include": ["src", "test"]
}
```

`build.mjs`：

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
  logLevel: "info",
});
```

`.vscodeignore`：

```
.vscode/**
src/**
test/**
node_modules/**
*.map
build.mjs
tsconfig.json
tsconfig.test.json
.gitignore
```

`media/icon.svg`（占位，简单徽标）：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">
  <circle cx="12" cy="12" r="10" fill="#2D9CDB"/>
  <path d="M7 12.5l3.2 3L17 9" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
```

- [ ] **Step 3: 创建 src 骨架**

`src/extension.ts`：

```ts
import * as vscode from "vscode";
import { AgentsTreeProvider } from "./views/agents-view.js";
import { CatalogTreeProvider } from "./views/catalog-view.js";
import { SkillsTreeProvider } from "./views/skills-view.js";

export function activate(context: vscode.ExtensionContext): void {
  const agents = new AgentsTreeProvider();
  const catalog = new CatalogTreeProvider();
  const skills = new SkillsTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("agenthome.agents", agents),
    vscode.window.registerTreeDataProvider("agenthome.catalog", catalog),
    vscode.window.registerTreeDataProvider("agenthome.skills", skills),
    vscode.commands.registerCommand("agenthome.refresh", () => {
      agents.refresh();
      catalog.refresh();
      skills.refresh();
    }),
    vscode.commands.registerCommand("agenthome.overview.show", () => {
      void vscode.window.showInformationMessage("AgentHome Overview 将在 M4 提供");
    }),
  );
}

export function deactivate(): void {}
```

`src/views/view-models.ts`（占位，T14 替换）：

```ts
export function emptyNodes(): never[] {
  return [];
}
```

三个 provider（模式相同，以 agents-view.ts 为例；catalog-view.ts / skills-view.ts 同构，类名与视图 id 对应）：

```ts
import * as vscode from "vscode";
import { emptyNodes } from "./view-models.js";

export class AgentsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly onChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onChange.event;

  refresh(): void {
    this.onChange.fire();
  }

  getChildren(): vscode.TreeItem[] {
    return emptyNodes();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }
}
```

`.vscode/launch.json`（仓库内，供 F5；被 .vscodeignore 排除出包）：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "preLaunchTask": "npm: build"
    }
  ]
}
```

`.vscode/tasks.json`：

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "type": "npm",
      "script": "build",
      "group": "build",
      "problemMatcher": [],
      "label": "npm: build"
    }
  ]
}
```

根 `package.json` 的 scripts 加：`"test:vscode": "npm test --prefix packages/vscode"`（**不要**加 workspaces）。

- [ ] **Step 4: 安装依赖并验证构建**

Run（packages/vscode 下）：

```bash
npm install
npm run typecheck
npm run build
node -e "import('node:fs').then(({existsSync}) => { if (!existsSync('dist/extension.js')) process.exit(1); console.log('dist/extension.js built') })"
```

Expected: typecheck 无错误；`dist/extension.js` 生成。（本任务尚无测试文件，`npm test` 从 T11 起才有用例可用。）

- [ ] **Step 5: 冒烟（手动，开发宿主）**

在 VS Code 打开 `packages/vscode` 目录，按 F5（Extension Development Host）→ 侧边栏出现 AgentHome 容器与三个空视图；`agenthome.refresh` 命令可执行无报错。

- [ ] **Step 6: Commit**

```bash
git add packages/vscode package.json
git commit -m "chore(vscode): extension scaffold — esbuild build, empty tree views, dev host"
```

### Task 11: 项目根解析（project.ts）

**Files:** Create `packages/vscode/src/project.ts`；Test: Create `packages/vscode/test/project.test.ts`

**Interfaces:** Produces: `resolveProjectRoot(workspaceFolders: readonly string[], stored?: string): string | null`——单根直接用唯一 Workspace Folder；多根时用已记住且仍存在的根；否则 null（由 UI 层弹 QuickPick，不使用活动文件）。

- [ ] **Step 1: 写失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { resolveProjectRoot } from "../src/project.js";

test("resolveProjectRoot prefers the only workspace folder", () => {
  assert.equal(resolveProjectRoot(["D:/work/proj"]), "D:/work/proj");
});

test("resolveProjectRoot uses the remembered folder in multi-root workspaces", () => {
  const folders = ["D:/work/a", "D:/work/b"];
  assert.equal(resolveProjectRoot(folders), null);
  assert.equal(resolveProjectRoot(folders, "D:/work/b"), "D:/work/b");
});

test("resolveProjectRoot ignores a stale remembered folder", () => {
  assert.equal(resolveProjectRoot(["D:/work/a", "D:/work/b"], "D:/work/gone"), null);
});
```

- [ ] **Step 2: 跑测试确认失败** → Run: `npm run build:test && node --test dist-test/`（packages/vscode 下）→ FAIL（模块不存在）。

- [ ] **Step 3: 最小实现**

```ts
export function resolveProjectRoot(workspaceFolders: readonly string[], stored?: string): string | null {
  if (workspaceFolders.length === 1) {
    return workspaceFolders[0];
  }
  if (stored && workspaceFolders.includes(stored)) {
    return stored;
  }
  return null;
}
```

- [ ] **Step 4: 跑测试确认通过** → `npm test`（packages/vscode 下）→ PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/vscode/src/project.ts packages/vscode/test/project.test.ts
git commit -m "feat(vscode): project root resolution — single folder direct, multi-root remembered"
```

### Task 12: agents service

**Files:** Create `packages/vscode/src/services/agents.ts`；Test: Create `packages/vscode/test/agents.test.ts`

**Interfaces:** Produces（后续任务依赖这些签名）：

```ts
export interface AgentStatus {
  id: string;
  displayName: string;
  initialized: boolean;
  auth: string | null;
  sessions: string | null;
  configuredAuth: string | null;
  localAuth: string | null;
  executableAvailable: boolean;
}
export function getAgentStatus(projectRoot: string, agentId: string, environment: NodeJS.ProcessEnv): Promise<AgentStatus>;
export function initializeAgentRuntime(projectRoot: string, agentId: string, authMode: "global" | "project" | undefined, sessionsMode: "global" | "project" | undefined): Promise<unknown>;
export function deinitializeAgentRuntime(projectRoot: string, agentId: string, purge: boolean): Promise<unknown>;
export function switchAgentAuth(projectRoot: string, agentId: string, mode: "global" | "project" | "reset"): Promise<unknown>;
export function switchAgentSessions(projectRoot: string, agentId: string, mode: "global" | "project"): Promise<unknown>;
export function importSessions(projectRoot: string, agentId: string, environment: NodeJS.ProcessEnv): Promise<unknown>;
export function writebackSessions(projectRoot: string, agentId: string, environment: NodeJS.ProcessEnv): Promise<unknown>;
```

- [ ] **Step 1: 写失败测试（用真实 core + 临时目录，不 import vscode）**

```ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getAgentStatus,
  importSessions,
  initializeAgentRuntime,
  switchAgentAuth,
  switchAgentSessions,
  writebackSessions,
} from "../src/services/agents.js";

test("agents service reads and mutates runtime state via core", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vscode-agents-"));
  try {
    const environment = { ...process.env, PATH: "" };
    const before = await getAgentStatus(root, "claude", environment);
    assert.equal(before.initialized, false);
    assert.equal(before.executableAvailable, false);

    await initializeAgentRuntime(root, "claude", "global", "project");
    const initialized = await getAgentStatus(root, "claude", environment);
    assert.equal(initialized.initialized, true);
    assert.equal(initialized.auth, "global");
    assert.equal(initialized.sessions, "project");

    await switchAgentAuth(root, "claude", "project");
    const overridden = await getAgentStatus(root, "claude", environment);
    assert.equal(overridden.auth, "project");
    assert.equal(overridden.localAuth, "project");

    await switchAgentSessions(root, "claude", "global");
    const switched = await getAgentStatus(root, "claude", environment);
    assert.equal(switched.sessions, "global");
    assert.equal(switched.auth, "project");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agents service import/writeback delegate to the session adapter", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vscode-sessions-"));
  try {
    await initializeAgentRuntime(root, "codex", "global", "project");
    const isolated = { ...process.env, CODEX_HOME: path.join(root, "native") };
    const imported = await importSessions(root, "codex", isolated) as { count: number };
    assert.equal(typeof imported.count, "number");
    const written = await writebackSessions(root, "codex", isolated) as { added: number; updated: number };
    assert.equal(typeof written.added, "number");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败** → `npm test`（packages/vscode）→ FAIL。

- [ ] **Step 3: 最小实现**

```ts
import {
  agentExecutableAvailable,
  clearLocalAuth,
  deinitializeAgent,
  effectiveAgentConfig,
  getAgent,
  getSessionAdapter,
  initializeAgent,
  loadRuntime,
  setLocalAuth,
} from "@agenthome/core";

export interface AgentStatus {
  id: string;
  displayName: string;
  initialized: boolean;
  auth: string | null;
  sessions: string | null;
  configuredAuth: string | null;
  localAuth: string | null;
  executableAvailable: boolean;
}

export async function getAgentStatus(projectRoot: string, agentId: string, environment: NodeJS.ProcessEnv): Promise<AgentStatus> {
  const agent = getAgent(agentId);
  const state = await loadRuntime(projectRoot);
  const config = effectiveAgentConfig(state, agentId);
  return {
    id: agentId,
    displayName: agent.displayName,
    initialized: Boolean(config),
    auth: config?.auth ?? null,
    sessions: config?.sessions ?? null,
    configuredAuth: config?.configuredAuth ?? null,
    localAuth: config?.localAuth ?? null,
    executableAvailable: agentExecutableAvailable(agentId, environment),
  };
}

export async function initializeAgentRuntime(projectRoot: string, agentId: string, authMode?: "global" | "project", sessionsMode?: "global" | "project"): Promise<unknown> {
  return initializeAgent(projectRoot, agentId, authMode, sessionsMode);
}

export async function deinitializeAgentRuntime(projectRoot: string, agentId: string, purge: boolean): Promise<unknown> {
  return deinitializeAgent(projectRoot, agentId, { purge });
}

export async function switchAgentAuth(projectRoot: string, agentId: string, mode: "global" | "project" | "reset"): Promise<unknown> {
  return mode === "reset" ? clearLocalAuth(projectRoot, agentId) : setLocalAuth(projectRoot, agentId, mode);
}

export async function switchAgentSessions(projectRoot: string, agentId: string, mode: "global" | "project"): Promise<unknown> {
  return initializeAgent(projectRoot, agentId, undefined, mode);
}

export async function importSessions(projectRoot: string, agentId: string, environment: NodeJS.ProcessEnv): Promise<unknown> {
  return getSessionAdapter(agentId).capture(projectRoot, { environment });
}

export async function writebackSessions(projectRoot: string, agentId: string, environment: NodeJS.ProcessEnv): Promise<unknown> {
  return getSessionAdapter(agentId).restore(projectRoot, { environment });
}
```

（若 d.ts 与实现签名有出入导致 typecheck 报错，修 `packages/core/index.d.ts` 并单独提交 `fix(core): align index.d.ts`。）

- [ ] **Step 4: 跑测试确认通过** → `npm test`（packages/vscode）→ PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/vscode/src/services/agents.ts packages/vscode/test/agents.test.ts
git commit -m "feat(vscode): agents service — status, init, auth and sessions switches"
```

### Task 13: skills + catalog services

**Files:** Create `packages/vscode/src/services/skills.ts`、`packages/vscode/src/services/catalog.ts`；Test: Create `packages/vscode/test/skills-service.test.ts`、`packages/vscode/test/catalog-service.test.ts`

**Interfaces:** Produces:

```ts
// skills.ts
export type SkillScope = "project" | "global";
export interface SkillsStatus {
  project: ScopeStatus;
  global: ScopeStatus;
}
export interface ScopeStatus {
  context: InstallContext;
  installedPacks: string[] | null;
  status: InstallStatus | null;
  direct: DirectSourceState;
}
export function getSkillsStatus(projectRoot: string, environment: NodeJS.ProcessEnv): Promise<SkillsStatus>;
export function installPacksInto(projectRoot: string, packIds: string[], scope: SkillScope, environment: NodeJS.ProcessEnv, io: Io, onPlan?: (resolvedPacks: ResolvedPacks) => void): Promise<unknown>;
export function uninstallPacksFrom(projectRoot: string, packIds: string[], scope: SkillScope, environment: NodeJS.ProcessEnv, io: Io, onPlan?: (resolvedPacks: ResolvedPacks, removed: string[]) => void): Promise<unknown>;
export function addDirectSkill(projectRoot: string, repository: string, skillNames: string[], scope: SkillScope, environment: NodeJS.ProcessEnv, io: Io): Promise<unknown>;
export function removeExternalSkill(projectRoot: string, skillNames: string[], scope: SkillScope, environment: NodeJS.ProcessEnv, io: Io): Promise<unknown>;
export function discoverRepositorySkills(repository: string, directory: string): Promise<string[]>;
// catalog.ts
export interface CatalogState { current: string; known: KnownCatalogEntry[]; }
export interface CatalogAddResult { spec: string; catalogInfo?: CatalogInfo; packs: Pack[]; previewFailed: boolean; error?: Error; }
export interface CatalogPacks { packs: Array<{ id: string; name: string; skills: string[] }>; }
export function getCatalogState(environment: NodeJS.ProcessEnv): Promise<CatalogState>;
export function addCatalog(spec: string, environment: NodeJS.ProcessEnv, io: Io): Promise<CatalogAddResult>;
export function selectCatalog(spec: string, environment: NodeJS.ProcessEnv): Promise<void>;
export function syncCatalog(environment: NodeJS.ProcessEnv, io: Io): Promise<CatalogInfo>;
export function getCatalogPacks(environment: NodeJS.ProcessEnv, io?: Io): Promise<CatalogPacks | null>;
```

- [ ] **Step 1: 写失败测试**

`test/skills-service.test.ts`（git init 的本地 catalog 仓库 fixture，含 s/s2 两个 Skill 与 common/development 两个 Pack）：

```ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setDefaultCatalogSpec } from "@agenthome/core";
import {
  addDirectSkill,
  discoverRepositorySkills,
  getSkillsStatus,
  installPacksInto,
  removeExternalSkill,
  uninstallPacksFrom,
} from "../src/services/skills.js";

function git(cwd: string, argumentsList: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...argumentsList], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr ?? undefined);
  return result.stdout.trim();
}

async function fixtureCatalog(root: string): Promise<void> {
  await mkdir(path.join(root, "skills", "s"), { recursive: true });
  await mkdir(path.join(root, "skills", "s2"), { recursive: true });
  await mkdir(path.join(root, "packs"), { recursive: true });
  await writeFile(path.join(root, "skills", "s", "SKILL.md"), "---\nname: s\n---\nv1\n");
  await writeFile(path.join(root, "skills", "s2", "SKILL.md"), "---\nname: s2\n---\nv1\n");
  await writeFile(path.join(root, "packs", "common.json"), `${JSON.stringify({ schemaVersion: 1, id: "common", name: "Common", sources: [{ source: "s", skills: ["s"] }] })}\n`);
  await writeFile(path.join(root, "packs", "development.json"), `${JSON.stringify({ schemaVersion: 1, id: "development", name: "Development", sources: [{ source: "s", skills: ["s2"] }] })}\n`);
  await writeFile(path.join(root, "sources.lock.json"), `${JSON.stringify({ schemaVersion: 1, sources: [{ id: "s", name: "S", repository: "https://github.com/example/s.git", skillRoot: "skills", revision: "a".repeat(40) }] })}\n`);
  git(root, ["init", "--quiet", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "--quiet", "-m", "one"]);
}

test("skills service installs, reports, and uninstalls packs via core", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vscode-skills-"));
  try {
    const state = path.join(root, "state");
    const catalog = path.join(root, "catalog");
    await fixtureCatalog(catalog);
    const environment = { ...process.env, AGENTHOME_STATE_DIR: state };
    await setDefaultCatalogSpec(environment, catalog);
    const io = { log(): void {} };

    const before = await getSkillsStatus(root, environment);
    assert.equal(before.project.status, null);

    await installPacksInto(root, ["development"], "project", environment, io);
    const installed = await getSkillsStatus(root, environment);
    assert.deepEqual(installed.project.installedPacks, ["common", "development"]);
    assert.equal(installed.project.status?.targets[0].complete, true);

    await uninstallPacksFrom(root, ["development"], "project", environment, io);
    const after = await getSkillsStatus(root, environment);
    assert.deepEqual(after.project.installedPacks, ["common"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skills service discovers and adds direct skills", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vscode-direct-"));
  try {
    const environment = { ...process.env, AGENTHOME_STATE_DIR: path.join(root, "state") };
    const repo = path.join(root, "repo");
    await fixtureCatalog(repo);
    const names = await discoverRepositorySkills(repo, path.join(root, "clone"));
    assert.deepEqual([...names].sort(), ["s", "s2"]);
    await addDirectSkill(root, repo, ["s"], "project", environment, { log(): void {} });
    const status = await getSkillsStatus(root, environment);
    assert.equal(status.project.direct.directSources.length, 1);
    await removeExternalSkill(root, ["s"], "project", environment, { log(): void {} });
    const cleared = await getSkillsStatus(root, environment);
    assert.equal(cleared.project.direct.directSources.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

`test/catalog-service.test.ts`：

```ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setDefaultCatalogSpec } from "@agenthome/core";
import { addCatalog, getCatalogPacks, getCatalogState, selectCatalog } from "../src/services/catalog.js";

test("catalog service registers, selects, and reports catalogs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vscode-catalog-"));
  try {
    const environment = { ...process.env, AGENTHOME_STATE_DIR: path.join(root, "state") };
    const missing = path.join(root, "missing-catalog");
    await addCatalog(missing, environment, { log(): void {} });
    const state = await getCatalogState(environment);
    assert.equal(state.current, missing);
    assert.equal(state.known[0].spec, missing);
    await selectCatalog("Echo-Kang-hub/agenthome-catalog#main", environment);
    assert.equal((await getCatalogState(environment)).current, "Echo-Kang-hub/agenthome-catalog#main");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("getCatalogPacks returns null when the catalog cannot be loaded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vscode-catalog-packs-"));
  try {
    const environment = { ...process.env, AGENTHOME_STATE_DIR: path.join(root, "state") };
    await setDefaultCatalogSpec(environment, path.join(root, "missing-catalog"));
    assert.equal(await getCatalogPacks(environment), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败** → `npm test`（packages/vscode）→ FAIL。

- [ ] **Step 3: 最小实现**

`src/services/skills.ts`：

```ts
import {
  addDirectSkills,
  cloneHead,
  createInstallContext,
  deriveSourceId,
  detectSkillRoot,
  discoverSourceSkills,
  installedPackIds,
  installPacks,
  normalizeRepositoryInput,
  readDirectState,
  removeExternalSkills,
  skillsInstallationStatus,
  uninstallPacks,
  type DirectSourceState,
  type InstallContext,
  type InstallStatus,
  type Io,
  type ResolvedPacks,
} from "@agenthome/core";

export type SkillScope = "project" | "global";

export interface ScopeStatus {
  context: InstallContext;
  installedPacks: string[] | null;
  status: InstallStatus | null;
  direct: DirectSourceState;
}

export interface SkillsStatus {
  project: ScopeStatus;
  global: ScopeStatus;
}

function skillsContext(projectRoot: string, global: boolean, environment: NodeJS.ProcessEnv): InstallContext {
  return createInstallContext(global, { cwd: projectRoot, environment });
}

export async function getSkillsStatus(projectRoot: string, environment: NodeJS.ProcessEnv): Promise<SkillsStatus> {
  const project = skillsContext(projectRoot, false, environment);
  const global = skillsContext(projectRoot, true, environment);
  return {
    project: {
      context: project,
      installedPacks: await installedPackIds(project),
      status: await skillsInstallationStatus(project),
      direct: await readDirectState(project),
    },
    global: {
      context: global,
      installedPacks: await installedPackIds(global),
      status: await skillsInstallationStatus(global),
      direct: await readDirectState(global),
    },
  };
}

export async function installPacksInto(projectRoot: string, packIds: string[], scope: SkillScope, environment: NodeJS.ProcessEnv, io: Io, onPlan?: (resolvedPacks: ResolvedPacks) => void): Promise<unknown> {
  return installPacks(skillsContext(projectRoot, scope === "global", environment), packIds, { io, onPlan });
}

export async function uninstallPacksFrom(projectRoot: string, packIds: string[], scope: SkillScope, environment: NodeJS.ProcessEnv, io: Io, onPlan?: (resolvedPacks: ResolvedPacks, removed: string[]) => void): Promise<unknown> {
  return uninstallPacks(skillsContext(projectRoot, scope === "global", environment), packIds, { io, onPlan });
}

export async function addDirectSkill(projectRoot: string, repository: string, skillNames: string[], scope: SkillScope, environment: NodeJS.ProcessEnv, io: Io): Promise<unknown> {
  return addDirectSkills(skillsContext(projectRoot, scope === "global", environment), repository, skillNames, { io });
}

export async function removeExternalSkill(projectRoot: string, skillNames: string[], scope: SkillScope, environment: NodeJS.ProcessEnv, io: Io): Promise<unknown> {
  return removeExternalSkills(skillsContext(projectRoot, scope === "global", environment), skillNames, { io });
}

// Read-only preview for the picker: clone the repository and list its Skill
// names. Installation still goes through addDirectSkills, which repeats the
// discovery with its own validation.
export async function discoverRepositorySkills(repository: string, directory: string): Promise<string[]> {
  const normalized = normalizeRepositoryInput(repository);
  const source = {
    id: deriveSourceId(normalized),
    name: repository.replace(/\.git$/i, ""),
    repository: normalized,
    revision: "",
    skillRoot: "",
  };
  await cloneHead({ repository: normalized }, directory);
  source.skillRoot = await detectSkillRoot(directory);
  const discovered = await discoverSourceSkills(source, directory);
  return discovered.names;
}
```

`src/services/catalog.ts`：

```ts
import {
  ensureCatalog,
  loadDefaultCatalogSpec,
  loadKnownCatalogs,
  loadPacks,
  registerCatalog,
  setDefaultCatalogSpec,
  type CatalogInfo,
  type Io,
  type KnownCatalogEntry,
  type Pack,
} from "@agenthome/core";

export interface CatalogState {
  current: string;
  known: KnownCatalogEntry[];
}

export interface CatalogAddResult {
  spec: string;
  catalogInfo?: CatalogInfo;
  packs: Pack[];
  previewFailed: boolean;
  error?: Error;
}

export interface CatalogPacks {
  packs: Array<{ id: string; name: string; skills: string[] }>;
}

export async function getCatalogState(environment: NodeJS.ProcessEnv): Promise<CatalogState> {
  const current = await loadDefaultCatalogSpec(environment);
  const known = await loadKnownCatalogs(environment);
  return { current, known };
}

export async function addCatalog(spec: string, environment: NodeJS.ProcessEnv, io: Io): Promise<CatalogAddResult> {
  return registerCatalog(spec, { environment, io });
}

export async function selectCatalog(spec: string, environment: NodeJS.ProcessEnv): Promise<void> {
  await setDefaultCatalogSpec(environment, spec);
}

export async function syncCatalog(environment: NodeJS.ProcessEnv, io: Io): Promise<CatalogInfo> {
  const spec = await loadDefaultCatalogSpec(environment);
  return ensureCatalog(spec, { environment, io });
}

// Browse the catalog's Packs and their Skills for the tree view. Returns
// null when the catalog cannot be loaded (offline, missing credentials) so
// the view can still show the installed state.
export async function getCatalogPacks(environment: NodeJS.ProcessEnv, io?: Io): Promise<CatalogPacks | null> {
  try {
    const spec = await loadDefaultCatalogSpec(environment);
    const info = await ensureCatalog(spec, { environment, io: io ?? { log() {} } });
    const packs = [...(await loadPacks(info.catalogRoot)).values()];
    return {
      packs: packs.map((pack) => ({
        id: pack.id,
        name: pack.name,
        skills: pack.sources.flatMap((selection) => selection.skills),
      })),
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 跑测试确认通过** → `npm test`（packages/vscode）→ PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/vscode/src/services/skills.ts packages/vscode/src/services/catalog.ts packages/vscode/test/skills-service.test.ts packages/vscode/test/catalog-service.test.ts
git commit -m "feat(vscode): skills and catalog services — thin typed wrappers over core"
```

### Task 14: 视图模型与三个 TreeView（含 Catalog Packs 展开浏览）

**Files:** Rewrite `packages/vscode/src/views/view-models.ts`；Rewrite `packages/vscode/src/views/{agents-view,catalog-view,skills-view}.ts`；Test: Create `packages/vscode/test/view-models.test.ts`

**Interfaces:** Produces: 纯函数视图模型（无 vscode import）+ 三个 provider 接线 services。节点类型供 M3 命令使用：

```ts
export interface AgentNode { id: string; label: string; description?: string; tooltip?: string; icon: "ok" | "none"; contextValue: "agentInitialized" | "agentNotInitialized"; }
export function agentNodes(statuses: AgentStatus[]): AgentNode[];
export interface CatalogNode { id: string; label: string; description?: string; tooltip?: string; contextValue: "catalogEntry"; current: boolean; }
export function catalogNodes(state: CatalogState, revision?: string | null): CatalogNode[];
export interface SkillsNode { id: string; kind: "scope" | "packs" | "catalogPack" | "catalogSkill" | "direct"; scope: SkillScope; label: string; description?: string; tooltip?: string; contextValue: string; packId?: string; installed?: boolean; }
export function skillsNodes(status: SkillsStatus, catalog: CatalogPacks | null): SkillsNode[];
export function skillsChildren(status: SkillsStatus, node: SkillsNode, catalog: CatalogPacks | null): SkillsNode[];
```

Spec 5.1 要求：Agents 每 Agent 一行（详情进 tooltip）；Catalog 当前 catalog 名 + revision；Skills 两个作用域分组，每组三块（已装 Packs、Catalog Packs 展开看 Skill 清单含已装标记、直装 Skills）。

- [ ] **Step 1: 写失败测试（纯数据断言）**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { agentNodes, catalogNodes, skillsChildren, skillsNodes } from "../src/views/view-models.js";
import type { AgentStatus } from "../src/services/agents.js";
import type { CatalogPacks, CatalogState } from "../src/services/catalog.js";
import type { ScopeStatus, SkillsStatus } from "../src/services/skills.js";

function fakeScopeStatus(overrides: Partial<ScopeStatus> = {}): ScopeStatus {
  return {
    context: {} as never,
    installedPacks: null,
    status: null,
    direct: { directSources: [] },
    ...overrides,
  } as ScopeStatus;
}

test("agentNodes maps statuses to minimal tree nodes", () => {
  const statuses: AgentStatus[] = [
    { id: "claude", displayName: "Claude Code", initialized: true, auth: "project", sessions: "project", configuredAuth: "global", localAuth: "project", executableAvailable: true },
    { id: "codex", displayName: "Codex", initialized: false, auth: null, sessions: null, configuredAuth: null, localAuth: null, executableAvailable: false },
  ];
  const nodes = agentNodes(statuses);
  assert.equal(nodes[0].label, "Claude Code");
  assert.equal(nodes[0].contextValue, "agentInitialized");
  assert.match(nodes[0].tooltip ?? "", /Auth: project/);
  assert.equal(nodes[1].description, "未初始化");
  assert.equal(nodes[1].contextValue, "agentNotInitialized");
});

test("catalogNodes marks the current catalog and shows the revision", () => {
  const state: CatalogState = { current: "https://example.com/b.git#main", known: [{ name: "a", spec: "owner/a#main" }, { name: "b", spec: "https://example.com/b.git#main" }] };
  const nodes = catalogNodes(state, "1234567890abcdef".repeat(2).slice(0, 40));
  assert.equal(nodes.filter((n) => n.current).length, 1);
  assert.match(nodes[1].description ?? "", /当前 · 12345678/);
});

test("skillsNodes and skillsChildren render catalog packs with installed marks", () => {
  const status: SkillsStatus = {
    project: fakeScopeStatus({
      installedPacks: ["common"],
      status: { groups: [], packs: [], names: ["s"], targets: [] },
    }),
    global: fakeScopeStatus(),
  };
  const catalog: CatalogPacks = {
    packs: [
      { id: "common", name: "Common", skills: ["s"] },
      { id: "development", name: "Development", skills: ["s2"] },
    ],
  };
  const scopes = skillsNodes(status, catalog);
  assert.equal(scopes.filter((node) => node.kind === "scope").length, 2);
  const children = skillsChildren(status, scopes[0], catalog);
  const packNodes = children.filter((node) => node.kind === "catalogPack");
  assert.equal(packNodes.length, 2);
  assert.deepEqual(skillsChildren(status, packNodes[0], catalog).map((node) => node.installed), [true]);
  assert.deepEqual(skillsChildren(status, packNodes[1], catalog).map((node) => node.installed), [false]);
});
```

- [ ] **Step 2: 跑测试确认失败** → `npm test`（packages/vscode）→ FAIL（emptyNodes 不满足）。

- [ ] **Step 3: 最小实现**

`view-models.ts`：

```ts
import path from "node:path";
import type { AgentStatus } from "../services/agents.js";
import type { CatalogPacks, CatalogState } from "../services/catalog.js";
import type { SkillsStatus, SkillScope } from "../services/skills.js";

export interface AgentNode {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon: "ok" | "none";
  contextValue: "agentInitialized" | "agentNotInitialized";
}

export function agentNodes(statuses: AgentStatus[]): AgentNode[] {
  return statuses.map((status) => ({
    id: status.id,
    label: status.displayName,
    description: status.initialized ? `已初始化 · ${status.auth}` : "未初始化",
    tooltip: status.initialized
      ? [
          `Auth: ${status.auth}（配置 ${status.configuredAuth}${status.localAuth ? `，覆盖 ${status.localAuth}` : ""}）`,
          `Sessions: ${status.sessions}`,
          `官方 CLI: ${status.executableAvailable ? "可用" : "未找到"}`,
        ].join("\n")
      : "运行初始化向导（右键或命令面板）",
    icon: status.initialized ? "ok" : "none",
    contextValue: status.initialized ? "agentInitialized" : "agentNotInitialized",
  }));
}

export interface CatalogNode {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  contextValue: "catalogEntry";
  current: boolean;
}

export function catalogNodes(state: CatalogState, revision: string | null = null): CatalogNode[] {
  return state.known.map((entry) => ({
    id: entry.spec,
    label: entry.name,
    description: entry.spec === state.current ? (revision ? `当前 · ${revision.slice(0, 8)}` : "当前") : entry.spec,
    tooltip: entry.spec,
    contextValue: "catalogEntry",
    current: entry.spec === state.current,
  }));
}

export interface SkillsNode {
  id: string;
  kind: "scope" | "packs" | "catalogPack" | "catalogSkill" | "direct";
  scope: SkillScope;
  label: string;
  description?: string;
  tooltip?: string;
  contextValue: string;
  packId?: string;
  installed?: boolean;
}

export function skillsNodes(status: SkillsStatus, catalog: CatalogPacks | null): SkillsNode[] {
  return [
    {
      id: "project",
      kind: "scope",
      scope: "project",
      label: "项目",
      description: path.basename(status.project.context.root),
      tooltip: status.project.context.root,
      contextValue: "scopeNode",
    },
    {
      id: "global",
      kind: "scope",
      scope: "global",
      label: "全局",
      description: "本机所有项目",
      tooltip: status.global.context.root,
      contextValue: "scopeNode",
    },
  ];
}

export function skillsChildren(status: SkillsStatus, node: SkillsNode, catalog: CatalogPacks | null): SkillsNode[] {
  if (node.kind === "catalogPack") {
    const pack = catalog?.packs.find((candidate) => candidate.id === node.packId);
    if (!pack) return [];
    const scopeStatus = status[node.scope];
    const installed = new Set([
      ...(scopeStatus.status?.names ?? []),
      ...scopeStatus.direct.directSources.flatMap((source) => source.skills),
    ]);
    return pack.skills.map((name) => ({
      id: `${node.scope}:catalog:${pack.id}:${name}`,
      kind: "catalogSkill",
      scope: node.scope,
      packId: pack.id,
      label: name,
      installed: installed.has(name),
      contextValue: "catalogSkillNode",
    }));
  }
  if (node.kind !== "scope") {
    return [];
  }
  const scopeStatus = status[node.scope];
  const directCount = scopeStatus.direct.directSources.flatMap((source) => source.skills).length;
  const packNodes: SkillsNode[] = (catalog?.packs ?? []).map((pack) => ({
    id: `${node.scope}:catalog:${pack.id}`,
    kind: "catalogPack",
    scope: node.scope,
    packId: pack.id,
    label: pack.name,
    description: `${pack.skills.length} Skills`,
    tooltip: pack.skills.join(", "),
    contextValue: "catalogPackNode",
  }));
  return [
    {
      id: `${node.scope}:packs`,
      kind: "packs",
      scope: node.scope,
      label: "已装 Packs",
      description: scopeStatus.installedPacks ? scopeStatus.installedPacks.join(" + ") : "未安装",
      tooltip: scopeStatus.installedPacks?.join(", ") ?? "运行 'Install Packs' 安装",
      contextValue: "packNode",
    },
    ...packNodes,
    {
      id: `${node.scope}:direct`,
      kind: "direct",
      scope: node.scope,
      label: "直装 Skills",
      description: `${directCount} 个`,
      contextValue: "directNode",
    },
  ];
}
```

三个 provider 重写（模式：从 services 取数 → view-models → TreeItem）。

`agents-view.ts`：

```ts
import * as vscode from "vscode";
import { AGENTS } from "@agenthome/core";
import { agentNodes, type AgentNode } from "./view-models.js";
import { getAgentStatus } from "../services/agents.js";
import { resolveProjectRoot } from "../project.js";

export class AgentsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly onChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onChange.event;

  refresh(): void {
    this.onChange.fire();
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    const root = resolveProjectRoot((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath));
    if (!root) {
      const item = new vscode.TreeItem("请选择工作区文件夹（多根工作区需要指定项目）");
      item.tooltip = "运行任一 AgentHome 命令并选择项目，或打开单根工作区";
      return [item];
    }
    const statuses = await Promise.all(
      Object.keys(AGENTS).map((agentId) => getAgentStatus(root, agentId, process.env)),
    );
    return agentNodes(statuses).map(toTreeItem);
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }
}

function toTreeItem(node: AgentNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
  item.id = node.id;
  item.description = node.description;
  item.tooltip = node.tooltip;
  item.contextValue = node.contextValue;
  item.iconPath = node.icon === "ok" ? new vscode.ThemeIcon("check") : new vscode.ThemeIcon("circle-outline");
  return item;
}
```

`catalog-view.ts`：

```ts
import * as vscode from "vscode";
import { catalogNodes, type CatalogNode } from "./view-models.js";
import { getCatalogState } from "../services/catalog.js";

export class CatalogTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly onChange = new vscode.EventEmitter<void>();
  private lastSyncRevision: string | null = null;
  readonly onDidChangeTreeData = this.onChange.event;

  refresh(): void {
    this.onChange.fire();
  }

  setLastSync(revision: string | null): void {
    this.lastSyncRevision = revision;
    this.refresh();
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    const state = await getCatalogState(process.env);
    return catalogNodes(state, this.lastSyncRevision).map(toTreeItem);
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }
}

function toTreeItem(node: CatalogNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
  item.id = node.id;
  item.description = node.description;
  item.tooltip = node.tooltip;
  item.contextValue = node.contextValue;
  item.iconPath = new vscode.ThemeIcon(node.current ? "check" : "circle-outline");
  return item;
}
```

`skills-view.ts`：

```ts
import * as vscode from "vscode";
import { getCatalogPacks } from "../services/catalog.js";
import { getSkillsStatus } from "../services/skills.js";
import { resolveProjectRoot } from "../project.js";
import { skillsChildren, skillsNodes, type SkillsNode } from "./view-models.js";

export class SkillsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly onChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onChange.event;

  refresh(): void {
    this.onChange.fire();
  }

  async getChildren(element?: SkillsNode): Promise<vscode.TreeItem[]> {
    const root = resolveProjectRoot((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath));
    if (!root) {
      const item = new vscode.TreeItem("请选择工作区文件夹");
      item.tooltip = "多根工作区需要指定项目；运行 AgentHome 命令选择一次";
      return [item];
    }
    const status = await getSkillsStatus(root, process.env);
    const catalog = await getCatalogPacks(process.env);
    const nodes = element ? skillsChildren(status, element, catalog) : skillsNodes(status, catalog);
    return nodes.map(toTreeItem);
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }
}

function toTreeItem(node: SkillsNode): vscode.TreeItem {
  const collapsible =
    node.kind === "scope"
      ? vscode.TreeItemCollapsibleState.Expanded
      : node.kind === "catalogPack"
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
  const item = new vscode.TreeItem(node.label, collapsible);
  item.id = node.id;
  item.description = node.description;
  item.tooltip = node.tooltip;
  item.contextValue = node.contextValue;
  if (node.kind === "scope") item.iconPath = new vscode.ThemeIcon(node.scope === "project" ? "folder" : "globe");
  if (node.kind === "packs") item.iconPath = new vscode.ThemeIcon("package");
  if (node.kind === "catalogPack") item.iconPath = new vscode.ThemeIcon("package");
  if (node.kind === "catalogSkill") {
    item.iconPath = new vscode.ThemeIcon(node.installed ? "check" : "circle-outline");
    item.description = node.installed ? "已装" : undefined;
  }
  if (node.kind === "direct") item.iconPath = new vscode.ThemeIcon("link-external");
  return item;
}
```

- [ ] **Step 4: 跑测试确认通过** → `npm test` + `npm run build`（packages/vscode）→ 全绿。

- [ ] **Step 5: Commit**

```bash
git add packages/vscode/src/views packages/vscode/test/view-models.test.ts
git commit -m "feat(vscode): tree views render live core state via view models"
```

**M2 完成判据**：`npm test`（根）+ `npm run test:vscode` 全绿；F5 开发宿主中三个视图显示真实状态（Agents 显示初始化状态与 tooltip；Skills 显示双作用域 + Catalog Packs 展开含已装标记；Catalog 显示已注册列表）。

---

# M3：完整功能流

> 所有命令走 services + mutation queue + withProgress；错误统一 `runWithErrorHandling`。UI 层（commands/ui）import vscode；services/views 保持现状。

### Task 15: mutation 队列、UI 适配器与流程函数

**Files:** Create `packages/vscode/src/mutation-queue.ts`、`packages/vscode/src/ui/adapter.ts`、`packages/vscode/src/ui/flows.ts`；Test: Create `packages/vscode/test/mutation-queue.test.ts`、`packages/vscode/test/flows.test.ts`

**Interfaces:** Produces:

```ts
export interface MutationQueue { run<T>(operation: () => Promise<T>): Promise<T>; }
export function createMutationQueue(): MutationQueue;
export interface QuickPickChoice { label: string; description?: string; }
export interface UiAdapter {
  showQuickPick<T extends QuickPickChoice>(items: readonly T[], options?: { placeHolder?: string; canPickMany?: boolean }): Promise<T | T[] | undefined>;
  showInputBox(options?: { prompt?: string; placeHolder?: string }): Promise<string | undefined>;
}
export function pickAgentId(ui: UiAdapter, statuses: AgentStatus[]): Promise<string | undefined>;
export function pickAuthMode(ui: UiAdapter, current: string | null): Promise<"global" | "project" | "reset" | undefined>;
export function pickSessionsMode(ui: UiAdapter, current: string | null): Promise<"global" | "project" | undefined>;
export function promptCatalogSpec(ui: UiAdapter): Promise<string | undefined>;
export function pickCatalog(ui: UiAdapter, state: CatalogState): Promise<string | undefined>;
export function pickPackIds(ui: UiAdapter, available: Array<{ id: string; name: string; description?: string }>): Promise<string[] | undefined>;
export function promptDirectSource(ui: UiAdapter): Promise<string | undefined>;
export function pickSkillNames(ui: UiAdapter, names: string[]): Promise<string[] | undefined>;
export function runWithErrorHandling(operation: () => Promise<void>, showError: (message: string) => void): Promise<void>;
```

- [ ] **Step 1: 写失败测试**

`test/mutation-queue.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createMutationQueue } from "../src/mutation-queue.js";

test("mutation queue runs operations strictly sequentially", async () => {
  const queue = createMutationQueue();
  const order: number[] = [];
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const first = queue.run(async () => {
    order.push(1);
    await secondGate;
    order.push(3);
  });
  const second = queue.run(async () => { order.push(2); });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, [1]);
  releaseSecond();
  await Promise.all([first, second]);
  assert.deepEqual(order, [1, 3, 2]);
});

test("mutation queue continues after a failed operation", async () => {
  const queue = createMutationQueue();
  await assert.rejects(() => queue.run(async () => { throw new Error("boom"); }));
  const value = await queue.run(async () => "ok");
  assert.equal(value, "ok");
});
```

`test/flows.test.ts`（fake UiAdapter）：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { pickAuthMode, runWithErrorHandling } from "../src/ui/flows.js";
import type { UiAdapter } from "../src/ui/adapter.js";

test("pickAuthMode offers reset only when a local override exists", async () => {
  const items: string[] = [];
  const spy: UiAdapter = {
    async showQuickPick(list) {
      items.push(...(list as Array<{ label: string }>).map((item) => item.label));
      return { label: "project" };
    },
    async showInputBox() { return undefined; },
  };
  const picked = await pickAuthMode(spy, "global");
  assert.equal(picked, "project");
  assert.deepEqual(items, ["global", "project", "reset"]);
});

test("runWithErrorHandling surfaces core error messages", async () => {
  const messages: string[] = [];
  await runWithErrorHandling(async () => { throw new Error("初始化失败：x"); }, (m) => messages.push(m));
  assert.deepEqual(messages, ["初始化失败：x"]);
  await runWithErrorHandling(async () => {}, (m) => messages.push(m));
  assert.deepEqual(messages, ["初始化失败：x"]);
});
```

- [ ] **Step 2: 跑测试确认失败** → `npm test`（packages/vscode）→ FAIL。

- [ ] **Step 3: 最小实现**

`mutation-queue.ts`：

```ts
export interface MutationQueue {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export function createMutationQueue(): MutationQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      const result = tail.then(operation, operation);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}
```

`ui/adapter.ts`：

```ts
export interface QuickPickChoice {
  label: string;
  description?: string;
}

export interface UiAdapter {
  showQuickPick<T extends QuickPickChoice>(items: readonly T[], options?: { placeHolder?: string; canPickMany?: boolean }): Promise<T | T[] | undefined>;
  showInputBox(options?: { prompt?: string; placeHolder?: string }): Promise<string | undefined>;
}
```

（adapter.ts 只定义接口，不 import vscode；具体 vscode 实现在 T16 的 extension.ts 装配时内联提供。）

`ui/flows.ts`：

```ts
import type { AgentStatus } from "../services/agents.js";
import type { CatalogState } from "../services/catalog.js";
import type { UiAdapter } from "./adapter.js";

export async function pickAgentId(ui: UiAdapter, statuses: AgentStatus[]): Promise<string | undefined> {
  const chosen = await ui.showQuickPick(
    statuses.map((status) => ({ label: status.displayName, description: status.initialized ? `已初始化 · ${status.auth}` : "未初始化" })),
    { placeHolder: "选择 Agent" },
  );
  const picked = Array.isArray(chosen) ? chosen[0] : chosen;
  const index = picked ? statuses.findIndex((status) => status.displayName === picked.label) : -1;
  return index >= 0 ? statuses[index].id : undefined;
}

export async function pickAuthMode(ui: UiAdapter, current: string | null): Promise<"global" | "project" | "reset" | undefined> {
  const choices: Array<{ label: "global" | "project" | "reset"; description: string }> = [
    { label: "global", description: current === "global" ? "当前生效" : "使用本机全局凭据" },
    { label: "project", description: current === "project" ? "当前生效" : "项目级凭据（.agents/local/，不进 Git）" },
    { label: "reset", description: "清除本项目覆盖，恢复配置默认" },
  ];
  const chosen = await ui.showQuickPick(choices, { placeHolder: "选择认证作用域" });
  const picked = Array.isArray(chosen) ? chosen[0] : chosen;
  return picked?.label;
}

export async function pickSessionsMode(ui: UiAdapter, current: string | null): Promise<"global" | "project" | undefined> {
  const chosen = await ui.showQuickPick(
    [
      { label: "project", description: current === "project" ? "当前" : "会话留在项目（可跨设备）" },
      { label: "global", description: current === "global" ? "当前" : "会话留在全局原生存储" },
    ],
    { placeHolder: "选择会话模式" },
  );
  const picked = Array.isArray(chosen) ? chosen[0] : chosen;
  return picked?.label;
}

export async function promptCatalogSpec(ui: UiAdapter): Promise<string | undefined> {
  return ui.showInputBox({ prompt: "Catalog 地址（owner/repo、URL 或本地路径）", placeHolder: "owner/repo" });
}

export async function pickCatalog(ui: UiAdapter, state: CatalogState): Promise<string | undefined> {
  const chosen = await ui.showQuickPick(
    state.known.map((entry) => ({ label: entry.name, description: entry.spec === state.current ? "当前" : entry.spec })),
    { placeHolder: "选择 catalog" },
  );
  const picked = Array.isArray(chosen) ? chosen[0] : chosen;
  const index = picked ? state.known.findIndex((entry) => entry.name === picked.label) : -1;
  return index >= 0 ? state.known[index].spec : undefined;
}

export async function pickPackIds(ui: UiAdapter, available: Array<{ id: string; name: string; description?: string }>): Promise<string[] | undefined> {
  const chosen = await ui.showQuickPick(
    available.map((pack) => ({ label: pack.id, description: pack.name + (pack.description ? ` — ${pack.description}` : "") })),
    { placeHolder: "选择 Pack（多选）", canPickMany: true },
  );
  return Array.isArray(chosen) ? chosen.map((item) => item.label) : undefined;
}

export async function promptDirectSource(ui: UiAdapter): Promise<string | undefined> {
  return ui.showInputBox({ prompt: "Skills 仓库地址（owner/repo 或 URL）", placeHolder: "owner/repo" });
}

export async function pickSkillNames(ui: UiAdapter, names: string[]): Promise<string[] | undefined> {
  const chosen = await ui.showQuickPick(
    [{ label: "全部", description: `安装全部 ${names.length} 个` }, ...names.map((name) => ({ label: name }))],
    { placeHolder: "选择 Skill（多选）", canPickMany: true },
  );
  if (!Array.isArray(chosen)) return undefined;
  if (chosen.some((item) => item.label === "全部")) return names;
  return chosen.map((item) => item.label);
}

export async function runWithErrorHandling(operation: () => Promise<void>, showError: (message: string) => void): Promise<void> {
  try {
    await operation();
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}
```

- [ ] **Step 4: 跑测试确认通过** → `npm test`（packages/vscode）→ PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/vscode/src/mutation-queue.ts packages/vscode/src/ui/adapter.ts packages/vscode/src/ui/flows.ts packages/vscode/test/mutation-queue.test.ts packages/vscode/test/flows.test.ts
git commit -m "feat(vscode): mutation queue and QuickPick flows with error handling"
```

### Task 16: Agents 命令流（init/deinit/auth/sessions）

**Files:** Create `packages/vscode/src/commands/progress.ts`、`packages/vscode/src/commands/agents-commands.ts`；Modify `packages/vscode/src/extension.ts`、`packages/vscode/src/project.ts`（加 pickProjectRoot）；Test: Modify `packages/vscode/test/project.test.ts`

**Interfaces:** Produces: `registerAgentCommands(context: vscode.ExtensionContext, deps: AgentCommandDeps): void`；`progress.ts` 提供 `withProgress<T>(title, task)` 与 `progressIo(report)`（core 的 Io 适配到 progress 通知）。

- [ ] **Step 1: 写失败测试（packages/vscode/test/project.test.ts 追加）**

```ts
import { pickProjectRoot, resolveProjectRoot } from "../src/project.js";

test("pickProjectRoot stores the picked folder in multi-root workspaces", async () => {
  const folders = ["D:/work/a", "D:/work/b"];
  let stored: string | undefined;
  const picked = await pickProjectRoot(folders, stored, async (items) => items[1]);
  assert.equal(picked, "D:/work/b");
  stored = picked ?? undefined;
  assert.equal(resolveProjectRoot(folders, stored), "D:/work/b");
  assert.equal(await pickProjectRoot(folders, stored, async () => undefined), "D:/work/b");
});
```

- [ ] **Step 2: 跑测试确认失败** → `npm test`（packages/vscode）→ FAIL。

- [ ] **Step 3: 最小实现**

`project.ts` 追加：

```ts
export async function pickProjectRoot(
  workspaceFolders: readonly string[],
  stored: string | undefined,
  choose: (items: string[]) => Promise<string | undefined>,
): Promise<string | null> {
  const resolved = resolveProjectRoot(workspaceFolders, stored);
  if (resolved) return resolved;
  const picked = await choose([...workspaceFolders]);
  return picked ?? null;
}
```

`commands/progress.ts`：

```ts
import * as vscode from "vscode";

export async function withProgress<T>(title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async (progress) => {
    return task((message) => progress.report({ message }));
  });
}

export function progressIo(report: (message: string) => void): { log(message?: string): void } {
  return { log: (message) => { if (message) report(message); } };
}
```

`commands/agents-commands.ts`：

```ts
import * as vscode from "vscode";
import { AGENTS } from "@agenthome/core";
import type { MutationQueue } from "../mutation-queue.js";
import type { UiAdapter } from "../ui/adapter.js";
import { pickAgentId, pickAuthMode, pickSessionsMode, runWithErrorHandling } from "../ui/flows.js";
import type { AgentsTreeProvider } from "../views/agents-view.js";
import type { CatalogTreeProvider } from "../views/catalog-view.js";
import type { SkillsTreeProvider } from "../views/skills-view.js";
import {
  deinitializeAgentRuntime,
  getAgentStatus,
  importSessions,
  initializeAgentRuntime,
  switchAgentAuth,
  switchAgentSessions,
  writebackSessions,
} from "../services/agents.js";
import { withProgress } from "./progress.js";

export interface AgentCommandDeps {
  queue: MutationQueue;
  ui: UiAdapter;
  providers: { agents: AgentsTreeProvider; skills: SkillsTreeProvider; catalog: CatalogTreeProvider };
  projectRoot: () => Promise<string | null>;
}

export function registerAgentCommands(context: vscode.ExtensionContext, deps: AgentCommandDeps): void {
  const { queue, ui, providers, projectRoot } = deps;

  const refreshAll = (): void => {
    providers.agents.refresh();
    providers.skills.refresh();
    providers.catalog.refresh();
  };

  const loadStatuses = async (root: string) =>
    Promise.all(Object.keys(AGENTS).map((agentId) => getAgentStatus(root, agentId, process.env)));

  const register = (command: string, operation: () => Promise<void>): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, () => {
      void runWithErrorHandling(() => queue.run(operation), (message) => void vscode.window.showErrorMessage(message));
    }));
  };

  register("agenthome.agents.init", async () => {
    const root = await projectRoot();
    if (!root) return;
    const statuses = await loadStatuses(root);
    const agentId = await pickAgentId(ui, statuses);
    if (!agentId) return;
    const auth = await pickAuthMode(ui, null);
    if (!auth || auth === "reset") return;
    const sessions = await pickSessionsMode(ui, null);
    if (!sessions) return;
    await withProgress(`初始化 ${AGENTS[agentId].displayName}`, async () => {
      await initializeAgentRuntime(root, agentId, auth, sessions);
    });
    refreshAll();
    void vscode.window.showInformationMessage(`${AGENTS[agentId].displayName} 已初始化（${auth} · ${sessions}）`);
  });

  register("agenthome.agents.switchAuth", async () => {
    const root = await projectRoot();
    if (!root) return;
    const statuses = await loadStatuses(root);
    const agentId = await pickAgentId(ui, statuses.filter((status) => status.initialized));
    if (!agentId) return;
    const current = statuses.find((status) => status.id === agentId);
    const mode = await pickAuthMode(ui, current?.auth ?? null);
    if (!mode) return;
    await switchAgentAuth(root, agentId, mode);
    refreshAll();
  });

  register("agenthome.agents.switchSessions", async () => {
    const root = await projectRoot();
    if (!root) return;
    const statuses = await loadStatuses(root);
    const agentId = await pickAgentId(ui, statuses.filter((status) => status.initialized));
    if (!agentId) return;
    const current = statuses.find((status) => status.id === agentId);
    const mode = await pickSessionsMode(ui, current?.sessions ?? null);
    if (!mode) return;
    await switchAgentSessions(root, agentId, mode);
    refreshAll();
  });

  register("agenthome.agents.sessionsImport", async () => {
    const root = await projectRoot();
    if (!root) return;
    const statuses = await loadStatuses(root);
    const agentId = await pickAgentId(ui, statuses.filter((status) => status.initialized));
    if (!agentId) return;
    await withProgress("导入会话到项目", async () => {
      await importSessions(root, agentId, process.env);
    });
    void vscode.window.showInformationMessage("会话已导入项目");
  });

  register("agenthome.agents.sessionsWriteback", async () => {
    const root = await projectRoot();
    if (!root) return;
    const statuses = await loadStatuses(root);
    const agentId = await pickAgentId(ui, statuses.filter((status) => status.initialized));
    if (!agentId) return;
    await withProgress("回写会话到本机", async () => {
      await writebackSessions(root, agentId, process.env);
    });
    void vscode.window.showInformationMessage("会话已回写本机原生存储");
  });

  register("agenthome.agents.deinit", async () => {
    const root = await projectRoot();
    if (!root) return;
    const statuses = await loadStatuses(root);
    const agentId = await pickAgentId(ui, statuses.filter((status) => status.initialized));
    if (!agentId) return;
    const agent = AGENTS[agentId];
    const purge = await vscode.window.showWarningMessage(
      `移除 ${agent.displayName} 运行时？`,
      { modal: true },
      "移除（保留会话数据）",
      "移除并清除数据",
    );
    if (!purge) return;
    await deinitializeAgentRuntime(root, agentId, purge === "移除并清除数据");
    refreshAll();
  });
}
```

`extension.ts` 重写为：

```ts
import * as vscode from "vscode";
import { AgentsTreeProvider } from "./views/agents-view.js";
import { CatalogTreeProvider } from "./views/catalog-view.js";
import { SkillsTreeProvider } from "./views/skills-view.js";
import { createMutationQueue } from "./mutation-queue.js";
import type { UiAdapter } from "./ui/adapter.js";
import { pickProjectRoot } from "./project.js";
import { registerAgentCommands } from "./commands/agents-commands.js";

export function activate(context: vscode.ExtensionContext): void {
  const providers = {
    agents: new AgentsTreeProvider(),
    catalog: new CatalogTreeProvider(),
    skills: new SkillsTreeProvider(),
  };
  const queue = createMutationQueue();
  const ui: UiAdapter = {
    showQuickPick: async (items, options) =>
      vscode.window.showQuickPick(items, { placeHolder: options?.placeHolder, canPickMany: options?.canPickMany }),
    showInputBox: (options) => Promise.resolve(vscode.window.showInputBox(options)),
  };
  const workspaceFolders = (): string[] =>
    (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  const projectRoot = async (): Promise<string | null> =>
    pickProjectRoot(workspaceFolders(), context.workspaceState.get<string>("agenthome.projectRoot"), async (items) => {
      const chosen = await vscode.window.showQuickPick(items, { placeHolder: "选择 AgentHome 项目" });
      if (chosen) await context.workspaceState.update("agenthome.projectRoot", chosen);
      return chosen;
    });

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("agenthome.agents", providers.agents),
    vscode.window.registerTreeDataProvider("agenthome.catalog", providers.catalog),
    vscode.window.registerTreeDataProvider("agenthome.skills", providers.skills),
    vscode.commands.registerCommand("agenthome.refresh", () => {
      providers.agents.refresh();
      providers.catalog.refresh();
      providers.skills.refresh();
    }),
    vscode.commands.registerCommand("agenthome.overview.show", () => {
      void vscode.window.showInformationMessage("AgentHome Overview 将在 M4 提供");
    }),
  );

  registerAgentCommands(context, { queue, ui, providers, projectRoot });
}

export function deactivate(): void {}
```

- [ ] **Step 4: 跑测试确认通过** → `npm test` + `npm run build` + `npm run typecheck`（packages/vscode）→ 全绿。

- [ ] **Step 5: 手动冒烟（开发宿主）**

F5 → Agents 视图右键"Initialize Agent"→ 三个选择流程 → 状态刷新为"已初始化 · global"；切换认证/会话；deinit。

- [ ] **Step 6: Commit**

```bash
git add packages/vscode/src/commands/agents-commands.ts packages/vscode/src/commands/progress.ts packages/vscode/src/extension.ts packages/vscode/src/project.ts packages/vscode/test/project.test.ts
git commit -m "feat(vscode): agent lifecycle commands — init, auth, sessions, deinit"
```

### Task 17: Catalog 命令流（add/select/sync/default）

**Files:** Create `packages/vscode/src/ui/messages.ts`、`packages/vscode/src/commands/catalog-commands.ts`；Modify `packages/vscode/src/extension.ts`；Test: Create `packages/vscode/test/messages.test.ts`

**Interfaces:** Produces: `registerCatalogCommands(context, deps)`；`catalogMessages(result: CatalogAddResult): string`（纯函数，放 ui/messages.ts 以便 node --test）。

- [ ] **Step 1: 写失败测试（packages/vscode/test/messages.test.ts）**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { catalogMessages } from "../src/ui/messages.js";

test("catalogMessages summarizes registration results", () => {
  assert.match(catalogMessages({ previewFailed: true, error: new Error("fetch failed\nline2"), packs: [] }), /已保存/);
  assert.match(
    catalogMessages({ previewFailed: false, packs: [{ id: "common", name: "Common" }, { id: "dev", name: "Dev", description: "d" }] }),
    /Packs · 2/,
  );
});
```

- [ ] **Step 2: 跑测试确认失败** → `npm test`（packages/vscode）→ FAIL。

- [ ] **Step 3: 最小实现**

`ui/messages.ts`：

```ts
import type { CatalogAddResult } from "../services/catalog.js";

export function catalogMessages(result: CatalogAddResult): string {
  if (result.previewFailed) {
    const first = String(result.error?.message ?? "").split("\n")[0];
    return `已保存 catalog。预览暂不可用：${first}（可稍后 sync 重试）`;
  }
  const lines = result.packs.map((pack, index, all) => {
    const label = pack.name && pack.name !== pack.id ? `${pack.id} (${pack.name})` : pack.id;
    const purpose = pack.description ? ` — ${pack.description}` : "";
    return `${index === all.length - 1 ? "└──" : "├──"} ${label}${purpose}`;
  });
  return `已保存 catalog。Packs · ${result.packs.length}\n${lines.join("\n")}`;
}
```

`commands/catalog-commands.ts`：

```ts
import * as vscode from "vscode";
import type { MutationQueue } from "../mutation-queue.js";
import type { UiAdapter } from "../ui/adapter.js";
import { pickCatalog, promptCatalogSpec, runWithErrorHandling } from "../ui/flows.js";
import { catalogMessages } from "../ui/messages.js";
import { addCatalog, getCatalogState, selectCatalog, syncCatalog } from "../services/catalog.js";
import type { CatalogTreeProvider } from "../views/catalog-view.js";
import type { SkillsTreeProvider } from "../views/skills-view.js";
import { progressIo, withProgress } from "./progress.js";

export function registerCatalogCommands(context: vscode.ExtensionContext, deps: {
  queue: MutationQueue;
  ui: UiAdapter;
  providers: { skills: SkillsTreeProvider; catalog: CatalogTreeProvider };
  projectRoot: () => Promise<string | null>;
  overview?: { setCatalogRevision(revision: string | null): void };
}): void {
  const { queue, ui, providers, overview } = deps;
  const register = (command: string, operation: () => Promise<void>): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, () => {
      void runWithErrorHandling(() => queue.run(operation), (message) => void vscode.window.showErrorMessage(message));
    }));
  };

  register("agenthome.catalog.add", async () => {
    const spec = await promptCatalogSpec(ui);
    if (!spec) return;
    const result = await withProgress("注册 catalog", async (report) =>
      addCatalog(spec, process.env, progressIo(report)),
    );
    providers.catalog.setLastSync(null);
    providers.catalog.refresh();
    void vscode.window.showInformationMessage(catalogMessages(result));
  });

  register("agenthome.catalog.select", async () => {
    const state = await getCatalogState(process.env);
    const spec = await pickCatalog(ui, state);
    if (!spec) return;
    await selectCatalog(spec, process.env);
    providers.catalog.setLastSync(null);
    providers.catalog.refresh();
    providers.skills.refresh();
  });

  register("agenthome.catalog.sync", async () => {
    const info = await withProgress("同步 catalog", async (report) =>
      syncCatalog(process.env, progressIo(report)),
    );
    providers.catalog.setLastSync(info.revision);
    overview?.setCatalogRevision(info.revision);
    providers.catalog.refresh();
    providers.skills.refresh();
    void vscode.window.showInformationMessage(`Catalog 已同步: ${info.revision.slice(0, 8)}`);
  });

  register("agenthome.catalog.default", async () => {
    const state = await getCatalogState(process.env);
    void vscode.window.showInformationMessage(`当前 catalog: ${state.current}`);
  });
}
```

`extension.ts` 追加注册（activate 内，`registerAgentCommands` 之后）：

```ts
  registerCatalogCommands(context, { queue, ui, providers: { skills: providers.skills, catalog: providers.catalog }, projectRoot });
```

（顶部 import 加 `import { registerCatalogCommands } from "./commands/catalog-commands.js";`。）

- [ ] **Step 4: 跑测试确认通过** → `npm test` + `npm run build`（packages/vscode）→ 全绿。

- [ ] **Step 5: Commit**

```bash
git add packages/vscode/src/ui/messages.ts packages/vscode/src/commands/catalog-commands.ts packages/vscode/src/extension.ts packages/vscode/test/messages.test.ts
git commit -m "feat(vscode): catalog commands — add, select, sync, default"
```

### Task 18: Skills 命令流（双作用域安装/卸载/直装/删除）

**Files:** Create `packages/vscode/src/commands/skills-commands.ts`；Modify `packages/vscode/src/services/skills.ts`（加 packCandidates/uninstallCandidates 纯函数）、`packages/vscode/src/extension.ts`；Test: Modify `packages/vscode/test/skills-service.test.ts`

**Interfaces:** Produces: `registerSkillsCommands(context, deps)`；纯函数（放 services/skills.ts 以便 node --test）：`packCandidates(available, installed)`、`uninstallCandidates(installed)`。

- [ ] **Step 1: 写失败测试（packages/vscode/test/skills-service.test.ts 追加）**

```ts
import { packCandidates, uninstallCandidates } from "../src/services/skills.js";

test("packCandidates excludes installed packs", () => {
  const candidates = packCandidates([{ id: "common", name: "Common" }, { id: "dev", name: "Dev" }], ["common"]);
  assert.deepEqual(candidates.map((c) => c.id), ["dev"]);
});

test("uninstallCandidates never offers common", () => {
  assert.deepEqual(uninstallCandidates(["common", "development"]), ["development"]);
});
```

- [ ] **Step 2: 跑测试确认失败** → `npm test`（packages/vscode）→ FAIL。

- [ ] **Step 3: 最小实现**

`services/skills.ts` 追加：

```ts
export function packCandidates(available: Array<{ id: string; name: string; description?: string }>, installed: string[] | null): Array<{ id: string; name: string; description?: string }> {
  const installedSet = new Set(installed ?? []);
  return available.filter((pack) => !installedSet.has(pack.id));
}

export function uninstallCandidates(installed: string[] | null): string[] {
  return (installed ?? []).filter((packId) => packId !== "common");
}
```

`commands/skills-commands.ts`：

```ts
import * as vscode from "vscode";
import path from "node:path";
import {
  createTempDirectory,
  ensureCatalog,
  loadDefaultCatalogSpec,
  loadPacks,
  removeTempDirectory,
} from "@agenthome/core";
import type { MutationQueue } from "../mutation-queue.js";
import type { UiAdapter } from "../ui/adapter.js";
import { pickPackIds, pickSkillNames, promptDirectSource, runWithErrorHandling } from "../ui/flows.js";
import type { SkillScope } from "../services/skills.js";
import {
  addDirectSkill,
  discoverRepositorySkills,
  getSkillsStatus,
  installPacksInto,
  packCandidates,
  removeExternalSkill,
  uninstallCandidates,
  uninstallPacksFrom,
} from "../services/skills.js";
import type { SkillsTreeProvider } from "../views/skills-view.js";
import { progressIo, withProgress } from "./progress.js";

export function registerSkillsCommands(context: vscode.ExtensionContext, deps: {
  queue: MutationQueue;
  ui: UiAdapter;
  providers: { skills: SkillsTreeProvider };
  projectRoot: () => Promise<string | null>;
}): void {
  const { queue, ui, providers } = deps;
  const register = (command: string, operation: () => Promise<void>): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, () => {
      void runWithErrorHandling(() => queue.run(operation), (message) => void vscode.window.showErrorMessage(message));
    }));
  };

  const pickScope = async (): Promise<SkillScope | undefined> => {
    const chosen = await vscode.window.showQuickPick(
      [{ label: "project", description: "当前项目" }, { label: "global", description: "全局（本机所有项目）" }],
      { placeHolder: "选择作用域" },
    );
    return chosen?.label as SkillScope | undefined;
  };

  register("agenthome.skills.installPacks", async () => {
    const root = await deps.projectRoot();
    if (!root) return;
    const scope = await pickScope();
    if (!scope) return;
    const available = await withProgress("读取 catalog Packs", async (report) => {
      const spec = await loadDefaultCatalogSpec(process.env);
      const info = await ensureCatalog(spec, { environment: process.env, io: progressIo(report) });
      const packs = [...(await loadPacks(info.catalogRoot)).values()];
      return packs.map((pack) => ({ id: pack.id, name: pack.name, description: pack.description }));
    });
    const { project, global } = await getSkillsStatus(root, process.env);
    const installed = scope === "project" ? project.installedPacks : global.installedPacks;
    const selected = await pickPackIds(ui, packCandidates(available, installed));
    if (!selected || selected.length === 0) return;
    await withProgress(`安装 Packs: ${selected.join(" + ")}`, async (report) => {
      await installPacksInto(root, selected, scope, process.env, progressIo(report));
    });
    providers.skills.refresh();
  });

  register("agenthome.skills.uninstallPacks", async () => {
    const root = await deps.projectRoot();
    if (!root) return;
    const scope = await pickScope();
    if (!scope) return;
    const { project, global } = await getSkillsStatus(root, process.env);
    const installed = scope === "project" ? project.installedPacks : global.installedPacks;
    const candidates = uninstallCandidates(installed);
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage("没有可卸载的 Pack（common 不可卸载）");
      return;
    }
    const selected = await pickPackIds(ui, candidates.map((packId) => ({ id: packId, name: packId })));
    if (!selected || selected.length === 0) return;
    await withProgress(`卸载 Packs: ${selected.join(" + ")}`, async (report) => {
      await uninstallPacksFrom(root, selected, scope, process.env, progressIo(report));
    });
    providers.skills.refresh();
  });

  register("agenthome.skills.addDirect", async () => {
    const root = await deps.projectRoot();
    if (!root) return;
    const scope = await pickScope();
    if (!scope) return;
    const repository = await promptDirectSource(ui);
    if (!repository) return;
    const tempRoot = await createTempDirectory(root);
    let names: string[];
    try {
      names = await withProgress(`发现 Skills: ${repository}`, async () =>
        discoverRepositorySkills(repository, path.join(tempRoot, "clone")),
      );
    } finally {
      await removeTempDirectory(tempRoot);
    }
    const selected = await pickSkillNames(ui, names);
    if (!selected || selected.length === 0) return;
    await withProgress(`安装 Skills: ${selected.join(", ")}`, async (report) => {
      await addDirectSkill(root, repository, selected, scope, process.env, progressIo(report));
    });
    providers.skills.refresh();
  });

  register("agenthome.skills.removeDirect", async () => {
    const root = await deps.projectRoot();
    if (!root) return;
    const scope = await pickScope();
    if (!scope) return;
    const { project, global } = await getSkillsStatus(root, process.env);
    const direct = scope === "project" ? project.direct : global.direct;
    const names = direct.directSources.flatMap((source) => source.skills);
    if (names.length === 0) {
      void vscode.window.showInformationMessage("没有直装 Skills");
      return;
    }
    const selected = await pickSkillNames(ui, names);
    if (!selected || selected.length === 0) return;
    await withProgress(`删除 Skills: ${selected.join(", ")}`, async (report) => {
      await removeExternalSkill(root, selected, scope, process.env, progressIo(report));
    });
    providers.skills.refresh();
  });
}
```

`extension.ts` 追加注册（activate 内）：

```ts
  registerSkillsCommands(context, { queue, ui, providers: { skills: providers.skills }, projectRoot });
```

（顶部 import 加 `import { registerSkillsCommands } from "./commands/skills-commands.js";`。）

- [ ] **Step 4: 跑测试确认通过** → `npm test` + `npm run build` + `npm run typecheck` → 全绿。

- [ ] **Step 5: 手动冒烟**：双作用域安装/卸载 Pack、addDirect 全流程（InputBox → 发现 → 多选 → 安装 → 视图刷新）、removeDirect。

- [ ] **Step 6: Commit**

```bash
git add packages/vscode/src/commands/skills-commands.ts packages/vscode/src/services/skills.ts packages/vscode/src/extension.ts packages/vscode/test/skills-service.test.ts
git commit -m "feat(vscode): skills commands — dual-scope packs and direct skills"
```

**M3 完成判据**：spec 第 5.3 节全部 QuickPick 流程可跑通；每个 mutation 走 queue；错误统一 showErrorMessage；树视图状态即时刷新。

---

# M4：Dashboard 与 UI 打磨

### Task 19: Overview Webview Dashboard

**Files:** Create `packages/vscode/src/dashboard/protocol.ts`、`packages/vscode/src/dashboard/state.ts`、`packages/vscode/src/dashboard/html.ts`、`packages/vscode/src/dashboard/overview.ts`、`packages/vscode/media/main.js`、`packages/vscode/media/style.css`；Modify `packages/vscode/package.json`（overview webview view）、`packages/vscode/src/extension.ts`；Test: Create `packages/vscode/test/dashboard-state.test.ts`、`packages/vscode/test/dashboard-html.test.ts`

**Interfaces:** Produces: `DashboardState`（protocol.ts）与 `buildDashboardState(projectRoot, agents, catalog, skills, catalogRevision?)`（state.ts 纯函数）、`overviewHtml(nonce, cspSource, styleUri, scriptUri)`（html.ts 纯函数）、`OverviewProvider`（overview.ts，WebviewViewProvider，含 `setCatalogRevision`）。

**安全模型（硬性）**：webview 仅本地静态资源（CSP `default-src 'none'`）；状态经 `postMessage({type:"state"})` 传入，main.js **只用 `textContent`/`createElement` 渲染，禁止 innerHTML 注入数据**；按钮回传 `postMessage({type:"command", command})` 或 `{type:"refresh"}`。

- [ ] **Step 1: 写失败测试**

`test/dashboard-state.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardState } from "../src/dashboard/state.js";
import type { AgentStatus } from "../src/services/agents.js";
import type { CatalogState } from "../src/services/catalog.js";

test("buildDashboardState assembles agents and catalog into one payload", () => {
  const agents: AgentStatus[] = [
    { id: "claude", displayName: "Claude Code", initialized: true, auth: "global", sessions: "project", configuredAuth: "global", localAuth: null, executableAvailable: true },
  ];
  const catalog: CatalogState = { current: "owner/repo#main", known: [{ name: "catalog", spec: "owner/repo#main" }] };
  const state = buildDashboardState("D:/work/proj", agents, catalog, null);
  assert.equal(state.projectRoot, "D:/work/proj");
  assert.equal(state.agents.length, 1);
  assert.equal(state.catalog?.current, "owner/repo#main");
  assert.equal(state.catalog?.revision, null);
});
```

`test/dashboard-html.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { overviewHtml } from "../src/dashboard/html.js";

test("overviewHtml embeds a strict CSP with the nonce and local assets", () => {
  const html = overviewHtml(
    "abc123",
    "https://file+.vscode-resource.vscode-cdn.net",
    "vscode-webview://1/media/style.css",
    "vscode-webview://1/media/main.js",
  );
  assert.match(html, /default-src 'none'/);
  assert.match(html, /nonce-abc123/);
  assert.match(html, /media\/main\.js/);
  assert.match(html, /media\/style\.css/);
});
```

- [ ] **Step 2: 跑测试确认失败** → `npm test`（packages/vscode）→ FAIL。

- [ ] **Step 3: 最小实现**

`protocol.ts`：

```ts
import type { AgentStatus } from "../services/agents.js";

export interface DashboardCatalog {
  current: string;
  revision: string | null;
  knownCount: number;
}

export interface DashboardScope {
  scope: "project" | "global";
  root: string;
  packs: string[] | null;
  directCount: number;
}

export interface DashboardState {
  projectRoot: string | null;
  catalog: DashboardCatalog | null;
  agents: AgentStatus[];
  skills: { project: DashboardScope; global: DashboardScope } | null;
}

export type DashboardRequest = { type: "refresh" } | { type: "command"; command: string };
export type DashboardMessage = { type: "state"; state: DashboardState };
```

`state.ts`：

```ts
import type { AgentStatus } from "../services/agents.js";
import type { CatalogState } from "../services/catalog.js";
import type { SkillsStatus } from "../services/skills.js";
import type { DashboardScope, DashboardState } from "./protocol.js";

export function buildDashboardState(
  projectRoot: string | null,
  agents: AgentStatus[],
  catalog: CatalogState,
  skills: SkillsStatus | null,
  catalogRevision: string | null = null,
): DashboardState {
  return {
    projectRoot,
    catalog: { current: catalog.current, revision: catalogRevision, knownCount: catalog.known.length },
    agents,
    skills: skills
      ? {
          project: {
            scope: "project",
            root: skills.project.context.root,
            packs: skills.project.installedPacks,
            directCount: skills.project.direct.directSources.flatMap((source) => source.skills).length,
          },
          global: {
            scope: "global",
            root: skills.global.context.root,
            packs: skills.global.installedPacks,
            directCount: skills.global.direct.directSources.flatMap((source) => source.skills).length,
          },
        }
      : null,
  };
}
```

`html.ts`（静态骨架 + 资源引用；不含动态数据）：

```ts
export function overviewHtml(nonce: string, cspSource: string, styleUri: string, scriptUri: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>AgentHome</title>
</head>
<body>
<header class="ah-header">
  <h1>AgentHome</h1>
  <span id="project" class="ah-muted"></span>
  <vscode-button id="refresh" appearance="secondary">刷新</vscode-button>
</header>
<main>
  <section id="catalog" class="ah-card"><h2>Catalog</h2><div id="catalog-body" class="ah-muted">加载中…</div></section>
  <section id="agents" class="ah-card"><h2>Agents</h2><div id="agents-body"></div></section>
  <section id="skills" class="ah-card"><h2>Skills</h2><div id="skills-body"></div></section>
</main>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
```

`media/style.css`（主题变量驱动，跟随明暗主题）：

```css
:root { color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
body { padding: 8px 12px; }
.ah-header { display: flex; align-items: center; gap: 8px; }
.ah-header h1 { font-size: 1.2em; margin: 0; flex: 1; }
.ah-card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 4px; margin-top: 10px; padding: 10px; }
.ah-card h2 { font-size: 1em; margin: 0 0 8px; color: var(--vscode-sideBarSectionHeader-foreground); }
.ah-muted { color: var(--vscode-descriptionForeground); }
.ah-agent { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.ah-badge { border-radius: 3px; padding: 0 6px; font-size: 0.85em; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.ah-row { display: flex; justify-content: space-between; padding: 3px 0; }
.ah-ok { color: var(--vscode-charts-green); }
.ah-warn { color: var(--vscode-charts-yellow); }
```

`media/main.js`（textContent 渲染，无 innerHTML 注入）：

```js
// @ts-check
/// <reference lib="dom" />
const vscode = acquireVsCodeApi();

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function badge(text, kind) {
  const span = el("span", `ah-badge ${kind === "ok" ? "ah-ok" : "ah-warn"}`);
  span.textContent = text;
  return span;
}

function renderCatalog(catalog) {
  const body = document.getElementById("catalog-body");
  body.textContent = "";
  if (!catalog) {
    body.append(document.createTextNode("未配置"));
    return;
  }
  const first = el("div", "ah-row");
  first.append(badge(catalog.current, "ok"));
  body.append(first);
  const second = el("div", "ah-muted");
  second.textContent = `revision: ${catalog.revision ?? "未知"} · 已注册 ${catalog.knownCount} 个`;
  body.append(second);
}

function renderAgents(agents) {
  const body = document.getElementById("agents-body");
  body.textContent = "";
  for (const agent of agents) {
    const row = el("div", "ah-agent");
    const name = el("span");
    name.textContent = agent.displayName;
    row.append(name);
    if (agent.initialized) {
      row.append(badge(`auth: ${agent.auth}`, "ok"), badge(`sessions: ${agent.sessions}`, "ok"));
    } else {
      row.append(badge("未初始化", "warn"));
    }
    row.append(agent.executableAvailable ? badge("CLI ✓", "ok") : badge("CLI ✗", "warn"));
    body.append(row);
  }
}

function renderSkills(skills) {
  const body = document.getElementById("skills-body");
  body.textContent = "";
  if (!skills) {
    body.append(document.createTextNode("请选择项目"));
    return;
  }
  for (const scope of [skills.project, skills.global]) {
    const row = el("div", "ah-row");
    const label = el("span");
    label.textContent = scope.scope === "project" ? "项目" : "全局";
    const value = el("span", "ah-muted");
    value.textContent = scope.packs ? scope.packs.join(" + ") : "未安装";
    row.append(label, value);
    body.append(row);
  }
}

function render(state) {
  document.getElementById("project").textContent = state.projectRoot ?? "未选择项目";
  renderCatalog(state.catalog);
  renderAgents(state.agents);
  renderSkills(state.skills);
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "state") render(message.state);
});
document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
```

`overview.ts`：

```ts
import * as vscode from "vscode";
import { AGENTS } from "@agenthome/core";
import { overviewHtml } from "./html.js";
import { buildDashboardState } from "./state.js";
import type { DashboardMessage, DashboardRequest } from "./protocol.js";
import { getAgentStatus } from "../services/agents.js";
import { getCatalogState } from "../services/catalog.js";
import { getSkillsStatus } from "../services/skills.js";
import { resolveProjectRoot } from "../project.js";

export class OverviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private catalogRevision: string | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {}

  setCatalogRevision(revision: string | null): void {
    this.catalogRevision = revision;
    void this.pushState();
  }

  refresh(): void {
    void this.pushState();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    const styleUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "style.css")).toString();
    const scriptUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "main.js")).toString();
    webviewView.webview.html = overviewHtml(this.nonce(), webviewView.webview.cspSource, styleUri, scriptUri);
    webviewView.webview.onDidReceiveMessage((message: DashboardRequest) => {
      if (message.type === "refresh") this.refresh();
      if (message.type === "command") void vscode.commands.executeCommand(message.command);
    });
    this.refresh();
  }

  private nonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let value = "";
    for (let index = 0; index < 32; index += 1) value += chars[Math.floor(Math.random() * chars.length)];
    return value;
  }

  private async pushState(): Promise<void> {
    if (!this.view) return;
    const root = resolveProjectRoot((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath));
    const [agents, catalog, skills] = await Promise.all([
      root ? Promise.all(Object.keys(AGENTS).map((agentId) => getAgentStatus(root, agentId, process.env))) : Promise.resolve([]),
      getCatalogState(process.env),
      root ? getSkillsStatus(root, process.env) : Promise.resolve(null),
    ]);
    const state = buildDashboardState(root, agents, catalog, skills, this.catalogRevision);
    const message: DashboardMessage = { type: "state", state };
    await this.view.webview.postMessage(message);
  }
}
```

`package.json` 增补：`views.agenthome` 数组加入 `{ "id": "agenthome.overview", "name": "Overview", "type": "webview" }`。

`extension.ts` 更新（activate 内，在 `registerCatalogCommands` 之前创建 overview 并传入；顶部 import 加 `import { OverviewProvider } from "./dashboard/overview.js";`）：

```ts
  const overview = new OverviewProvider(context.extensionUri);

  registerCatalogCommands(context, {
    queue,
    ui,
    providers: { skills: providers.skills, catalog: providers.catalog },
    projectRoot,
    overview,
  });
```

并把 `agenthome.overview.show`/`agenthome.doctor` 的占位命令替换为：

```ts
    vscode.commands.registerCommand("agenthome.overview.show", () =>
      void vscode.commands.executeCommand("agenthome.overview.focus"),
    ),
    vscode.commands.registerCommand("agenthome.doctor", () => {
      overview.refresh();
      void vscode.commands.executeCommand("agenthome.overview.focus");
    }),
```

以及注册 provider：

```ts
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("agenthome.overview", overview),
  );
```

（说明：`<viewId>.focus` 是 VS Code 为 webview 视图自动注册的命令；doctor 命令即"刷新 Overview 并聚焦"。）

- [ ] **Step 4: 跑测试确认通过** → `npm test` + `npm run build` + `npm run typecheck` → 全绿。

- [ ] **Step 5: 手动冒烟**：F5 → Overview 视图显示卡片与徽章；暗/亮主题下配色正常；刷新按钮可用；`agenthome.catalog.sync` 后 Catalog 卡片 revision 更新。

- [ ] **Step 6: Commit**

```bash
git add packages/vscode/src/dashboard packages/vscode/media/main.js packages/vscode/media/style.css packages/vscode/package.json packages/vscode/src/extension.ts packages/vscode/test/dashboard-state.test.ts packages/vscode/test/dashboard-html.test.ts
git commit -m "feat(vscode): overview webview dashboard — cards, badges, theme-aware, CSP-safe"
```

### Task 20: UI 打磨与文档

**Files:** Modify `packages/vscode/src/views/*`（图标/Codicon/描述细化）、`packages/vscode/package.json`（命令 category）；Create `packages/vscode/README.md`、`packages/vscode/CHANGELOG.md`

- [ ] **Step 1: 打磨项（无新测试；以 view-models 现有测试 + 手动检查为准）**

- Agents 视图：已初始化节点 description 加上 sessions（`已初始化 · global · project`）；tooltip 保持详情全量。
- Catalog 视图：当前节点 check 图标、非当前 circle-outline（T14 已做，检查即可）。
- Skills 视图：scopeNode 用 Codicon `folder`/`globe`、packNode 用 `package`、directNode 用 `link-external`（T14 已做，检查即可）。
- 命令面板分类：`contributes.commands` 的 title 改为不带前缀的短名 + `"category": "AgentHome"`（如 `"title": "Initialize Agent", "category": "AgentHome"`），菜单里仍按 id 触发。

- [ ] **Step 2: 写 README.md（扩展首页 = Marketplace 文案）**

内容（精简）：功能列表（8 项 MVP 功能）、快速上手（init → catalog add → skills install）、与 CLI 的关系（复用 core，不需要安装 CLI；CLI 保持独立）、已知限制（MVP：无 catalog 维护 UI/无终端启动）。中文。

- [ ] **Step 3: 写 CHANGELOG.md（0.1.0 条目）**，列出 MVP 功能。

- [ ] **Step 4: 验证与 Commit**

Run: `npm run build && npm run typecheck && npm test`（packages/vscode）+ 根 `npm test`。
Expected: 全绿。

```bash
git add packages/vscode/src/views packages/vscode/package.json packages/vscode/README.md packages/vscode/CHANGELOG.md
git commit -m "polish(vscode): codicons, command categories, marketplace README"
```

**M4 完成判据**：Dashboard 呈现真实状态且主题适配；树视图信息密度低（描述一行、详情 tooltip）；README 可作 Marketplace 页。

---

# M5：打包、测试与发布

### Task 21: vsce 打包配置与发布文档

**Files:** Modify `packages/vscode/.vscodeignore`、`docs/development.md`；Modify 根 `package.json`（`pack:vscode` 脚本）

- [ ] **Step 1: 完善 .vscodeignore**

检查 `packages/vscode/.vscodeignore`：`src/**`、`test/**`、`build.mjs`、`tsconfig.json`、`tsconfig.test.json`、`.vscode/**` 均已在（T10 已写）；确认 `media/` 与 `README.md`、`CHANGELOG.md` **不在**忽略列表。

- [ ] **Step 2: docs/development.md 增补两节**

```markdown
## core 发布纪律（扩展依赖 @agenthome/core）

1. `packages/core` 变更（含 index.d.ts 签名调整）→ bump `packages/core/package.json` version（新函数=minor，破坏性=rare major）
2. 维护者执行：`cd packages/core && npm publish`
3. CLI 照旧：`npm run sync-core`（vendor 同步，与 npm 发布互相独立）
4. 扩展升级依赖：`packages/vscode/package.json` 的 `@agenthome/core` 版本范围，然后 `cd packages/vscode && npm install && npm test`

## VS Code 扩展发布

```bash
cd packages/vscode
npm install
npm test            # build:test + node --test
npm run build       # esbuild → dist/extension.js（含 @agenthome/core）
npm run package     # vsce package → agenthome-vscode-<version>.vsix
npx vsce publish    # 维护者执行（需要 Azure DevOps PAT，publisher: agenthome）
```

CI 在 tag `vscode-v*` 上执行 build + package 并上传 vsix 工件；发布由维护者执行。
```

- [ ] **Step 3: 根 scripts 加 `"pack:vscode": "npm run package --prefix packages/vscode"`**。

- [ ] **Step 4: 验证打包**

Run: `cd packages/vscode && npm run package`
Expected: 生成 `agenthome-vscode-0.1.0.vsix`；`npx vsce ls` 输出含 `dist/extension.js`、`media/`、`README.md`，不含 `src/`、`test/`。

- [ ] **Step 5: Commit**

```bash
git add packages/vscode/.vscodeignore docs/development.md package.json
git commit -m "chore(release): vsix packaging and publish docs"
```

### Task 22: CI 接入

**Files:** Modify `.github/workflows/ci.yml`

- [ ] **Step 1: 在 test job 末尾追加 vscode 步骤**

```yaml
      - name: Install VS Code extension deps
        run: npm install --prefix packages/vscode
      - name: VS Code extension tests
        run: npm run test:vscode
      - name: VS Code extension build
        run: npm run build --prefix packages/vscode
      - name: VS Code extension typecheck
        run: npm run typecheck --prefix packages/vscode
```

- [ ] **Step 2: 新增 tag 打包 job（ci.yml 追加）**

```yaml
  package-vscode:
    name: Package VS Code extension
    if: startsWith(github.ref, 'refs/tags/vscode-v')
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install deps
        run: npm install --prefix packages/vscode
      - name: Build and package
        run: npm run package --prefix packages/vscode
      - uses: actions/upload-artifact@v4
        with:
          name: agenthome-vscode-vsix
          path: packages/vscode/*.vsix
```

- [ ] **Step 3: 验证**

Run: `git diff --check`（无空白错误）→ 通读一遍 diff 确认缩进与步骤名 → 提交并推送，在 GitHub Actions 查看 test job 新增步骤（vscode install/tests/build/typecheck）全绿。
Expected: test job 绿；package-vscode job 显示 skipped（非 tag 触发即正常）。

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: vscode extension tests, build, and tag packaging"
```

### Task 23: 全量回归与发布就绪检查

**Files:** 无代码改动（如发现问题，修 + 补测试 + 单独提交 `fix(...)`）。

- [ ] **Step 1: 根仓库全量回归**

```bash
npm test               # 68 个旧测试 + M1 新增测试全绿
npm run test:install   # 全局安装集成
npm run pack:cli       # CLI 打包检查
npm run test:vscode    # 扩展 services/views/flows 测试
cd packages/vscode && npm run build && npm run typecheck
```

Expected: 全部绿。

- [ ] **Step 2: CLI 行为回归抽查（重构等价性）**

```bash
node packages/cli/scripts/skills.mjs skills status    # 与重构前输出一致（无安装时提示 lock 文件）
node packages/cli/scripts/skills.mjs catalog list
node packages/cli/scripts/skills.mjs status
node packages/cli/scripts/skills.mjs doctor
```

Expected: 与 M1 前手动记录/快照的输出一致（cli-surface.test.mjs 已自动化把关）。

- [ ] **Step 3: 扩展手动冒烟清单（记录到 packages/vscode/README.md 的开发节）**

1. F5 启动开发宿主；单根工作区
2. Agents：init（global/project × project/global 组合）→ 状态、tooltip、图标
3. 认证切换 global↔project→reset；sessions 切换
4. sessions import / writeback（用一次性项目）
5. Catalog：add（含失败路径：无权限仓库 → "已保存" 提示）、select、sync、default
6. Skills：install（project+global）、uninstall（common 不出现在候选）、addDirect 全流程、removeDirect
7. Overview Dashboard：卡片状态、暗/亮主题、刷新、sync 后 revision 更新
8. 错误路径：无 CLI（PATH 空）时 doctor/status 图标为 ✗ 不崩溃

- [ ] **Step 4: 版本与收尾 Commit**

`packages/vscode/package.json` version 0.1.0 保持；README 补冒烟清单。若 M1–M5 期间有 fix 提交，此处不再动。

```bash
git add -A
git commit -m "chore(release): vscode 0.1.0 MVP — regression suite and smoke checklist"
git push
```

**M5 完成判据**：CI 绿；vsix 可本地生成；发布命令（`npx vsce publish`）待用户执行；spec 第 8 节要求全部满足。

---

## 推荐执行顺序（subagent-driven-development / executing-plans 均按此）

1. M1：T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9（严格串行，每步 `npm test` 全绿；T9 后用户执行 core publish——**后续任务的前置 gate**）
2. M2：T10 → T11 → T12 → T13 → T14（串行）
3. M3：T15 → T16 → T17 → T18（串行；T16–T18 共享 extension.ts，建议同一执行者连续完成）
4. M4：T19 → T20
5. M5：T21 → T22 → T23

检查点建议：每个 M 结束后由人工/reviewer 过一遍（subagent 模式即 review gate；inline 模式即停下确认里程碑判据）。

## 提交点汇总（预期）

| 里程碑 | 提交 |
|---|---|
| M1 | `chore(core)`, `feat(core)` ×7, `refactor(cli)` ×7, `docs` |
| M2 | `chore(vscode)`, `feat(vscode)` ×4 |
| M3 | `feat(vscode)` ×4 |
| M4 | `feat(vscode)`, `polish(vscode)` |
| M5 | `chore(release)`, `ci`, `chore(release)` |
