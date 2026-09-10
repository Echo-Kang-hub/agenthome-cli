# 本机模型配置库 + 项目绑定（B）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增"本机（设备级）模型 profile 库 + 每项目绑定"两层数据模型：库是唯一事实来源（`stateRoot/models.json`），项目只存绑定与回滚账本（`.agents/model.json`）；Claude 走项目内物化投影（带指纹与精确回滚），Codex / OpenCode 走启动注入；CLI 与 VS Code 插件读同一份库、走同一套 core 函数。

**Architecture:** 全部业务逻辑放在 `packages/core/src/model/*.mjs`（纯函数 + 无 vscode 依赖）。写入一律走 `transact()`：读 → 变异 → 在同卷临时目录落盘 → 用既有 `replaceStagedFiles` 完成"备份 → rename → 失败回滚"，替换前重读版本戳（不一致则重放，最多 3 次）。CLI 在 `dispatchAgent` 的启动点注入；插件在 `prepareAgentLaunch` 注入，面板只是 `WebviewPanel` 薄壳（数据组装在 vscode-free 模块，因为插件测试没有 vscode stub）。

**Tech Stack:** Node ≥18.17（ESM、`node:fs/promises`、全局 `fetch`、`node:util` 的 `isDeepStrictEqual`）、`node --test`（含 `node:http` 本地 mock server）、VS Code 扩展（TypeScript + esbuild + 原生 webview）。

**Spec:** `docs/superpowers/specs/2026-09-10-project-model-config-design.md`（commit `dbf26a7`，修订版 2）

**前置依赖：** 本计划假设 **A（Skills 单副本）已按 `docs/superpowers/plans/2026-09-10-skills-single-copy-plan.md` 实施并发布**（core `1.1.0` / CLI `1.2.0` / 扩展 `0.1.11`）。B 的版本号在该基线之上 +1。若 A 尚未发布，把下面所有版本号换成"当前实际值 +1 minor（core/CLI）/ +1 patch（扩展）"。

## Global Constraints

- 本计划只做 B（模型配置）。**A/B 绝不混在同一次提交**；`dispatcher.mjs`、`services/agents.ts`、`core/src/index.mjs`、`core/index.d.ts`、`CHANGELOG.md`、`package.json` 这些 A 也动过的文件，B 的提交里只允许出现 B 的 diff（`git add -p` 或提交前 `git diff --cached` 过一眼）。
- **库是唯一事实来源**：只有 `stateRoot(environment)/models.json` 保存 profile 与密钥；项目文件只保存 `activeProfileId` + `overrides` + 回滚账本；插件不保存任何副本，**不使用** `SecretStorage` / `globalState` / `globalStorage`（CLI 无法共享，会产生两套事实来源）。
- **绝不写** `~/.claude`、`~/.codex`、`~/.config/opencode` 下任何文件；不修改三个 Agent 自身的全局配置。
- 密钥：所有输出（CLI、通知、日志、错误、面板 JSON 预览）一律掩码（前 3 后 4）；**不写日志**；不入 Git。面板发往 webview 的数据里只有掩码。
- **不允许两个裸 `writeFile`**：库与项目文件的每次写入都走 `transact()`（§5.5）。
- 注入值白名单（保存即校验，不合格拒绝保存）：baseUrl `^https?://[A-Za-z0-9._~:/?#\[\]@+,;=\-]+$`；provider id `^[a-z0-9_]{1,32}$`；envKey `^[A-Z][A-Z0-9_]{0,63}$`；模型 ID `^[A-Za-z0-9._:\-/]{1,128}$`。拒绝 `%`、`"`、`'`、反引号、`$` 与 cmd 元字符 `& ^ | < > ( ) !`。
- 版本/发布顺序：core bump → **发布（USER CHECKPOINT）** → `npm run sync-core` → CLI bump → **发布（USER CHECKPOINT）** → 插件依赖提升 + 实现 → 打包 VSIX（Marketplace **USER CHECKPOINT**）。**`0.1.10` 已由用户上传，本计划任何步骤都不得再上传或操作 0.1.10。**
- `packages/cli/vendor/core-src/**` 由 `npm run sync-core` 生成，**不得手工编辑**；根 `npm test` 的 `pretest` 会自动同步。
- `packages/core/index.d.ts` 与 `packages/core/src/index.mjs` 必须同一次提交更新。
- 测试隔离：所有测试用 `AVENIC_STATE_DIR` 指向临时目录 + 临时项目目录（core 侧直接构造 `environment` 对象，插件侧用 `testEnv()`）；**禁止写真实用户主目录**；`probe.mjs` 的测试只打本地 mock server，**不发真实请求**。
- 每个 Task 结束时测试套件必须全绿；提交信息用仓库现有风格。

## 文件结构

| 文件 | 职责 |
|---|---|
| `packages/core/src/model/paths.mjs`（新增） | 库/项目/投影文件路径与常量 |
| `packages/core/src/model/schema.mjs`（新增） | 归一化、白名单校验、掩码、规范化 JSON、指纹 |
| `packages/core/src/model/transaction.mjs`（新增） | 通用事务写（读 → 变异 → 落盘 → 原子替换 → 版本戳重放） |
| `packages/core/src/model/library.mjs`（新增） | 库读写（list/get/upsert/remove） |
| `packages/core/src/model/project-claude.mjs`（新增） | Claude 投影合并 + 回滚账本（三态判定） |
| `packages/core/src/model/binding.mjs`（新增） | 项目绑定读写、dangling 处理、clear |
| `packages/core/src/model/inject.mjs`（新增） | Codex argv / OpenCode `OPENCODE_CONFIG_CONTENT` / Claude env；兼容性判定 |
| `packages/core/src/model/parse.mjs`（新增） | 粘贴识别（JSON 三形态 + 自由文本） |
| `packages/core/src/model/presets.mjs`（新增） | 6 个内置预设（只预填端点与 API 类型） |
| `packages/core/src/model/probe.mjs`（新增） | 测试连接（最小真实请求 + 结果分类） |
| `packages/core/src/model/gitignore.mjs`（新增） | `MODEL_RULES` + `ensureModelGitignore` |
| `packages/core/src/runtime/process.mjs` | cmd 行拼接的引号触发条件加 `& \| ^ < > ( )` |
| `packages/core/src/runtime/gitignore.mjs` | `removeRuntimeGitignore` 的可移除集合 + "路径仍存在则不删"守卫 |
| `packages/core/src/index.mjs`、`index.d.ts` | 导出与类型 |
| `packages/cli/src/cli/model-cli.mjs`（新增） | `avenic model` 子命令 |
| `packages/cli/src/cli/dispatcher.mjs` | `model` 分发 + 启动注入 |
| `packages/vscode/src/project.ts` | `projectRootForActiveEditor` |
| `packages/vscode/src/model/{protocol.ts,state.ts}`（新增） | vscode-free 消息白名单 + 面板数据组装 |
| `packages/vscode/src/services/model.ts`（新增） | 服务层薄包装 |
| `packages/vscode/src/dashboard/model-panel.ts`（新增） | `WebviewPanel` 薄壳 |
| `packages/vscode/src/commands/model-commands.ts`（新增） | 两个命令 |
| `packages/vscode/media/model/{view.html,main.js,style.css}`（新增） | 面板资源 |
| `packages/vscode/src/services/agents.ts`、`extension.ts`、`package.json` | 启动注入 + 注册 + 命令声明 |

---

### Task 1: core 路径 + schema（归一化 / 白名单 / 掩码 / 指纹）

**Files:**
- Create: `packages/core/src/model/paths.mjs`、`packages/core/src/model/schema.mjs`
- Modify: `packages/core/src/index.mjs`、`packages/core/index.d.ts`
- Test: `test/model-schema.test.mjs`

**Interfaces:**
- Consumes: `stateRoot`（`../skills/paths.mjs`）、`fail`（`../util/fail.mjs`）、`hashContent`（`../runtime/sessions.mjs`）
- Produces:
  - `modelsFile(environment?)`、`modelsTempRoot(environment?)`、`projectModelFile(projectRoot)`、`projectModelTempRoot(projectRoot)`、`claudeSettingsFile(projectRoot)`、`PROJECT_MODEL_FILE`、`CLAUDE_SETTINGS_FILE`、`LIBRARY_SCHEMA_VERSION`、`PROJECT_SCHEMA_VERSION`
  - `emptyLibrary()`、`normalizeProfile(input, options)`、`validateBaseUrl(value)`、`validateProviderId(value)`、`validateEnvKey(value)`、`validateModelId(value)`、`maskSecret(value)`、`canonicalJson(value)`、`libraryFingerprint(profile)`
  - `MODEL_ROLES = ["main","opus","sonnet","haiku","fable","subagent"]`

- [ ] **Step 1: 写失败测试**

创建 `test/model-schema.test.mjs`：

```js
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MODEL_ROLES,
  canonicalJson,
  libraryFingerprint,
  maskSecret,
  modelsFile,
  normalizeProfile,
  projectModelFile,
  validateBaseUrl,
  validateEnvKey,
  validateModelId,
  validateProviderId,
} from "../packages/core/src/index.mjs";

const ENVIRONMENT = { AVENIC_STATE_DIR: path.join(os.tmpdir(), "avenic-schema-state") };

test("model file paths live under the existing Avenic state root", () => {
  assert.equal(modelsFile(ENVIRONMENT), path.join(ENVIRONMENT.AVENIC_STATE_DIR, "models.json"));
  assert.equal(projectModelFile("C:\\proj"), path.join("C:\\proj", ".agents", "model.json"));
});

test("normalizeProfile fills defaults, pins timestamps and strips unknown top-level keys", () => {
  const profile = normalizeProfile(
    {
      id: "mimo",
      name: "小米 MiMo",
      endpoint: { baseUrl: "https://example.com/anthropic", api: "anthropic", apiKey: "sk-abcdefghijklmn" },
      models: { main: { id: "mimo-v2.5-pro" } },
      unknownKey: "ignored",
    },
    { now: "2026-09-10T00:00:00.000Z" },
  );
  assert.equal(profile.endpoint.authField, "ANTHROPIC_AUTH_TOKEN");
  assert.equal(profile.id, "mimo");
  assert.equal(profile.createdAt, "2026-09-10T00:00:00.000Z");
  assert.equal(profile.updatedAt, "2026-09-10T00:00:00.000Z");
  assert.deepEqual(profile.toggles, {});
  assert.deepEqual(profile.env, {});
  assert.deepEqual(profile.overrides, {});
  assert.equal("unknownKey" in profile, false);
  assert.deepEqual(Object.keys(profile.models), ["main"]);
  assert.equal(profile.codex.providerId, "avenic_mimo");
  assert.equal(profile.codex.envKey, "AVENIC_MODEL_KEY");
  assert.equal(profile.codex.reasoningEffort, "medium");
  assert.equal(profile.opencode.providerId, "mimo");
  assert.equal(profile.opencode.npmAdapter, "@ai-sdk/openai-compatible");
});

test("normalizeProfile keeps createdAt when updating an existing profile", () => {
  const created = normalizeProfile({ id: "a", name: "A", endpoint: { baseUrl: "https://a.example", api: "anthropic", apiKey: "sk-1" } }, { now: "2026-01-01T00:00:00.000Z" });
  const updated = normalizeProfile({ ...created, name: "A2" }, { now: "2026-02-02T00:00:00.000Z", existing: created });
  assert.equal(updated.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(updated.updatedAt, "2026-02-02T00:00:00.000Z");
  assert.equal(updated.name, "A2");
});

test("validation rejects cmd metacharacters, percent signs and empty values", () => {
  assert.equal(validateBaseUrl("https://gw.example/v1/api-version=2024-02-01"), "https://gw.example/v1/api-version=2024-02-01");
  assert.throws(() => validateBaseUrl("https://gw.example/v1?a=1&b=2"), /must not contain/i);
  assert.throws(() => validateBaseUrl("https://gw.example/v1?a=1%20b"), /must not contain/i);
  assert.throws(() => validateBaseUrl("https://gw.example/v1`x"), /must not contain/i);
  assert.throws(() => validateBaseUrl("not-a-url"), /must start with http/i);
  assert.equal(validateProviderId("avenic_mimo"), "avenic_mimo");
  assert.throws(() => validateProviderId("MiMo-Dash"), /provider id/i);
  assert.equal(validateEnvKey("AVENIC_MODEL_KEY"), "AVENIC_MODEL_KEY");
  assert.throws(() => validateEnvKey("modelKey"), /environment variable/i);
  assert.equal(validateModelId("mimo-v2.5-pro"), "mimo-v2.5-pro");
  assert.throws(() => validateModelId("mimo v2"), /model id/i);
});

test("maskSecret keeps three leading and four trailing characters", () => {
  assert.equal(maskSecret("sk-1234567890abcd"), "sk-…abcd");
  assert.equal(maskSecret("short"), "••••");
  assert.equal(maskSecret(undefined), "");
});

test("canonicalJson sorts keys recursively and libraryFingerprint is stable", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }), '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  const profile = normalizeProfile({ id: "a", name: "A", endpoint: { baseUrl: "https://a.example", api: "anthropic", apiKey: "sk-1" }, models: { main: { id: "m" } } }, { now: "2026-01-01T00:00:00.000Z" });
  assert.equal(libraryFingerprint(profile), libraryFingerprint({ ...profile }));
  assert.notEqual(libraryFingerprint(profile), libraryFingerprint({ ...profile, models: { main: { id: "other" } } }));
  assert.equal(libraryFingerprint(profile).startsWith("sha256:"), true);
  assert.deepEqual(MODEL_ROLES, ["main", "opus", "sonnet", "haiku", "fable", "subagent"]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/model-schema.test.mjs`
Expected: FAIL — 模块不存在（`Cannot find module .../model/schema.mjs`）

- [ ] **Step 3: 实现 `packages/core/src/model/paths.mjs`**

```js
import path from "node:path";
import { stateRoot } from "../skills/paths.mjs";

export const PROJECT_MODEL_FILE = ".agents/model.json";
export const CLAUDE_SETTINGS_FILE = ".claude/settings.local.json";
export const PROJECT_TEMP_ROOT = ".agents/tmp";
export const LIBRARY_SCHEMA_VERSION = 1;
export const PROJECT_SCHEMA_VERSION = 1;

// 机器级库：复用既有 Avenic 状态根（AVENIC_STATE_DIR → XDG_CONFIG_HOME → ~/.config + avenic），
// 与 catalog.json / lock.json 同住；CLI 与插件读同一份。绝不新建第二个状态根。
export function modelsFile(environment = process.env) {
  return path.join(stateRoot(environment), "models.json");
}

export function modelsTempRoot(environment = process.env) {
  return path.join(stateRoot(environment), "tmp");
}

export function projectModelFile(projectRoot) {
  return path.join(projectRoot, ...PROJECT_MODEL_FILE.split("/"));
}

export function projectTempRoot(projectRoot) {
  return path.join(projectRoot, ...PROJECT_TEMP_ROOT.split("/"));
}

export function claudeSettingsFile(projectRoot) {
  return path.join(projectRoot, ...CLAUDE_SETTINGS_FILE.split("/"));
}
```

- [ ] **Step 4: 实现 `packages/core/src/model/schema.mjs`**

```js
import { fail } from "../util/fail.mjs";
import { hashContent } from "../runtime/sessions.mjs";
import { LIBRARY_SCHEMA_VERSION } from "./paths.mjs";

export const MODEL_ROLES = ["main", "opus", "sonnet", "haiku", "fable", "subagent"];
export const API_TYPES = ["anthropic", "openai-chat", "openai-responses"];
export const AUTH_FIELDS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];
const TOGGLE_KEYS = ["teams", "toolSearch", "maxEffort", "noNonessentialTraffic", "noAutoUpdate", "hideAttribution"];

// cmd.exe 无法转义这些字符（引号内也会展开 %VAR%），且 .cmd 链路上 & | ^ < > ( ) 会被二次解析。
const FORBIDDEN_IN_VALUE = /[%"'`$&|^<>()!]/;
const BASE_URL = /^https?:\/\/[A-Za-z0-9._~:/?#\[\]@+,;=\-]+$/;

export function validateBaseUrl(value) {
  const text = String(value ?? "").trim();
  if (!/^https?:\/\//i.test(text)) fail(`Base URL must start with http:// or https://: ${text}`);
  if (FORBIDDEN_IN_VALUE.test(text)) {
    fail("Base URL must not contain % \" ' ` $ or the characters & | ^ < > ( ) !");
  }
  if (!BASE_URL.test(text)) fail(`Base URL is not a valid URL: ${text}`);
  return text;
}

export function validateProviderId(value) {
  const text = String(value ?? "").trim();
  if (!/^[a-z0-9_]{1,32}$/.test(text)) fail(`Invalid provider id (expected ^[a-z0-9_]{1,32}$): ${text}`);
  return text;
}

export function validateEnvKey(value) {
  const text = String(value ?? "").trim();
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(text)) fail(`Invalid environment variable name: ${text}`);
  return text;
}

export function validateModelId(value) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._:\-/]{1,128}$/.test(text)) fail(`Invalid model id: ${text}`);
  return text;
}

export function assertSafeId(value) {
  return validateProviderId(value); // profile id 与 provider id 同规则
}

// 掩码：前 3 后 4；过短一律全掩。所有对外输出（CLI/通知/日志/面板）都必须先过这里。
export function maskSecret(value) {
  const text = typeof value === "string" ? value : "";
  if (text.length === 0) return "";
  if (text.length <= 8) return "••••";
  return `${text.slice(0, 3)}…${text.slice(-4)}`;
}

// 递归键排序的稳定序列化：指纹与比较用。
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function normalizeModelRow(input) {
  if (input === null || input === undefined) return null;
  const id = validateModelId(input.id);
  const row = { id };
  if (typeof input.display === "string" && input.display.trim().length > 0) row.display = input.display.trim();
  if (input.longContext === true) row.longContext = true;
  return row;
}

function normalizeEndpoint(input, defaults = {}) {
  const source = input ?? {};
  const baseUrl = validateBaseUrl(source.baseUrl ?? defaults.baseUrl ?? fail("Base URL is required"));
  const api = source.api ?? defaults.api ?? "anthropic";
  if (!API_TYPES.includes(api)) fail(`Unknown API type: ${api}`);
  const authField = source.authField ?? defaults.authField ?? "ANTHROPIC_AUTH_TOKEN";
  if (!AUTH_FIELDS.includes(authField)) fail(`Unknown auth field: ${authField}`);
  return { baseUrl, api, authField, apiKey: String(source.apiKey ?? defaults.apiKey ?? "") };
}

// 归一化 = 白名单化：只保留设计里定义的字段，其余一律丢弃（粘贴/CLI/面板共用同一条路径）。
export function normalizeProfile(input, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const existing = options.existing ?? null;
  const id = assertSafeId(input.id ?? fail("Profile id is required"));
  const endpoint = normalizeEndpoint(input.endpoint);
  const overrides = {};
  for (const agentId of ["codex", "opencode"]) {
    const override = input.overrides?.[agentId];
    if (override) {
      overrides[agentId] = {
        ...normalizeEndpoint(override, { baseUrl: endpoint.baseUrl, api: endpoint.api, authField: endpoint.authField, apiKey: endpoint.apiKey }),
        providerId: override.providerId ? validateProviderId(override.providerId) : undefined,
      };
    }
  }
  const models = {};
  for (const role of MODEL_ROLES) {
    const row = normalizeModelRow(input.models?.[role]);
    if (row) models[role] = row;
  }
  const toggles = {};
  for (const key of TOGGLE_KEYS) {
    if (input.toggles?.[key] === true) toggles[key] = true;
  }
  const env = {};
  for (const [key, value] of Object.entries(input.env ?? {})) {
    env[validateEnvKey(key)] = String(value);
  }
  const claudeSettings = {};
  for (const [key, value] of Object.entries(input.claude?.settings ?? {})) {
    claudeSettings[key] = value;
  }
  return {
    id,
    name: String(input.name ?? existing?.name ?? id),
    endpoint,
    overrides,
    models,
    toggles,
    env,
    claude: { settings: claudeSettings },
    codex: {
      providerId: validateProviderId(input.codex?.providerId ?? `avenic_${id}`),
      envKey: validateEnvKey(input.codex?.envKey ?? "AVENIC_MODEL_KEY"),
      reasoningEffort: ["minimal", "low", "medium", "high"].includes(input.codex?.reasoningEffort)
        ? input.codex.reasoningEffort
        : "medium",
    },
    opencode: {
      providerId: validateProviderId(input.opencode?.providerId ?? id),
      npmAdapter: String(input.opencode?.npmAdapter ?? "@ai-sdk/openai-compatible"),
    },
    createdAt: existing?.createdAt ?? input.createdAt ?? now,
    updatedAt: now,
  };
}

export function emptyLibrary() {
  return { schemaVersion: LIBRARY_SCHEMA_VERSION, revision: 0, profiles: {} };
}

// 指纹覆盖全部会进入 Claude 投影的字段（端点/模型/开关/自定义 env/透传 settings），
// 与时间戳无关——库改了但投影相关字段没改时不应重写项目文件。
export function libraryFingerprint(profile) {
  const payload = {
    endpoint: profile.endpoint,
    models: profile.models,
    toggles: profile.toggles,
    env: profile.env,
    claude: profile.claude,
  };
  return `sha256:${hashContent(canonicalJson(payload))}`;
}
```

- [ ] **Step 5: 补导出**

`packages/core/src/index.mjs` 追加：

```js
export {
  API_TYPES,
  AUTH_FIELDS,
  MODEL_ROLES,
  assertSafeId,
  canonicalJson,
  emptyLibrary,
  libraryFingerprint,
  maskSecret,
  normalizeProfile,
  validateBaseUrl,
  validateEnvKey,
  validateModelId,
  validateProviderId,
} from "./model/schema.mjs";
export {
  CLAUDE_SETTINGS_FILE,
  LIBRARY_SCHEMA_VERSION,
  PROJECT_MODEL_FILE,
  PROJECT_SCHEMA_VERSION,
  claudeSettingsFile,
  modelsFile,
  modelsTempRoot,
  projectModelFile,
  projectTempRoot,
} from "./model/paths.mjs";
```

`packages/core/index.d.ts` 追加（放在文件末尾 `// ---- model ----` 段）：

```ts
// ---- model: paths & schema ----
export const PROJECT_MODEL_FILE: string;
export const CLAUDE_SETTINGS_FILE: string;
export const LIBRARY_SCHEMA_VERSION: number;
export const PROJECT_SCHEMA_VERSION: number;
export const MODEL_ROLES: readonly string[];
export const API_TYPES: readonly string[];
export const AUTH_FIELDS: readonly string[];
export type ApiType = "anthropic" | "openai-chat" | "openai-responses";
export type ModelRole = "main" | "opus" | "sonnet" | "haiku" | "fable" | "subagent";
export interface ModelRow { id: string; display?: string; longContext?: boolean }
export interface EndpointConfig { baseUrl: string; api: ApiType; authField: string; apiKey: string }
export interface ProfileOverrides { codex?: EndpointConfig & { providerId?: string }; opencode?: EndpointConfig & { providerId?: string } }
export interface ProfileToggles { teams?: boolean; toolSearch?: boolean; maxEffort?: boolean; noNonessentialTraffic?: boolean; noAutoUpdate?: boolean; hideAttribution?: boolean }
export interface ModelProfile {
  id: string;
  name: string;
  endpoint: EndpointConfig;
  overrides: ProfileOverrides;
  models: Partial<Record<ModelRole, ModelRow>>;
  toggles: ProfileToggles;
  env: Record<string, string>;
  claude: { settings: Record<string, unknown> };
  codex: { providerId: string; envKey: string; reasoningEffort: "minimal" | "low" | "medium" | "high" };
  opencode: { providerId: string; npmAdapter: string };
  createdAt: string;
  updatedAt: string;
}
export function modelsFile(environment?: ProcessEnvLike): string;
export function modelsTempRoot(environment?: ProcessEnvLike): string;
export function projectModelFile(projectRoot: string): string;
export function projectTempRoot(projectRoot: string): string;
export function claudeSettingsFile(projectRoot: string): string;
export function emptyLibrary(): { schemaVersion: number; revision: number; profiles: Record<string, ModelProfile> };
export function normalizeProfile(input: Partial<ModelProfile> & { id: string }, options?: { now?: string; existing?: ModelProfile | null }): ModelProfile;
export function validateBaseUrl(value: string): string;
export function validateProviderId(value: string): string;
export function validateEnvKey(value: string): string;
export function validateModelId(value: string): string;
export function assertSafeId(value: string): string;
export function maskSecret(value: unknown): string;
export function canonicalJson(value: unknown): string;
export function libraryFingerprint(profile: ModelProfile): string;
```

- [ ] **Step 6: 运行测试并提交**

Run: `node --test test/model-schema.test.mjs`
Expected: PASS（6 个用例）

```bash
git add packages/core/src/model/paths.mjs packages/core/src/model/schema.mjs packages/core/src/index.mjs packages/core/index.d.ts packages/cli/vendor/core-src test/model-schema.test.mjs
git commit -m "feat(core): model library paths, profile schema, value whitelists, masking"
```

---

### Task 2: 事务原语 `transact()` + 库读写

**Files:**
- Create: `packages/core/src/model/transaction.mjs`、`packages/core/src/model/library.mjs`
- Modify: `packages/core/src/index.mjs`、`packages/core/index.d.ts`
- Test: `test/model-library.test.mjs`

**Interfaces:**
- Consumes: `replaceStagedFiles`（`../skills/vendor.mjs`）、`readJson`/`writeJson`（`../util/json.mjs`）、`fail`、Task 1 的 schema/paths
- Produces:
  - `transact({ read, build, stage, tempRoot, attempts })` → `Promise<{ changed: boolean, value: unknown }>`
  - `readLibrary(environment)` → `{ revision, profiles, exists }`（损坏时 `fail`）
  - `getProfile(environment, id)` → `ModelProfile | null`
  - `listProfiles(environment)` → `ModelProfile[]`（按 name 排序）
  - `upsertProfile(environment, input)` / `removeProfile(environment, id)` → 事务写，返回 `{ changed, value, revision }`

- [ ] **Step 1: 写失败测试**

创建 `test/model-library.test.mjs`：

```js
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getProfile,
  listProfiles,
  modelsFile,
  readLibrary,
  removeProfile,
  transact,
  upsertProfile,
} from "../packages/core/src/index.mjs";

async function withTempDirectory(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function environmentFor(stateDir) {
  return { AVENIC_STATE_DIR: stateDir };
}

test("upsertProfile writes a versioned library with 0600 permissions", async () => {
  await withTempDirectory("avenic-lib-", async (stateDir) => {
    const environment = environmentFor(stateDir);
    assert.equal((await readLibrary(environment)).exists, false);

    const first = await upsertProfile(environment, {
      id: "mimo",
      name: "小米 MiMo",
      endpoint: { baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic", api: "anthropic", apiKey: "sk-aaaabbbbccccdddd" },
      models: { main: { id: "mimo-v2.5-pro" } },
    });
    assert.equal(first.changed, true);
    assert.equal(first.revision, 1);

    const stored = JSON.parse(await readFile(modelsFile(environment), "utf8"));
    assert.equal(stored.schemaVersion, 1);
    assert.equal(stored.revision, 1);
    assert.equal(stored.profiles.mimo.endpoint.apiKey, "sk-aaaabbbbccccdddd");
    assert.equal(stored.profiles.mimo.createdAt, stored.profiles.mimo.updatedAt);

    const second = await upsertProfile(environment, { ...stored.profiles.mimo, name: "MiMo 2" });
    assert.equal(second.revision, 2);
    const profiles = await listProfiles(environment);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].name, "MiMo 2");
    assert.equal(profiles[0].createdAt, stored.profiles.mimo.createdAt);

    const removed = await removeProfile(environment, "mimo");
    assert.equal(removed.changed, true);
    assert.deepEqual(await listProfiles(environment), []);
    assert.equal(await getProfile(environment, "mimo"), null);
  });
});

test("removeProfile on an unknown id changes nothing", async () => {
  await withTempDirectory("avenic-lib-missing-", async (stateDir) => {
    const environment = environmentFor(stateDir);
    await upsertProfile(environment, { id: "a", name: "A", endpoint: { baseUrl: "https://a.example", api: "anthropic", apiKey: "k" } });
    const result = await removeProfile(environment, "nope");
    assert.equal(result.changed, false);
    assert.equal((await readLibrary(environment)).revision, 1);
  });
});

test("a broken library file fails loudly and is never overwritten", async () => {
  await withTempDirectory("avenic-lib-broken-", async (stateDir) => {
    const environment = environmentFor(stateDir);
    const file = modelsFile(environment);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{ not json");
    await assert.rejects(() => readLibrary(environment), /Cannot parse JSON file/);
    await assert.rejects(
      () => upsertProfile(environment, { id: "a", name: "A", endpoint: { baseUrl: "https://a.example", api: "anthropic", apiKey: "k" } }),
      /Cannot parse JSON file/,
    );
    assert.equal(await readFile(file, "utf8"), "{ not json");
  });
});

test("transact rolls both files back when the second rename fails", async () => {
  await withTempDirectory("avenic-tx-", async (root) => {
    const first = path.join(root, "a.json");
    const second = path.join(root, "b.json");
    await writeFile(first, "old-a");
    await writeFile(second, "old-b");
    let renames = 0;
    await assert.rejects(
      () => transact({
        tempRoot: path.join(root, "tmp"),
        read: async () => ({ revision: 0, value: { first: await readFile(first, "utf8"), second: await readFile(second, "utf8") } }),
        build: () => ({ first: "new-a", second: "new-b" }),
        stage: async (next, directory) => {
          const staged = [];
          for (const [name, target] of [["a.json", first], ["b.json", second]]) {
            const file = path.join(directory, "staged", name);
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, next[name === "a.json" ? "first" : "second"]);
            staged.push({ relativePath: name, staged: file, target });
          }
          return staged;
        },
        rename: async (from, to) => {
          renames += 1;
          if (renames === 4) throw new Error("disk full"); // 第 2 个文件的 staged→target
          const { rename } = await import("node:fs/promises");
          return rename(from, to);
        },
      }),
      /disk full/,
    );
    assert.equal(await readFile(first, "utf8"), "old-a");
    assert.equal(await readFile(second, "utf8"), "old-b");
  });
});

test("transact replays when the revision changed under it", async () => {
  await withTempDirectory("avenic-tx-replay-", async (root) => {
    const target = path.join(root, "value.json");
    await writeFile(target, "0");
    let reads = 0;
    let builds = 0;
    const result = await transact({
      tempRoot: path.join(root, "tmp"),
      read: async () => {
        reads += 1;
        // 第一次替换前"另一个进程"写入了新内容：版本戳变化 → 本实现重读重放
        if (reads === 2) await writeFile(target, "external");
        return { revision: reads === 1 ? 0 : 1, value: await readFile(target, "utf8") };
      },
      build: (current) => {
        builds += 1;
        return current.value === "external" ? null : String(Number(current.value) + 1);
      },
      stage: async (next, directory) => {
        const file = path.join(directory, "staged", "value.json");
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, next);
        return [{ relativePath: "value.json", staged: file, target }];
      },
    });
    assert.equal(result.changed, false, "the replayed build saw the external value and opted out");
    assert.equal(await readFile(target, "utf8"), "external");
    assert.equal(builds, 2);
  });
});
```

> 最后一个用例用 `build` 返回 `null` 表达"重放后决定不改"，这就是 `build` 返回 `null` 的语义。第一个回滚用例通过 `transact` 的 `rename` 注入点制造第二次 rename 失败——`transact` 必须把 `rename` 透传给 `replaceStagedFiles`（见实现）。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/model-library.test.mjs`
Expected: FAIL — `transact is not a function`

- [ ] **Step 3: 实现 `transaction.mjs`**

```js
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { replaceStagedFiles } from "../skills/vendor.mjs";
import { fail } from "../util/fail.mjs";

// 通用事务写：
//   read()            → { revision, value }（磁盘现值 + 版本戳）
//   build(current)    → 新值；返回 null 表示"无需写入"
//   stage(next, dir)  → [{ relativePath, staged, target }]（staged 必须与 target 同卷）
// 并发：替换前重读版本戳；不一致则丢弃本次结果重放（最多 attempts 次）。
// 崩溃安全：最终是 rename 覆盖，磁盘上任何时刻要么旧内容要么新内容。
// 两个根（库 / 项目）各自独立事务：不同卷的文件绝不放进同一次替换。
export async function transact(options) {
  const { read, build, stage, tempRoot, attempts = 3, rename } = options;
  await mkdir(tempRoot, { recursive: true });
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    const current = await read();
    const next = await build(current);
    if (next === null) {
      return { changed: false, value: current.value, revision: current.revision };
    }
    const directory = path.join(tempRoot, `model-${process.pid}-${attempt}-${Date.now()}`);
    await mkdir(directory, { recursive: true });
    try {
      const replacements = await stage(next, directory);
      const fresh = await read();
      if (fresh.revision !== current.revision) {
        await rm(directory, { recursive: true, force: true });
        continue; // 有人先写了一步：重读重放
      }
      await replaceStagedFiles(replacements, directory, rename ? { rename } : undefined);
      await rm(directory, { recursive: true, force: true });
      return { changed: true, value: next, revision: current.revision + 1 };
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
  return fail("Configuration was modified by another window or process; please retry");
}
```

> **需要同步改一处既有代码**：`replaceStagedFiles(replacements, tempDirectory)` 目前直接调用 `node:fs/promises` 的 `rename`。给它加第三个可选参数 `options = {}`，用 `const renameFile = options.rename ?? rename;` 替换函数体内两处 `rename(...)` 调用（`vendor.mjs:34`、`:39`、`:42`、`:52`）。这是纯增量改动，既有调用不受影响，`test/vendor.test.mjs` 应保持全绿。

- [ ] **Step 4: 实现 `library.mjs`**

```js
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { readJson } from "../util/json.mjs";
import { fail } from "../util/fail.mjs";
import { emptyLibrary, normalizeProfile } from "./schema.mjs";
import { LIBRARY_SCHEMA_VERSION, modelsFile, modelsTempRoot } from "./paths.mjs";
import { transact } from "./transaction.mjs";

// 库是唯一事实来源：读失败一律 fail（不自动修复、不覆盖用户文件），由调用方提示
// "配置损坏"并给出文件路径（spec §13）。
export async function readLibrary(environment = process.env) {
  const file = modelsFile(environment);
  if (!existsSync(file)) {
    return { ...emptyLibrary(), exists: false, file };
  }
  const raw = await readJson(file); // 解析失败 → fail("Cannot parse JSON file ...")
  if (typeof raw !== "object" || raw === null || typeof raw.profiles !== "object" || raw.profiles === null) {
    fail(`Model library is malformed: ${file}`);
  }
  return {
    schemaVersion: raw.schemaVersion ?? LIBRARY_SCHEMA_VERSION,
    revision: Number.isInteger(raw.revision) ? raw.revision : 0,
    profiles: raw.profiles,
    exists: true,
    file,
  };
}

export async function listProfiles(environment = process.env) {
  const library = await readLibrary(environment);
  return Object.values(library.profiles).sort((left, right) => left.name.localeCompare(right.name));
}

export async function getProfile(environment, id) {
  const library = await readLibrary(environment);
  return library.profiles[id] ?? null;
}

// 落盘：先写临时文件（同卷），事务负责备份 + 原子替换 + 失败回滚。
async function stageLibrary(environment, next, directory) {
  const staged = path.join(directory, "staged", "models.json");
  await mkdir(path.dirname(staged), { recursive: true });
  await writeFile(staged, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return [{ relativePath: "models.json", staged, target: modelsFile(environment) }];
}

async function mutateLibrary(environment, mutate, io = console) {
  let written = null;
  const result = await transact({
    tempRoot: modelsTempRoot(environment),
    read: async () => {
      const library = await readLibrary(environment);
      return { revision: library.revision, value: library };
    },
    build: (current) => {
      const next = mutate(current.value);
      if (next === null) return null;
      written = { ...next, schemaVersion: LIBRARY_SCHEMA_VERSION, revision: current.revision + 1 };
      return written;
    },
    stage: (next, directory) => stageLibrary(environment, next, directory),
  });
  if (result.changed) {
    await protectLibraryFile(modelsFile(environment), io);
  }
  return { ...result, value: result.changed ? written : result.value };
}

// POSIX 0600；Windows 依赖用户目录 ACL（chmod 在 win32 上是 no-op，不报错）。
async function protectLibraryFile(file, io) {
  try {
    await chmod(file, 0o600);
  } catch (error) {
    io.warn?.(`Warning: could not restrict permissions on ${file} (${error.code ?? error.message})`);
  }
}

export async function upsertProfile(environment, input, io = console) {
  return mutateLibrary(environment, (library) => {
    const existing = library.profiles[input.id] ?? null;
    const profile = normalizeProfile(input, { existing });
    return { ...library, profiles: { ...library.profiles, [profile.id]: profile } };
  }, io);
}

export async function removeProfile(environment, id, io = console) {
  return mutateLibrary(environment, (library) => {
    if (!library.profiles[id]) return null;
    const profiles = { ...library.profiles };
    delete profiles[id];
    return { ...library, profiles };
  }, io);
}
```

> `Date.now()` 在 `transact` 的临时目录名里只用于唯一性，不参与任何持久化状态。

- [ ] **Step 5: 补导出与类型**

`index.mjs` 加：

```js
export { transact } from "./model/transaction.mjs";
export { getProfile, listProfiles, readLibrary, removeProfile, upsertProfile } from "./model/library.mjs";
```

`index.d.ts` 加：

```ts
export interface ModelLibrary { schemaVersion: number; revision: number; profiles: Record<string, ModelProfile>; exists: boolean; file: string }
export interface TransactOptions<T> {
  read: () => Promise<{ revision: number; value: T }>;
  build: (current: { revision: number; value: T }) => T | null;
  stage: (next: T, directory: string) => Promise<Array<{ relativePath: string; staged: string; target: string }>>;
  tempRoot: string;
  attempts?: number;
}
export function transact<T>(options: TransactOptions<T>): Promise<{ changed: boolean; value: T }>;
export function readLibrary(environment?: ProcessEnvLike): Promise<ModelLibrary>;
export function listProfiles(environment?: ProcessEnvLike): Promise<ModelProfile[]>;
export function getProfile(environment: ProcessEnvLike | undefined, id: string): Promise<ModelProfile | null>;
export function upsertProfile(environment: ProcessEnvLike | undefined, input: Partial<ModelProfile> & { id: string }, io?: Io): Promise<{ changed: boolean; revision: number; value: unknown }>;
export function removeProfile(environment: ProcessEnvLike | undefined, id: string, io?: Io): Promise<{ changed: boolean; revision: number; value: unknown }>;
```

- [ ] **Step 6: 运行测试并提交**

Run: `node --test test/model-library.test.mjs && node --test test/vendor.test.mjs`
Expected: PASS（5 + 既有 vendor 用例）

```bash
git add packages/core/src/model/transaction.mjs packages/core/src/model/library.mjs packages/core/src/skills/vendor.mjs packages/core/src/index.mjs packages/core/index.d.ts packages/cli/vendor/core-src test/model-library.test.mjs
git commit -m "feat(core): transactional model library with revision compare-and-replay"
```

---

### Task 3: Claude 投影 + 回滚账本

**Files:**
- Create: `packages/core/src/model/project-claude.mjs`
- Modify: `packages/core/src/index.mjs`、`packages/core/index.d.ts`
- Test: `test/model-projection.test.mjs`

**Interfaces:**
- Consumes: Task 1/2 的 schema 与 paths；`isDeepStrictEqual`（`node:util`）
- Produces:
  - `buildClaudeEntries(profile)` → `Array<{ path: string[], value: unknown }>`（受管键 → 目标值，顺序稳定）
  - `readPath(object, pathArray)` / `writePath(object, pathArray, value)` / `deletePath(object, pathArray)`
  - `mergeClaudeSettings(existing, entries)` → `{ content, ledger, created }`（`ledger` = `[{ path, before, written }]`）
  - `rollbackClaudeSettings(existing, ledger)` → `{ content, conflicts }`

- [ ] **Step 1: 写失败测试**

创建 `test/model-projection.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClaudeEntries,
  mergeClaudeSettings,
  normalizeProfile,
  rollbackClaudeSettings,
} from "../packages/core/src/index.mjs";

const PROFILE = normalizeProfile(
  {
    id: "mimo",
    name: "小米 MiMo",
    endpoint: { baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic", api: "anthropic", apiKey: "sk-aaaabbbbccccdddd" },
    models: {
      main: { id: "mimo-v2.5-pro" },
      opus: { id: "mimo-v2.5-pro", display: "mimo-v2.5-pro", longContext: true },
      haiku: { id: "mimo-v2.5" },
      subagent: { id: "mimo-v2.5" },
    },
    toggles: { teams: true, toolSearch: true, maxEffort: true, noNonessentialTraffic: true, hideAttribution: true },
    env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "131072" },
    claude: { settings: { theme: "dark" } },
  },
  { now: "2026-09-10T00:00:00.000Z" },
);

test("buildClaudeEntries maps profile fields onto Claude settings paths", () => {
  const entries = buildClaudeEntries(PROFILE);
  const flat = Object.fromEntries(entries.map((entry) => [entry.path.join("."), entry.value]));
  assert.equal(flat["env.ANTHROPIC_BASE_URL"], "https://token-plan-cn.xiaomimimo.com/anthropic");
  assert.equal(flat["env.ANTHROPIC_AUTH_TOKEN"], "sk-aaaabbbbccccdddd");
  assert.equal(flat["env.ANTHROPIC_MODEL"], "mimo-v2.5-pro");
  assert.equal(flat["env.ANTHROPIC_DEFAULT_OPUS_MODEL"], "mimo-v2.5-pro[1m]");
  assert.equal(flat["env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME"], "mimo-v2.5-pro");
  assert.equal(flat["env.ANTHROPIC_DEFAULT_HAIKU_MODEL"], "mimo-v2.5");
  assert.equal(flat["env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME"], undefined, "no display name → no _NAME key");
  assert.equal(flat["env.CLAUDE_CODE_SUBAGENT_MODEL"], "mimo-v2.5");
  assert.equal(flat["env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"], "1");
  assert.equal(flat["env.ENABLE_TOOL_SEARCH"], "true");
  assert.equal(flat["env.CLAUDE_CODE_EFFORT_LEVEL"], "max");
  assert.equal(flat["env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"], "1");
  assert.equal(flat["env.DISABLE_AUTOUPDATER"], undefined, "noAutoUpdate is off → key not written");
  assert.deepEqual(flat["attribution"], { commit: "", pr: "" });
  assert.equal(flat["env.CLAUDE_CODE_MAX_OUTPUT_TOKENS"], "131072");
  assert.equal(flat.theme, "dark");
  assert.equal(entries.every((entry) => entry.value === undefined || typeof entry.value !== "number"), true);
});

test("mergeClaudeSettings preserves unknown keys and records an exact ledger", () => {
  const existing = {
    permissions: { allow: ["Bash(git status)"] },
    statusLine: { type: "command", command: "x" },
    env: { ANTHROPIC_MODEL: "original-model", MY_VAR: "keep" },
  };
  const { content, ledger, created } = mergeClaudeSettings(existing, buildClaudeEntries(PROFILE));
  assert.equal(created, false);
  assert.deepEqual(content.permissions, existing.permissions);
  assert.deepEqual(content.statusLine, existing.statusLine);
  assert.equal(content.env.MY_VAR, "keep");
  assert.equal(content.env.ANTHROPIC_MODEL, "mimo-v2.5-pro");
  const model = ledger.find((entry) => entry.path.join(".") === "env.ANTHROPIC_MODEL");
  assert.deepEqual(model.before, { exists: true, value: "original-model" });
  assert.equal(model.written, "mimo-v2.5-pro");
  const baseUrl = ledger.find((entry) => entry.path.join(".") === "env.ANTHROPIC_BASE_URL");
  assert.deepEqual(baseUrl.before, { exists: false });
  assert.equal(JSON.stringify(content).includes("undefined"), false);
});

test("rollback restores, deletes and reports conflicts per entry", () => {
  const existing = { env: { ANTHROPIC_MODEL: "mimo-v2.5-pro", ANTHROPIC_BASE_URL: "https://x.example" }, attribution: { commit: "", pr: "" } };
  const ledger = [
    { path: ["env", "ANTHROPIC_MODEL"], before: { exists: true, value: "original-model" }, written: "mimo-v2.5-pro" },
    { path: ["env", "ANTHROPIC_BASE_URL"], before: { exists: false }, written: "https://x.example" },
    { path: ["attribution"], before: { exists: true, value: { commit: "", pr: "" } }, written: { commit: "", pr: "" } },
    { path: ["env", "ANTHROPIC_AUTH_TOKEN"], before: { exists: false }, written: "sk-secret" },
  ];
  const { content, conflicts } = rollbackClaudeSettings(existing, ledger);
  assert.equal(content.env.ANTHROPIC_MODEL, "original-model");
  assert.equal("ANTHROPIC_BASE_URL" in content.env, false);
  assert.equal("ANTHROPIC_AUTH_TOKEN" in content.env, false);
  assert.deepEqual(content.attribution, { commit: "", pr: "" });
  assert.deepEqual(conflicts.map((entry) => entry.path.join(".")), ["env.ANTHROPIC_AUTH_TOKEN"]);
  assert.equal(conflicts[0].current, undefined);
});

test("rollback never touches a key the user edited after projection", () => {
  const existing = { env: { ANTHROPIC_MODEL: "user-edited" } };
  const ledger = [{ path: ["env", "ANTHROPIC_MODEL"], before: { exists: true, value: "original-model" }, written: "mimo-v2.5-pro" }];
  const { content, conflicts } = rollbackClaudeSettings(existing, ledger);
  assert.equal(content.env.ANTHROPIC_MODEL, "user-edited");
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].current, "user-edited");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/model-projection.test.mjs`
Expected: FAIL — `buildClaudeEntries is not a function`

- [ ] **Step 3: 实现 `project-claude.mjs`**

```js
import { isDeepStrictEqual } from "node:util";

// Claude Code 走"项目内物化投影"：把库里的 profile 合并写进 .claude/settings.local.json，
// 并逐条记账（before/written）以便精确回滚（spec §5.1/§6）。
// 所有值转字符串：Claude Code 的 settings.env 只接受字符串。

const ROLE_KEYS = { opus: "OPUS", sonnet: "SONNET", haiku: "HAIKU", fable: "FABLE" };
const TOGGLE_ENTRIES = [
  ["teams", ["env", "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"], "1"],
  ["toolSearch", ["env", "ENABLE_TOOL_SEARCH"], "true"],
  ["maxEffort", ["env", "CLAUDE_CODE_EFFORT_LEVEL"], "max"],
  ["noNonessentialTraffic", ["env", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"], "1"],
  ["noAutoUpdate", ["env", "DISABLE_AUTOUPDATER"], "1"],
];

export function buildClaudeEntries(profile) {
  const entries = [];
  const push = (path, value) => entries.push({ path, value });
  const env = (key, value) => push(["env", key], value);

  env("ANTHROPIC_BASE_URL", profile.endpoint.baseUrl);
  if (profile.endpoint.apiKey) env(profile.endpoint.authField, profile.endpoint.apiKey);

  const models = profile.models ?? {};
  if (models.main) env("ANTHROPIC_MODEL", models.main.id);
  for (const [role, suffix] of Object.entries(ROLE_KEYS)) {
    const row = models[role];
    if (!row) continue;
    const id = row.longContext ? `${row.id}[1m]` : row.id;
    env(`ANTHROPIC_DEFAULT_${suffix}_MODEL`, id);
    if (row.display) env(`ANTHROPIC_DEFAULT_${suffix}_MODEL_NAME`, row.display);
  }
  if (models.subagent) env("CLAUDE_CODE_SUBAGENT_MODEL", models.subagent.id);

  for (const [toggle, path, value] of TOGGLE_ENTRIES) {
    if (profile.toggles?.[toggle] === true) push(path, value);
  }
  if (profile.toggles?.hideAttribution === true) push(["attribution"], { commit: "", pr: "" });

  for (const [key, value] of Object.entries(profile.env ?? {})) env(key, String(value));
  for (const [key, value] of Object.entries(profile.claude?.settings ?? {})) push([key], value);
  return entries;
}

export function readPath(object, pathArray) {
  let cursor = object;
  for (const key of pathArray) {
    if (cursor === null || typeof cursor !== "object" || !Object.hasOwn(cursor, key)) {
      return { exists: false };
    }
    cursor = cursor[key];
  }
  return { exists: true, value: cursor };
}

export function writePath(object, pathArray, value) {
  let cursor = object;
  for (const key of pathArray.slice(0, -1)) {
    if (cursor[key] === null || typeof cursor[key] !== "object") cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[pathArray.at(-1)] = value;
}

export function deletePath(object, pathArray) {
  let cursor = object;
  for (const key of pathArray.slice(0, -1)) {
    if (cursor?.[key] === null || typeof cursor?.[key] !== "object") return;
    cursor = cursor[key];
  }
  delete cursor[pathArray.at(-1)];
}

// 合并写：只动本次受管的键，其余（permissions/hooks/statusLine/未知键）原样保留。
export function mergeClaudeSettings(existing, entries) {
  const created = existing === null || existing === undefined;
  const content = created ? {} : structuredClone(existing);
  const ledger = [];
  for (const entry of entries) {
    const before = readPath(content, entry.path);
    writePath(content, entry.path, entry.value);
    ledger.push({
      path: entry.path,
      before: before.exists ? { exists: true, value: structuredClone(before.value) } : { exists: false },
      written: structuredClone(entry.value),
    });
  }
  return { content, ledger, created };
}

// 逐条判定：当前值 === written → 还原 before（或删键）；否则记为 conflict 一律不动（spec §6）。
export function rollbackClaudeSettings(existing, ledger) {
  const content = existing === null || existing === undefined ? {} : structuredClone(existing);
  const conflicts = [];
  for (const entry of ledger ?? []) {
    const current = readPath(content, entry.path);
    const matches = current.exists === true && isDeepStrictEqual(current.value, entry.written);
    if (!matches) {
      conflicts.push({ path: entry.path, current: current.exists ? current.value : undefined });
      continue;
    }
    if (entry.before.exists) {
      writePath(content, entry.path, structuredClone(entry.before.value));
    } else {
      deletePath(content, entry.path);
    }
  }
  return { content, conflicts };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/model-projection.test.mjs`
Expected: PASS（4 个用例）

- [ ] **Step 5: 补导出与类型并提交**

`index.mjs` 加：

```js
export {
  buildClaudeEntries,
  deletePath,
  mergeClaudeSettings,
  readPath,
  rollbackClaudeSettings,
  writePath,
} from "./model/project-claude.mjs";
```

`index.d.ts` 加：

```ts
export interface LedgerEntry { path: string[]; before: { exists: boolean; value?: unknown }; written: unknown }
export interface RollbackConflict { path: string[]; current: unknown }
export function buildClaudeEntries(profile: ModelProfile): Array<{ path: string[]; value: unknown }>;
export function readPath(object: unknown, path: string[]): { exists: boolean; value?: unknown };
export function writePath(object: Record<string, unknown>, path: string[], value: unknown): void;
export function deletePath(object: Record<string, unknown>, path: string[]): void;
export function mergeClaudeSettings(existing: Record<string, unknown> | null, entries: Array<{ path: string[]; value: unknown }>): { content: Record<string, unknown>; ledger: LedgerEntry[]; created: boolean };
export function rollbackClaudeSettings(existing: Record<string, unknown> | null, ledger: LedgerEntry[]): { content: Record<string, unknown>; conflicts: RollbackConflict[] };
```

```bash
git add packages/core/src/model/project-claude.mjs packages/core/src/index.mjs packages/core/index.d.ts packages/cli/vendor/core-src test/model-projection.test.mjs
git commit -m "feat(core): Claude settings projection with per-key rollback ledger"
```

---

### Task 4: 项目绑定 + dangling（`binding.mjs`）

**Files:**
- Create: `packages/core/src/model/binding.mjs`
- Modify: `packages/core/src/index.mjs`、`packages/core/index.d.ts`
- Test: `test/model-binding.test.mjs`

**Interfaces:**
- Consumes: Task 1-3 的全部；`projectAuthEnvironment`（`../runtime/config.mjs`，用于判断 project 认证模式）
- Produces:
  - `readBinding(projectRoot)` → `{ value, exists }`（默认 `{schemaVersion:1, revision:0, activeProfileId:null, overrides:{}, projection:{}}`）
  - `projectModelStatus(projectRoot, environment)` → `{ projectRoot, binding, profile|null, dangling, projection, message|null }`
  - `bindProject(projectRoot, environment, profileId)` → 事务写 `.agents/model.json` + `.claude/settings.local.json`
  - `clearProjectBinding(projectRoot, environment)` → 回滚 + `activeProfileId = null`，返回 `{ conflicts }`
  - `resolveProjectProfile(projectRoot, environment)` → `{ profile|null, binding, cleaned, message|null }`（dangling 已处理）
  - `DANGLING_MESSAGE(id)` = `` `Profile "${id}" no longer exists; Avenic configuration disabled for this project.` ``

- [ ] **Step 1: 写失败测试**

创建 `test/model-binding.test.mjs`：

```js
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bindProject,
  clearProjectBinding,
  projectModelFile,
  projectModelStatus,
  readBinding,
  removeProfile,
  resolveProjectProfile,
  upsertProfile,
} from "../packages/core/src/index.mjs";

async function withTempDirectory(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const PROFILE_INPUT = {
  id: "mimo",
  name: "小米 MiMo",
  endpoint: { baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic", api: "anthropic", apiKey: "sk-aaaabbbbccccdddd" },
  models: { main: { id: "mimo-v2.5-pro" } },
};

async function withProject(run) {
  await withTempDirectory("avenic-bind-project-", async (projectRoot) => {
    await withTempDirectory("avenic-bind-state-", async (stateDir) => {
      await run({ projectRoot, environment: { AVENIC_STATE_DIR: stateDir } });
    });
  });
}

test("bindProject writes the binding and the Claude projection, then clear restores it", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, PROFILE_INPUT);
    const settings = path.join(projectRoot, ".claude", "settings.local.json");
    await mkdir(path.dirname(settings), { recursive: true });
    await writeFile(settings, `${JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, env: { ANTHROPIC_MODEL: "original" } }, null, 2)}\n`);

    const bound = await bindProject(projectRoot, environment, "mimo");
    assert.equal(bound.binding.activeProfileId, "mimo");
    const written = JSON.parse(await readFile(settings, "utf8"));
    assert.equal(written.env.ANTHROPIC_MODEL, "mimo-v2.5-pro");
    assert.deepEqual(written.permissions, { allow: ["Bash(ls)"] });
    assert.equal(bound.projection.keys > 0, true);
    const binding = JSON.parse(await readFile(projectModelFile(projectRoot), "utf8"));
    assert.equal(binding.projection.claude.file, ".claude/settings.local.json");
    assert.equal(binding.projection.claude.created, false);
    assert.equal(binding.projection.claude.entries.length, bound.projection.keys);

    const cleared = await clearProjectBinding(projectRoot, environment);
    assert.deepEqual(cleared.conflicts, []);
    const restored = JSON.parse(await readFile(settings, "utf8"));
    assert.equal(restored.env.ANTHROPIC_MODEL, "original");
    assert.equal("ANTHROPIC_BASE_URL" in restored.env, false);
    assert.deepEqual(restored.permissions, { allow: ["Bash(ls)"] });
    assert.equal((await readBinding(projectRoot)).value.activeProfileId, null);
    assert.equal(existsSync(projectModelFile(projectRoot)), true);
  });
});

test("clear deletes a settings file that this feature created itself", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, PROFILE_INPUT);
    await bindProject(projectRoot, environment, "mimo");
    const settings = path.join(projectRoot, ".claude", "settings.local.json");
    assert.equal(existsSync(settings), true);
    await clearProjectBinding(projectRoot, environment);
    assert.equal(existsSync(settings), false, "created by Avenic and now empty → removed");
  });
});

test("re-applying the same profile writes nothing (fingerprint match)", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, PROFILE_INPUT);
    await bindProject(projectRoot, environment, "mimo");
    const settings = path.join(projectRoot, ".claude", "settings.local.json");
    const before = JSON.parse(await readFile(settings, "utf8"));
    const again = await bindProject(projectRoot, environment, "mimo");
    assert.equal(again.changed, false);
    assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), before);
  });
});

test("a deleted profile is cleaned up once and then stays quiet (idempotent dangling)", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, PROFILE_INPUT);
    await bindProject(projectRoot, environment, "mimo");
    await removeProfile(environment, "mimo");

    const status = await projectModelStatus(projectRoot, environment);
    assert.equal(status.profile, null);
    assert.equal(status.dangling, true);
    assert.equal(status.message, 'Profile "mimo" no longer exists; Avenic configuration disabled for this project.');

    const resolved = await resolveProjectProfile(projectRoot, environment);
    assert.equal(resolved.profile, null);
    assert.equal(resolved.cleaned, true);
    assert.equal(resolved.message, 'Profile "mimo" no longer exists; Avenic configuration disabled for this project.');
    assert.equal((await readBinding(projectRoot)).value.activeProfileId, null);
    const settings = JSON.parse(await readFile(path.join(projectRoot, ".claude", "settings.local.json"), "utf8"));
    assert.equal("ANTHROPIC_BASE_URL" in (settings.env ?? {}), false);

    const second = await resolveProjectProfile(projectRoot, environment);
    assert.equal(second.cleaned, false, "nothing left to clean");
    assert.equal(second.message, null, "no repeated warning");
  });
});

test("dangling cleanup keeps user-edited managed keys and reports them", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, PROFILE_INPUT);
    await bindProject(projectRoot, environment, "mimo");
    const settings = path.join(projectRoot, ".claude", "settings.local.json");
    const content = JSON.parse(await readFile(settings, "utf8"));
    content.env.ANTHROPIC_MODEL = "hand-edited";
    await writeFile(settings, `${JSON.stringify(content, null, 2)}\n`);
    await removeProfile(environment, "mimo");

    const resolved = await resolveProjectProfile(projectRoot, environment);
    assert.equal(resolved.conflicts.length, 1);
    assert.equal(resolved.conflicts[0].path.join("."), "env.ANTHROPIC_MODEL");
    assert.equal(JSON.parse(await readFile(settings, "utf8")).env.ANTHROPIC_MODEL, "hand-edited");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/model-binding.test.mjs`
Expected: FAIL — `bindProject is not a function`

- [ ] **Step 3: 实现 `binding.mjs`**

```js
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { readJson } from "../util/json.mjs";
import { fail } from "../util/fail.mjs";
import { transact } from "./transaction.mjs";
import { getProfile } from "./library.mjs";
import { libraryFingerprint } from "./schema.mjs";
import {
  CLAUDE_SETTINGS_FILE,
  PROJECT_SCHEMA_VERSION,
  claudeSettingsFile,
  projectModelFile,
  projectTempRoot,
} from "./paths.mjs";
import {
  buildClaudeEntries,
  mergeClaudeSettings,
  rollbackClaudeSettings,
} from "./project-claude.mjs";

export function danglingMessage(profileId) {
  return `Profile "${profileId}" no longer exists; Avenic configuration disabled for this project.`;
}

function emptyBinding() {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    revision: 0,
    activeProfileId: null,
    overrides: {},
    projection: {},
  };
}

export async function readBinding(projectRoot) {
  const file = projectModelFile(projectRoot);
  if (!existsSync(file)) {
    return { value: emptyBinding(), exists: false, file };
  }
  const raw = await readJson(file);
  if (typeof raw !== "object" || raw === null) {
    fail(`Project model binding is malformed: ${file}`);
  }
  return {
    value: {
      schemaVersion: raw.schemaVersion ?? PROJECT_SCHEMA_VERSION,
      revision: Number.isInteger(raw.revision) ? raw.revision : 0,
      activeProfileId: raw.activeProfileId ?? null,
      overrides: raw.overrides ?? {},
      projection: raw.projection ?? {},
    },
    exists: true,
    file,
  };
}

async function readClaudeSettings(projectRoot) {
  const file = claudeSettingsFile(projectRoot);
  if (!existsSync(file)) return null;
  return readJson(file); // 解析失败 → fail（不自动修复、不覆盖：spec §13）
}

// 项目事务：库文件不在同一个卷上，因此项目写入（绑定 + 投影）永远是独立事务。
async function writeProjectFiles(projectRoot, nextBinding, nextSettings) {
  const settingsPath = claudeSettingsFile(projectRoot);
  const replacements = [];
  replacements.push({
    relativePath: "model.json",
    staged: await stage(projectRoot, "model.json", nextBinding),
    target: projectModelFile(projectRoot),
  });
  if (nextSettings === null) {
    replacements.push({ relativePath: "settings.local.json", remove: true, target: settingsPath });
  } else {
    replacements.push({
      relativePath: "settings.local.json",
      staged: await stage(projectRoot, "settings.local.json", nextSettings),
      target: settingsPath,
    });
  }
  return replacements;
}

async function stage(projectRoot, name, value) {
  const directory = path.join(projectTempRoot(projectRoot), "staged");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, name);
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return file;
}

// 通用项目事务：read 同时读回绑定与投影文件，build 生成两份新内容（或 null = 不改）。
async function transactProject(projectRoot, build, io = console) {
  return transact({
    tempRoot: projectTempRoot(projectRoot),
    read: async () => {
      const binding = await readBinding(projectRoot);
      const settings = await readClaudeSettings(projectRoot);
      return { revision: binding.value.revision, value: { binding: binding.value, settings } };
    },
    build: (current) => build(current.value),
    stage: (next, directory) => writeProjectFiles(projectRoot, next.binding, next.settings),
  });
}
```

> 上面的 `writeProjectFiles` 里多了一个 `remove: true` 的类型（"投影文件需要被删除"）。`replaceStagedFiles` 不支持删除，所以在 `binding.mjs` 内实现一个更贴合的小替换器：见下方 `commitProject`。把 `writeProjectFiles` 改成纯"生成 staged 文件"函数，替换/删除由 `commitProject` 统一处理：

```js
// 项目侧替换：settings 为 null 表示"删除该文件"（仅当 created === true 且回滚后为空）。
// 其余与 replaceStagedFiles 同语义：先备份 → 再 rename → 任一步失败则整体回滚。
async function commitProject(replacements, directory) {
  const { mkdir, rename, rm } = await import("node:fs/promises");
  const completed = [];
  try {
    for (const replacement of replacements) {
      const backup = path.join(directory, "backup", replacement.relativePath);
      await mkdir(path.dirname(backup), { recursive: true });
      let hasBackup = false;
      if (existsSync(replacement.target)) {
        await rename(replacement.target, backup);
        hasBackup = true;
      }
      if (replacement.remove) {
        completed.push({ ...replacement, backup, hasBackup, removed: true });
        continue;
      }
      await mkdir(path.dirname(replacement.target), { recursive: true });
      try {
        await rename(replacement.staged, replacement.target);
      } catch (error) {
        if (hasBackup) await rename(backup, replacement.target);
        throw error;
      }
      completed.push({ ...replacement, backup, hasBackup });
    }
  } catch (error) {
    for (const replacement of completed.reverse()) {
      await rm(replacement.target, { recursive: true, force: true });
      if (replacement.hasBackup && existsSync(replacement.backup)) {
        await rename(replacement.backup, replacement.target);
      }
    }
    throw error;
  }
}
```

因此 `transactProject` 的 `stage` 回调改为 `(next, directory) => stageProjectFiles(projectRoot, next, directory)`，`transact` 需要支持注入替换器：把 Task 2 的 `transact` 增加 `options.commit`（默认 `replaceStagedFiles`，签名 `(replacements, directory) => Promise<void>`），`commitProject` 在项目侧作为 `commit` 传入。**Task 2 的测试不受影响**（`commit` 有默认值）。

- [ ] **Step 4: 实现 `binding.mjs` 的四个公开函数**

```js
// 绑定 + 投影是一次事务：要么两份文件都更新，要么都不动。
export async function bindProject(projectRoot, environment, profileId, io = console) {
  const profile = await getProfile(environment, profileId);
  if (!profile) fail(`Unknown profile: ${profileId}`);
  const fingerprint = libraryFingerprint(profile);
  const entries = buildClaudeEntries(profile);
  let changed = false;
  const result = await transactProject(projectRoot, (current) => {
    const projection = current.binding.projection?.claude ?? null;
    if (current.binding.activeProfileId === profileId && projection?.fingerprint === fingerprint) {
      return null; // 指纹一致 → 零写入（不刷新文件时间戳）
    }
    // 换绑：先把上一份投影安全回滚，再按新 profile 投影（避免残留上一个 profile 的键）
    const rolled = rollbackClaudeSettings(current.settings, projection?.entries ?? []);
    const merged = mergeClaudeSettings(rolled.content, entries);
    changed = true;
    return {
      binding: {
        ...current.binding,
        revision: current.binding.revision + 1,
        activeProfileId: profileId,
        projection: {
          ...current.binding.projection,
          claude: {
            file: CLAUDE_SETTINGS_FILE,
            fingerprint,
            created: projection?.created ?? merged.created,
            entries: merged.ledger,
          },
        },
      },
      settings: merged.content,
    };
  }, io);
  return {
    changed: result.changed && changed,
    binding: result.value.binding,
    projection: {
      file: CLAUDE_SETTINGS_FILE,
      fingerprint,
      keys: entries.length,
    },
  };
}

// 取消绑定：按账本安全回滚（用户改过的键不动），清空 entries，activeProfileId 置 null。
export async function clearProjectBinding(projectRoot, environment, io = console) {
  const current = await readBinding(projectRoot);
  const projection = current.value.projection?.claude ?? null;
  if (!current.exists || (current.value.activeProfileId === null && !projection?.entries?.length)) {
    return { changed: false, conflicts: [], binding: current.value };
  }
  let conflicts = [];
  const result = await transactProject(projectRoot, (value) => {
    const settings = value.settings;
    const rolled = rollbackClaudeSettings(settings, projection?.entries ?? []);
    conflicts = rolled.conflicts;
    // created === true 且回滚后为空对象 → 删除该文件（spec §6 收尾）
    const shouldRemove = projection?.created === true && Object.keys(rolled.content).length === 0;
    return {
      binding: {
        ...value.binding,
        revision: value.binding.revision + 1,
        activeProfileId: null,
        projection: {
          ...value.binding.projection,
          claude: projection ? { file: projection.file, created: projection.created, entries: [] } : undefined,
        },
      },
      settings: shouldRemove ? null : rolled.content,
    };
  }, io);
  return { changed: result.changed, conflicts, binding: result.value.binding };
}

export async function projectModelStatus(projectRoot, environment) {
  const binding = (await readBinding(projectRoot)).value;
  const id = binding.activeProfileId;
  if (id === null) {
    return { projectRoot, binding, profile: null, dangling: false, projection: null, message: null };
  }
  const profile = await getProfile(environment, id);
  if (!profile) {
    return { projectRoot, binding, profile: null, dangling: true, projection: null, message: danglingMessage(id) };
  }
  const projection = binding.projection?.claude ?? null;
  return {
    projectRoot,
    binding,
    profile,
    dangling: false,
    projection: projection
      ? {
          file: projection.file,
          keys: projection.entries?.length ?? 0,
          fingerprint: projection.fingerprint ?? null,
          fingerprintMatches: projection.fingerprint === libraryFingerprint(profile),
        }
      : null,
    message: null,
  };
}

// 启动前调用：dangling 时安全回滚 + 置 null（幂等，第二次返回 cleaned:false / message:null）。
export async function resolveProjectProfile(projectRoot, environment, io = console) {
  const status = await projectModelStatus(projectRoot, environment);
  if (!status.dangling) {
    return { profile: status.profile, binding: status.binding, cleaned: false, conflicts: [], message: null };
  }
  const cleared = await clearProjectBinding(projectRoot, environment, io);
  const suffix = cleared.conflicts.length > 0
    ? `\nConflicting keys left untouched: ${cleared.conflicts.map((entry) => entry.path.join(".")).join(", ")}`
    : "";
  return {
    profile: null,
    binding: cleared.binding,
    cleaned: true,
    conflicts: cleared.conflicts,
    message: `${status.message}${suffix}`,
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/model-binding.test.mjs`
Expected: PASS（5 个用例）。若 `created` 语义不符（例如文件本来不存在时 `settings.local.json` 不应被删除的用例失败），检查 `mergeClaudeSettings` 的 `created` 是否透传到了 `projection.claude.created`。

- [ ] **Step 6: 补导出与类型并提交**

`index.mjs` 加：

```js
export {
  bindProject,
  clearProjectBinding,
  danglingMessage,
  projectModelStatus,
  readBinding,
  resolveProjectProfile,
} from "./model/binding.mjs";
```

同时给 `transact` 补 `commit` 选项（`transaction.mjs`）：

```js
export async function transact(options = {}) {
  const commit = options.commit ?? replaceStagedFiles;
  // ...其余不变，最后一行改为：
      await commit(replacements, directory);
```

`index.d.ts` 加：

```ts
export interface ProjectBinding {
  schemaVersion: number;
  revision: number;
  activeProfileId: string | null;
  overrides: Record<string, unknown>;
  projection: {
    claude?: { file: string; fingerprint: string; created: boolean; entries: LedgerEntry[] };
  };
}
export interface ProjectModelStatus {
  projectRoot: string;
  binding: ProjectBinding;
  profile: ModelProfile | null;
  dangling: boolean;
  projection: { file: string; keys: number; fingerprint: string | null; fingerprintMatches: boolean } | null;
  message: string | null;
}
export function danglingMessage(profileId: string): string;
export function readBinding(projectRoot: string): Promise<{ value: ProjectBinding; exists: boolean; file: string }>;
export function bindProject(projectRoot: string, environment: ProcessEnvLike | undefined, profileId: string, io?: Io): Promise<{ changed: boolean; binding: ProjectBinding; projection: { file: string; fingerprint: string; keys: number } }>;
export function clearProjectBinding(projectRoot: string, environment: ProcessEnvLike | undefined, io?: Io): Promise<{ changed: boolean; conflicts: RollbackConflict[]; binding: ProjectBinding }>;
export function projectModelStatus(projectRoot: string, environment: ProcessEnvLike | undefined): Promise<ProjectModelStatus>;
export function resolveProjectProfile(projectRoot: string, environment: ProcessEnvLike | undefined, io?: Io): Promise<{ profile: ModelProfile | null; binding: ProjectBinding; cleaned: boolean; conflicts: RollbackConflict[]; message: string | null }>;
```

```bash
git add packages/core/src/model/binding.mjs packages/core/src/model/transaction.mjs packages/core/src/index.mjs packages/core/index.d.ts packages/cli/vendor/core-src test/model-binding.test.mjs
git commit -m "feat(core): project model binding, transactional projection, dangling cleanup"
```

---

### Task 5: 启动注入（Codex argv / OpenCode env / Claude env）+ 兼容性判定

**Files:**
- Create: `packages/core/src/model/inject.mjs`
- Modify: `packages/core/src/index.mjs`、`packages/core/index.d.ts`
- Test: `test/model-inject.test.mjs`

**Interfaces:**
- Consumes: Task 1-4
- Produces:
  - `agentCompatibility(profile)` → `{ claude: {ok, reason?}, codex: {ok, reason?}, opencode: {ok, reason?} }`
  - `codexInjection(profile, { argumentsList, environment })` → `{ argumentsList, environment, skipped: string[] }`
  - `opencodeInjection(profile, environment)` → `{ environment, providerId, mode: "builtin-override" | "custom-provider" }`
  - `claudeEnvironment(profile)` → `Record<string, string>`（投影文件的兜底；见 Step 5 说明）
  - `buildLaunchInjection({ agentId, profile, argumentsList, environment })` → `{ argumentsList, environment, note: string | null }`

- [ ] **Step 1: 写失败测试**

创建 `test/model-inject.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  agentCompatibility,
  buildLaunchInjection,
  codexInjection,
  normalizeProfile,
  opencodeInjection,
} from "../packages/core/src/index.mjs";

const ANTHROPIC_PROFILE = normalizeProfile(
  {
    id: "mimo",
    name: "小米 MiMo",
    endpoint: { baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic", api: "anthropic", apiKey: "sk-aaaabbbbccccdddd" },
    overrides: { codex: { baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", api: "openai-responses" } },
    models: { main: { id: "mimo-v2.5-pro" }, haiku: { id: "mimo-v2.5" } },
  },
  { now: "2026-09-10T00:00:00.000Z" },
);

test("compatibility marks the Anthropic-only endpoint as unsupported for Codex unless overridden", () => {
  const withoutOverride = normalizeProfile({ ...ANTHROPIC_PROFILE, overrides: {} }, { now: "2026-09-10T00:00:00.000Z" });
  assert.deepEqual(agentCompatibility(withoutOverride).codex.ok, false);
  assert.match(agentCompatibility(withoutOverride).codex.reason, /Responses API/);
  assert.equal(agentCompatibility(withoutOverride).claude.ok, true);
  assert.equal(agentCompatibility(withoutOverride).opencode.ok, true);
  assert.equal(agentCompatibility(ANTHROPIC_PROFILE).codex.ok, true);
});

test("codexInjection builds unquoted -c pairs and the provider key", () => {
  const injected = codexInjection(ANTHROPIC_PROFILE, { argumentsList: [], environment: { PATH: "/bin" } });
  assert.deepEqual(injected.argumentsList, [
    "-c", "model_provider=avenic_mimo",
    "-c", "model_providers.avenic_mimo.name=小米 MiMo",
    "-c", "model_providers.avenic_mimo.base_url=https://token-plan-cn.xiaomimimo.com/v1",
    "-c", "model_providers.avenic_mimo.env_key=AVENIC_MODEL_KEY",
    "-c", "model_providers.avenic_mimo.wire_api=responses",
    "-m", "mimo-v2.5-pro",
  ]);
  assert.equal(injected.argumentsList.some((argument) => argument.includes('"')), false);
  assert.equal(injected.environment.AVENIC_MODEL_KEY, "sk-aaaabbbbccccdddd");
  assert.deepEqual(injected.skipped, []);
});

test("codexInjection yields to user-provided -m and model_provider", () => {
  const injected = codexInjection(ANTHROPIC_PROFILE, {
    argumentsList: ["-m", "user-model", "-c", "model_provider=user_provider"],
    environment: {},
  });
  assert.deepEqual(injected.argumentsList, ["-m", "user-model", "-c", "model_provider=user_provider"]);
  assert.equal(injected.environment.AVENIC_MODEL_KEY, "sk-aaaabbbbccccdddd");
  assert.deepEqual(injected.skipped.sort(), ["model", "model_provider"]);
});

test("opencodeInjection overrides the built-in anthropic provider for Anthropic endpoints", () => {
  const injected = opencodeInjection(ANTHROPIC_PROFILE, {});
  assert.equal(injected.mode, "builtin-override");
  assert.equal(injected.providerId, "anthropic");
  const config = JSON.parse(injected.environment.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.model, "anthropic/mimo-v2.5-pro");
  assert.equal(config.small_model, "anthropic/mimo-v2.5");
  assert.equal(config.provider.anthropic.options.baseURL, "https://token-plan-cn.xiaomimimo.com/anthropic");
  assert.equal(config.provider.anthropic.options.apiKey, "sk-aaaabbbbccccdddd");
});

test("opencodeInjection declares a custom provider for OpenAI-style endpoints", () => {
  const profile = normalizeProfile(
    {
      id: "kimi",
      name: "Kimi",
      endpoint: { baseUrl: "https://api.moonshot.cn/v1", api: "openai-chat", apiKey: "sk-kimi" },
      models: { main: { id: "kimi-k2" } },
    },
    { now: "2026-09-10T00:00:00.000Z" },
  );
  const injected = opencodeInjection(profile, {});
  assert.equal(injected.mode, "custom-provider");
  const config = JSON.parse(injected.environment.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.provider.kimi.npm, "@ai-sdk/openai-compatible");
  assert.deepEqual(Object.keys(config.provider.kimi.models), ["kimi-k2"]);
  assert.equal(config.model, "kimi/kimi-k2");
});

test("buildLaunchInjection returns the injection for the requested agent only", () => {
  const codex = buildLaunchInjection({ agentId: "codex", profile: ANTHROPIC_PROFILE, argumentsList: [], environment: { PATH: "/bin" } });
  assert.equal(codex.argumentsList.length > 0, true);
  assert.equal(codex.environment.AVENIC_MODEL_KEY, "sk-aaaabbbbccccdddd");

  const opencode = buildLaunchInjection({ agentId: "opencode", profile: ANTHROPIC_PROFILE, argumentsList: ["--help"], environment: {} });
  assert.deepEqual(opencode.argumentsList, ["--help"], "opencode takes no argv injection");
  assert.equal(typeof opencode.environment.OPENCODE_CONFIG_CONTENT, "string");

  const claude = buildLaunchInjection({ agentId: "claude", profile: ANTHROPIC_PROFILE, argumentsList: [], environment: {} });
  assert.equal(claude.environment.ANTHROPIC_BASE_URL, "https://token-plan-cn.xiaomimimo.com/anthropic");
  assert.deepEqual(claude.argumentsList, []);
});

test("incompatible agent yields a note and an untouched launch", () => {
  const profile = { ...ANTHROPIC_PROFILE, overrides: {} };
  const result = buildLaunchInjection({ agentId: "codex", profile, argumentsList: [], environment: {} });
  assert.deepEqual(result.argumentsList, []);
  assert.equal(result.environment.AVENIC_MODEL_KEY, undefined);
  assert.match(result.note, /does not support this profile/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/model-inject.test.mjs`
Expected: FAIL — `codexInjection is not a function`

- [ ] **Step 3: 实现 `inject.mjs`**

```js
import { fail } from "../util/fail.mjs";

// 注入契约（spec §5.2/§5.3）：
//   Codex     → 启动 argv（-c 键值对 + -m），值一律不加引号
//   OpenCode  → OPENCODE_CONFIG_CONTENT（运行时覆盖，优先级高于项目 opencode.json）
//   Claude    → 环境变量兜底（settings 文件的 env 会覆盖同名 shell 变量，因此同时注入无副作用）
// 全部由 core 生成：CLI 与插件只把结果交给 spawn / terminal。

function endpointFor(profile, agentId) {
  return profile.overrides?.[agentId] ?? profile.endpoint;
}

export function agentCompatibility(profile) {
  const codexEndpoint = profile.overrides?.codex ?? null;
  const codexOk = Boolean(codexEndpoint);
  return {
    claude: { ok: true },
    codex: codexOk
      ? { ok: true }
      : { ok: false, reason: "Codex 需要 Responses API 端点（openai-responses）；该配置只有 Anthropic 端点" },
    opencode: { ok: true },
  };
}

function hasFlag(argumentsList, names) {
  return argumentsList.some((argument) => names.includes(argument) || names.some((name) => argument.startsWith(`${name}=`)));
}

export function codexInjection(profile, options = {}) {
  const argumentsList = [...(options.argumentsList ?? [])];
  const environment = { ...(options.environment ?? {}) };
  const skipped = [];
  if (!agentCompatibility(profile).codex.ok) {
    fail(`Codex does not support this profile: ${profile.name}`);
  }
  environment[profile.codex.envKey] = profile.endpoint.apiKey;
  const endpoint = endpointFor(profile, "codex");
  const providerId = profile.overrides?.codex?.providerId ?? profile.codex.providerId;
  const pairs = [];
  if (hasFlag(argumentsList, ["-c"]) && argumentsList.some((argument) => argument.startsWith("model_provider="))) {
    skipped.push("model_provider");
  } else {
    pairs.push(["model_provider", providerId]);
  }
  pairs.push(["model_providers.%ID%.name".replace("%ID%", providerId), profile.name]);
  pairs.push(["model_providers.%ID%.base_url".replace("%ID%", providerId), endpoint.baseUrl]);
  pairs.push(["model_providers.%ID%.env_key".replace("%ID%", providerId), profile.codex.envKey]);
  pairs.push(["model_providers.%ID%.wire_api".replace("%ID%", providerId), "responses"]);
  const injection = pairs.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
  if (hasFlag(argumentsList, ["-m", "--model"])) {
    skipped.push("model");
  } else if (profile.models?.main) {
    injection.push("-m", profile.models.main.id);
  }
  // argv 里不允许出现引号：Windows 上引号会变成字面量、POSIX 上有类型含义（spec §3.1）
  for (const argument of injection) {
    if (argument.includes('"')) fail(`Refusing to inject a quoted Codex argument: ${argument}`);
  }
  argumentsList.unshift(...injection);
  return { argumentsList, environment, skipped };
}

export function opencodeInjection(profile, environment = {}) {
  const endpoint = endpointFor(profile, "opencode");
  const mainModel = profile.models?.main?.id ?? null;
  const smallModel = profile.models?.haiku?.id ?? null;
  const merged = { ...environment };
  if (endpoint.api === "anthropic") {
    // 官方支持覆盖内置 anthropic provider 的 options.baseURL / options.apiKey（spec §3.1）
    const providerId = "anthropic";
    const config = {
      model: mainModel ? `${providerId}/${mainModel}` : undefined,
      small_model: smallModel ? `${providerId}/${smallModel}` : undefined,
      provider: {
        [providerId]: {
          options: { baseURL: endpoint.baseUrl, apiKey: endpoint.apiKey },
        },
      },
    };
    merged.OPENCODE_CONFIG_CONTENT = JSON.stringify(stripUndefined(config));
    return { environment: merged, providerId, mode: "builtin-override" };
  }
  const providerId = profile.opencode.providerId;
  const models = {};
  for (const id of new Set([mainModel, smallModel].filter(Boolean))) {
    models[id] = {};
  }
  const config = {
    model: mainModel ? `${providerId}/${mainModel}` : undefined,
    small_model: smallModel ? `${providerId}/${smallModel}` : undefined,
    provider: {
      [providerId]: {
        npm: profile.opencode.npmAdapter,
        name: profile.name,
        options: { baseURL: endpoint.baseUrl, apiKey: endpoint.apiKey },
        models,
      },
    },
  };
  merged.OPENCODE_CONFIG_CONTENT = JSON.stringify(stripUndefined(config));
  return { environment: merged, providerId, mode: "custom-provider" };
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, stripUndefined(item)]),
    );
  }
  return value;
}

// Claude 的环境变量兜底：settings.local.json 的 env 会覆盖同名 shell 变量（§3.1），
// 因此文件存在时这条注入不改变行为；project 认证下 Claude 若不读项目 settings（§3.3 实测项 2），
// 这条注入就是唯一生效路径。
export function claudeEnvironment(profile) {
  const values = {
    ANTHROPIC_BASE_URL: profile.endpoint.baseUrl,
    [profile.endpoint.authField]: profile.endpoint.apiKey,
    ANTHROPIC_MODEL: profile.models?.main?.id,
  };
  const roles = { opus: "OPUS", sonnet: "SONNET", haiku: "HAIKU", fable: "FABLE" };
  for (const [role, suffix] of Object.entries(roles)) {
    const row = profile.models?.[role];
    if (!row) continue;
    values[`ANTHROPIC_DEFAULT_${suffix}_MODEL`] = row.longContext ? `${row.id}[1m]` : row.id;
    if (row.display) values[`ANTHROPIC_DEFAULT_${suffix}_MODEL_NAME`] = row.display;
  }
  if (profile.models?.subagent) values.CLAUDE_CODE_SUBAGENT_MODEL = profile.models.subagent.id;
  return stripUndefined(values);
}

export function buildLaunchInjection({ agentId, profile, argumentsList = [], environment = {} }) {
  if (!profile) {
    return { argumentsList, environment, note: null };
  }
  const compatibility = agentCompatibility(profile);
  if (agentId === "claude") {
    return { argumentsList, environment: { ...environment, ...claudeEnvironment(profile) }, note: null };
  }
  if (agentId === "opencode") {
    const injected = opencodeInjection(profile, environment);
    return { argumentsList, environment: injected.environment, note: null };
  }
  if (agentId === "codex") {
    if (!compatibility.codex.ok) {
      return {
        argumentsList,
        environment,
        note: `Codex does not support this profile (${compatibility.codex.reason}) — using its global configuration.`,
      };
    }
    const injected = codexInjection(profile, { argumentsList, environment });
    return { argumentsList: injected.argumentsList, environment: injected.environment, note: null };
  }
  return { argumentsList, environment, note: null };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/model-inject.test.mjs`
Expected: PASS（7 个用例）

- [ ] **Step 5: 记录实测项 2 的结论**

在实施机上执行一次真机探针（隔离目录，不触碰真实配置）：

```bash
mkdir -p /tmp/probe2 && cd /tmp/probe2
CLAUDE_CONFIG_DIR=/tmp/probe2/cfg mkdir -p .claude /tmp/probe2/cfg
cat > .claude/settings.local.json <<'JSON'
{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:9/probe" } }
JSON
CLAUDE_CONFIG_DIR=/tmp/probe2/cfg claude -p "hi" --output-format json 2>&1 | head -5
```

判定：错误信息里出现 `127.0.0.1:9`（或请求发往该地址）→ **读**项目 settings；否则 → **不读**。
把结论写进 `docs/superpowers/specs/2026-09-10-project-model-config-design.md` §3.3 第 2 条（把"仍需实现期实测"改成实测结论与日期），并保留 `claudeEnvironment`（两种结论下它都会被 `buildLaunchInjection` 使用，理由见上面代码注释）。

- [ ] **Step 6: 补导出与类型并提交**

`index.mjs` 加：

```js
export {
  agentCompatibility,
  buildLaunchInjection,
  claudeEnvironment,
  codexInjection,
  opencodeInjection,
} from "./model/inject.mjs";
```

`index.d.ts` 加：

```ts
export interface AgentCompatibility { claude: { ok: boolean; reason?: string }; codex: { ok: boolean; reason?: string }; opencode: { ok: boolean; reason?: string } }
export function agentCompatibility(profile: ModelProfile): AgentCompatibility;
export function codexInjection(profile: ModelProfile, options: { argumentsList?: string[]; environment?: Record<string, string> }): { argumentsList: string[]; environment: Record<string, string>; skipped: string[] };
export function opencodeInjection(profile: ModelProfile, environment?: Record<string, string>): { environment: Record<string, string>; providerId: string; mode: "builtin-override" | "custom-provider" };
export function claudeEnvironment(profile: ModelProfile): Record<string, string>;
export function buildLaunchInjection(input: { agentId: string; profile: ModelProfile | null; argumentsList?: string[]; environment?: Record<string, string> }): { argumentsList: string[]; environment: Record<string, string>; note: string | null };
```

```bash
git add packages/core/src/model/inject.mjs packages/core/src/index.mjs packages/core/index.d.ts packages/cli/vendor/core-src test/model-inject.test.mjs docs/superpowers/specs/2026-09-10-project-model-config-design.md
git commit -m "feat(core): launch injection for codex argv, opencode config content, claude env"
```

---

### Task 6: `process.mjs` 的 cmd 行加固

**Files:**
- Modify: `packages/core/src/runtime/process.mjs:33-37`
- Test: `test/process-cmd.test.mjs`（新增）

**Interfaces:**
- Consumes: 无
- Produces: `invocation()` 的引号触发条件从 `/[\s"]/` 扩大到 `/[\s"&|^<>()]/`（win32 `.cmd/.bat` 路径）

- [ ] **Step 1: 写失败测试**

创建 `test/process-cmd.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { spawnExecutableSync } from "../packages/core/src/index.mjs";

// 只有 win32 会走 cmd 行拼接；其他平台断言等价的直启行为（不抛错）。
test("cmd shim arguments containing & are quoted before reaching the shell", { skip: process.platform !== "win32" }, async () => {
  const lines = [];
  const result = spawnExecutableSync("cmd", ["/c", "echo", "?"], {
    env: process.env,
    shell: false,
    stdio: "pipe",
    encoding: "utf8",
  });
  assert.equal(typeof result.status, "number");
  lines.push(result.status);
  assert.equal(lines.length, 1);
});

test("invocation keeps plain arguments untouched", { skip: process.platform !== "win32" }, () => {
  // 用 node 自身作为可执行文件（.exe，不触发 cmd 拼接）验证不回归
  const result = spawnExecutableSync(process.execPath, ["-e", "process.stdout.write('ok')"], {
    env: process.env,
    stdio: "pipe",
    encoding: "utf8",
  });
  assert.equal(result.stdout.trim(), "ok");
});
```

> 真正的行为断言在 win32 上通过一个 `.cmd` 桩完成：把下面这段写入临时目录的 `avenic-args.cmd`（`@echo off` + `echo %*`），再用 `spawnExecutableSync(<桩路径>, ["https://x.example/v1?a=1&b=2"])` 断言输出里 `&b=2` 仍在同一行——加固前会在 `&` 处被切断。测试用 `mkdtemp` 建目录，结束时删除；POSIX 上该用例 `skip`。实现时把这个用例补全（`test/process-cmd.test.mjs` 的第三个 test）。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/process-cmd.test.mjs`
Expected: FAIL — win32 上 `&b=2` 落到第二行（或 `'b' 不是内部或外部命令`）

- [ ] **Step 3: 实现**

`packages/core/src/runtime/process.mjs:34`：

```js
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(resolved)) {
    // cmd.exe 会把 & | ^ < > ( ) 当作元字符二次解析——即使它们在参数中间。
    // 白名单（model/schema.mjs 的 validateBaseUrl）已经拒绝这些字符，但用户自带参数
    // （如 `avenic codex --cd "a&b"`）仍会经过这里，因此拼接层必须同样加固。
    const needsQuotes = /[\s"&|^<>()]/;
    const quoted = argumentsList.map((argument) => (needsQuotes.test(argument) ? `"${argument}"` : argument));
    const line = [resolved, ...quoted].map((part) => (needsQuotes.test(part) ? `"${part}"` : part)).join(" ");
    return { command: line, argumentsList: [], shell: true };
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/process-cmd.test.mjs && npm test`
Expected: 全绿（既有 `test/runtime.test.mjs` 不受影响）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/runtime/process.mjs packages/cli/vendor/core-src test/process-cmd.test.mjs
git commit -m "fix(core): quote cmd metacharacters when spawning .cmd shims"
```

---

### Task 7: 粘贴识别 `parse.mjs`

**Files:**
- Create: `packages/core/src/model/parse.mjs`
- Modify: `packages/core/src/index.mjs`、`packages/core/index.d.ts`
- Test: `test/model-parse.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 schema（`validateBaseUrl` 等只用于校验，识别阶段只做识别）
- Produces:
  - `parseConfigJson(text)` → `{ form: "claude-settings" | "flat" | "cc-switch" | "unknown", recognized: Array<{field, value}>, passthrough: Record<string, unknown>, candidates: Record<string, unknown[]> }`
  - `parseConfigText(text)` → `{ recognized: Array<{ field, value, source }>, candidates: Record<string, string[]>, warnings: string[] }`
  - `recognizeEnvMap(env)` → `{ recognized, candidates }`（两个 parse 的共用内核）

- [ ] **Step 1: 写失败测试**

创建 `test/model-parse.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { parseConfigJson, parseConfigText, recognizeEnvMap } from "../packages/core/src/index.mjs";

test("parseConfigJson recognizes a Claude settings blob and keeps unknown keys as passthrough", () => {
  const result = parseConfigJson(JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "https://api.example.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "sk-aaaabbbbccccdddd",
      ANTHROPIC_MODEL: "example-large",
    },
    theme: "dark",
    permissions: { allow: ["Bash(ls)"] },
  }));
  assert.equal(result.form, "claude-settings");
  const fields = Object.fromEntries(result.recognized.map((entry) => [entry.field, entry.value]));
  assert.equal(fields.baseUrl, "https://api.example.com/anthropic");
  assert.equal(fields.apiKey, "sk-aaaabbbbccccdddd");
  assert.equal(fields.mainModel, "example-large");
  assert.deepEqual(Object.keys(result.passthrough).sort(), ["permissions", "theme"]);
});

test("parseConfigJson accepts flat key/value shapes and cc-switch wrappers", () => {
  const flat = parseConfigJson(JSON.stringify({ base_url: "https://b.example/v1", api_key: "sk-bbbb", model: "b-large" }));
  assert.equal(flat.form, "flat");
  assert.equal(flat.recognized.find((entry) => entry.field === "baseUrl").value, "https://b.example/v1");

  const wrapped = parseConfigJson(JSON.stringify({ settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://c.example", ANTHROPIC_MODEL: "c-large" } } }));
  assert.equal(wrapped.form, "cc-switch");
  assert.equal(wrapped.recognized.find((entry) => entry.field === "baseUrl").value, "https://c.example");
  assert.throws(() => parseConfigJson("{ not json"), /JSON/i);
});

test("recognizeEnvMap lists every candidate instead of silently picking the first", () => {
  const { recognized, candidates } = recognizeEnvMap({
    ANTHROPIC_BASE_URL: "https://one.example",
    BASE_URL: "https://two.example",
    ANTHROPIC_AUTH_TOKEN: "sk-one",
    API_KEY: "sk-two",
    CUSTOM_MODEL: "nope",
  });
  assert.equal(recognized.find((entry) => entry.field === "baseUrl").value, "https://one.example");
  assert.deepEqual(candidates.baseUrl, ["https://one.example", "https://two.example"]);
  assert.deepEqual(candidates.apiKey, ["sk-one", "sk-two"]);
});

test("parseConfigText reads shell export blocks and chat fragments", () => {
  const shell = parseConfigText(`
    export ANTHROPIC_BASE_URL=https://token-plan-cn.xiaomimimo.com/anthropic
    export ANTHROPIC_AUTH_TOKEN="sk-aaaabbbbccccdddd"
    export ANTHROPIC_DEFAULT_HAIKU_MODEL=mimo-v2.5-r1
  `);
  const fields = Object.fromEntries(shell.recognized.map((entry) => [entry.field, entry.value]));
  assert.equal(fields.baseUrl, "https://token-plan-cn.xiaomimimo.com/anthropic");
  assert.equal(fields.apiKey, "sk-aaaabbbbccccdddd");
  assert.equal(fields.haikuModel, "mimo-v2.5-r1");

  const chat = parseConfigText(`
    这是我的配置：
    地址 https://api.moonshot.cn/v1
    密钥 sk-moonshot1234567890
    主模型 kimi-k2
  `);
  const chatFields = Object.fromEntries(chat.recognized.map((entry) => [entry.field, entry.value]));
  assert.equal(chatFields.baseUrl, "https://api.moonshot.cn/v1");
  assert.equal(chatFields.apiKey, "sk-moonshot1234567890");
  assert.equal(chatFields.mainModel, "kimi-k2");
});

test("parseConfigText leaves the model empty when no model key is present", () => {
  const result = parseConfigText("https://x.example/v1 sk-abcdefgh");
  assert.equal(result.recognized.some((entry) => entry.field.endsWith("Model")), false);
  assert.equal(result.warnings.some((warning) => /model/i.test(warning)), true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/model-parse.test.mjs`
Expected: FAIL — `parseConfigJson is not a function`

- [ ] **Step 3: 实现 `parse.mjs`**

```js
// 粘贴识别：纯函数、无 IO，供 CLI（--json）、插件与测试共用（spec §10）。
// 原则：多候选全部列出、绝不静默取第一个；识别不出模型名就留空并提示。

const BASE_URL_KEY = /^(ANTHROPIC_BASE_URL|BASE_URL|API_BASE|base_?url|api_?base)$/i;
const API_KEY_KEY = /^(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|API_?KEY|AUTH_?TOKEN|TOKEN)$/i;
const MODEL_KEY = /(^|_)(MODEL|MODEL_NAME)$/i;
const ROLE_PREFIX = [
  ["opus", /(^|_)(OPUS)(_|$)/i],
  ["sonnet", /(^|_)(SONNET)(_|$)/i],
  ["haiku", /(^|_)(HAIKU)(_|$)/i],
  ["fable", /(^|_)(FABLE)(_|$)/i],
  ["subagent", /(^|_)(SUBAGENT)(_|$)/i],
];
const FREE_KEY = /sk-[A-Za-z0-9_-]{8,}/;
const FREE_URL = /https?:\/\/[^\s"'`<>]+/;

function roleFor(key) {
  for (const [role, pattern] of ROLE_PREFIX) {
    if (pattern.test(key)) return role;
  }
  return "main";
}

export function recognizeEnvMap(env) {
  const candidates = { baseUrl: [], apiKey: [] };
  const models = {};
  for (const [key, raw] of Object.entries(env)) {
    const value = String(raw).trim().replace(/^["']|["']$/g, "");
    if (!value) continue;
    if (BASE_URL_KEY.test(key)) {
      candidates.baseUrl.push(value);
      continue;
    }
    if (API_KEY_KEY.test(key)) {
      candidates.apiKey.push(value);
      continue;
    }
    if (MODEL_KEY.test(key)) {
      const role = roleFor(key);
      (models[role] ??= []).push(value);
    }
  }
  const recognized = [];
  if (candidates.baseUrl.length > 0) recognized.push({ field: "baseUrl", value: candidates.baseUrl[0] });
  if (candidates.apiKey.length > 0) recognized.push({ field: "apiKey", value: candidates.apiKey[0] });
  for (const [role, values] of Object.entries(models)) {
    recognized.push({ field: `${role}Model`, value: values[0] });
  }
  return { recognized, candidates: { ...candidates, ...models } };
}

function flatLookup(source) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

export function parseConfigJson(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot parse JSON: ${error.message}`);
  }
  const recognized = [];
  let candidates = {};
  let passthrough = {};
  let form = "unknown";
  const settings = raw?.env && typeof raw.env === "object" ? raw : raw?.settingsConfig?.env ? raw.settingsConfig : null;
  if (settings) {
    form = raw === settings ? "claude-settings" : "cc-switch";
    ({ recognized, candidates } = recognizeEnvMap(settings.env));
    passthrough = Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "env"));
    return { form, recognized, passthrough, candidates };
  }
  if (raw !== null && typeof raw === "object") {
    form = "flat";
    ({ recognized, candidates } = recognizeEnvMap(flatLookup(raw)));
    return { form, recognized, passthrough, candidates };
  }
  return { form, recognized, passthrough, candidates };
}

export function parseConfigText(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const env = {};
  for (const line of lines) {
    const assignment = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.+?)\s*$/);
    if (assignment) {
      env[assignment[1]] = assignment[2].replace(/^["']|["']$/g, "");
      continue;
    }
    // 自由文本：`地址 https://…` / `密钥 sk-…` / `主模型 kimi-k2`
    const url = line.match(FREE_URL);
    if (url) env.FREE_BASE_URL = url[0];
    const key = line.match(FREE_KEY);
    if (key) env.FREE_API_KEY = key[0];
    const model = line.match(/(?:model|模型)\s*[:：=]?\s*([A-Za-z0-9._:\-/]{2,128})/i);
    if (model) env[`${roleFor(line)}_MODEL_FREE`] = model[1];
  }
  delete env.FREE_BASE_URL;
  delete env.FREE_API_KEY;
  const { recognized, candidates } = recognizeEnvMap({
    ...env,
    ...(lines.some((line) => FREE_URL.test(line)) ? { PLAIN_BASE_URL: String(text).match(FREE_URL)[0] } : {}),
    ...(lines.some((line) => FREE_KEY.test(line)) ? { PLAIN_API_KEY: String(text).match(FREE_KEY)[0] } : {}),
  });
  const warnings = [];
  if (!recognized.some((entry) => entry.field.endsWith("Model"))) {
    warnings.push("未识别到模型名，请在表单中手工填写");
  }
  for (const entry of recognized) {
    entry.source = "pasted";
  }
  return { recognized, candidates, warnings };
}
```

> 实现时把上面的自由文本分支写干净：先按行扫 `KEY=value` / `KEY: value`，再对整段文本做一次 URL / `sk-…` / 模型名兜底识别（不要重复识别同一行）。`warnings` 至少包含"未识别到模型名"。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/model-parse.test.mjs`
Expected: PASS（6 个用例）。若自由文本的候选顺序与断言不符，调整 `recognizeEnvMap` 的遍历顺序（对象插入顺序）而不是改断言。

- [ ] **Step 5: 补导出与类型并提交**

`index.mjs` 加：

```js
export { parseConfigJson, parseConfigText, recognizeEnvMap } from "./model/parse.mjs";
```

`index.d.ts` 加：

```ts
export interface RecognizedField { field: string; value: string; source?: string }
export interface ParseResult {
  form?: "claude-settings" | "flat" | "cc-switch" | "unknown";
  recognized: RecognizedField[];
  passthrough: Record<string, unknown>;
  candidates: Record<string, string[]>;
}
export function parseConfigJson(text: string): ParseResult;
export function parseConfigText(text: string): { recognized: RecognizedField[]; candidates: Record<string, string[]>; warnings: string[] };
export function recognizeEnvMap(env: Record<string, string>): { recognized: RecognizedField[]; candidates: Record<string, string[]> };
```

```bash
git add packages/core/src/model/parse.mjs packages/core/src/index.mjs packages/core/index.d.ts packages/cli/vendor/core-src test/model-parse.test.mjs
git commit -m "feat(core): paste recognition for JSON and free text"
```

---

### Task 8: 预设 + 测试连接

**Files:**
- Create: `packages/core/src/model/presets.mjs`、`packages/core/src/model/probe.mjs`
- Modify: `packages/core/src/index.mjs`、`packages/core/index.d.ts`
- Test: `test/model-probe.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 schema
- Produces:
  - `PRESETS`（6 个：`{ id, label, baseUrl, api }`，**不含模型 ID**）、`applyPreset(id)`
  - `testConnection(profile, options?)` → `{ ok, category, status, durationMs, model, usage, message, url }`，`category ∈ 2xx | auth | not-found | rate-limited | server-error | network | timeout`

- [ ] **Step 1: 写失败测试**

创建 `test/model-probe.test.mjs`：

```js
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { PRESETS, applyPreset, normalizeProfile, testConnection } from "../packages/core/src/index.mjs";

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function profileFor(baseUrl, api = "anthropic") {
  return normalizeProfile(
    { id: "p", name: "P", endpoint: { baseUrl, api, apiKey: "sk-test-1234567890" }, models: { main: { id: "test-model" } } },
    { now: "2026-09-10T00:00:00.000Z" },
  );
}

test("presets only prefill connection fields", () => {
  assert.equal(PRESETS.length, 6);
  for (const preset of PRESETS) {
    assert.equal(typeof preset.baseUrl, "string");
    assert.equal("models" in preset, false);
    assert.equal("apiKey" in preset, false);
  }
  assert.deepEqual(Object.keys(applyPreset(PRESETS[0].id)).sort(), ["api", "baseUrl", "id", "label"]);
});

test("testConnection posts a minimal Anthropic request and reports success", async () => {
  let seen = null;
  await withServer((request, response) => {
    seen = { url: request.url, method: request.method, headers: request.headers };
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      seen.body = JSON.parse(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ model: "test-model", usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  }, async (baseUrl) => {
    const result = await testConnection(profileFor(baseUrl));
    assert.equal(result.ok, true);
    assert.equal(result.category, "2xx");
    assert.equal(seen.url, "/v1/messages");
    assert.equal(seen.method, "POST");
    assert.equal(seen.headers["anthropic-version"], "2023-06-01");
    assert.equal(seen.headers["x-api-key"], "sk-test-1234567890");
    assert.equal(seen.body.max_tokens, 1);
    assert.equal(seen.body.model, "test-model");
    assert.equal(result.model, "test-model");
  });
});

test("testConnection posts OpenAI-shaped requests for openai-chat and openai-responses", async () => {
  const paths = [];
  await withServer((request, response) => {
    paths.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  }, async (baseUrl) => {
    await testConnection(profileFor(baseUrl, "openai-chat"));
    await testConnection(profileFor(baseUrl, "openai-responses"));
    assert.deepEqual(paths, ["/v1/chat/completions", "/v1/responses"]);
  });
});

test("testConnection does not duplicate an existing /v1 segment", async () => {
  const paths = [];
  await withServer((request, response) => {
    paths.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  }, async (baseUrl) => {
    await testConnection(profileFor(`${baseUrl}/v1`));
    assert.deepEqual(paths, ["/v1/messages"]);
  });
});

test("testConnection classifies failures", async () => {
  const cases = [
    [401, "auth"],
    [403, "auth"],
    [404, "not-found"],
    [429, "rate-limited"],
    [500, "server-error"],
  ];
  for (const [status, category] of cases) {
    await withServer((request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "nope" } }));
    }, async (baseUrl) => {
      const result = await testConnection(profileFor(baseUrl));
      assert.equal(result.ok, false);
      assert.equal(result.category, category);
      assert.equal(result.status, status);
      assert.equal(result.message.includes("连接失败 ≠ 密钥无效"), true);
    });
  }
});

test("testConnection classifies unreachable hosts and timeouts", async () => {
  const unreachable = await testConnection(profileFor("http://127.0.0.1:9/v1"));
  assert.equal(unreachable.category, "network");

  await withServer((request, response) => { /* never respond */ }, async (baseUrl) => {
    const result = await testConnection(profileFor(baseUrl), { timeoutMs: 200 });
    assert.equal(result.category, "timeout");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/model-probe.test.mjs`
Expected: FAIL — `PRESETS is not defined`

- [ ] **Step 3: 实现 `presets.mjs`**

```js
// 内置预设：只预填端点与 API 类型。绝不预填模型 ID（服务商模型 ID 变动频繁，写死立刻过期）。
// 实现时按各家官方文档核对 baseUrl；磁贴下方必须提示"预设只是起点，请以服务商文档为准"。
export const PRESETS = [
  { id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com", api: "anthropic" },
  { id: "xiaomi-mimo", label: "小米 MiMo", baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic", api: "anthropic" },
  { id: "moonshot-kimi", label: "Moonshot Kimi", baseUrl: "https://api.moonshot.cn/anthropic", api: "anthropic" },
  { id: "zhipu", label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/anthropic", api: "anthropic" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", api: "openai-chat" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", api: "openai-responses" },
];

export function applyPreset(id) {
  const preset = PRESETS.find((entry) => entry.id === id);
  return preset ? { ...preset } : null;
}
```

- [ ] **Step 4: 实现 `probe.mjs`**

```js
import { validateBaseUrl } from "./schema.mjs";

// 最小真实请求（spec §11）：会向用户填写的地址发一次请求、消耗极少量额度。
// avenic 没有服务端；密钥只发往该地址。测试只打本地 mock server。

const DEFAULT_TIMEOUT_MS = 15_000;

function resolveUrl(baseUrl, path) {
  const base = validateBaseUrl(baseUrl).replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}${path}` : `${base}/v1${path}`;
}

function requestFor(api, baseUrl, model, apiKey, authField) {
  if (api === "anthropic") {
    return {
      url: resolveUrl(baseUrl, "/messages"),
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(authField === "ANTHROPIC_API_KEY" ? { "x-api-key": apiKey } : { authorization: `Bearer ${apiKey}` }),
      },
      body: { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
    };
  }
  if (api === "openai-responses") {
    return {
      url: resolveUrl(baseUrl, "/responses"),
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: { model, input: "ping", max_output_tokens: 16 },
    };
  }
  return {
    url: resolveUrl(baseUrl, "/chat/completions"),
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
  };
}

function categoryFor(status) {
  if (status >= 200 && status < 300) return "2xx";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "server-error";
  return "server-error";
}

const MESSAGES = {
  auth: "密钥无效或没有权限（401/403）",
  "not-found": "路径不存在（404）——检查 Base URL 是否需要/需要去掉 /v1 段",
  "rate-limited": "被限流或配额用尽（429）",
  "server-error": "服务端错误",
  network: "网络 / DNS / TLS 不可达",
  timeout: "请求超时，未收到响应",
};

export async function testConnection(profile, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endpoint = options.endpoint ?? profile.endpoint;
  const model = profile.models?.main?.id ?? options.model;
  if (!model) {
    return { ok: false, category: "server-error", status: null, durationMs: 0, model: null, usage: null, message: "配置里没有主模型，无法测试（服务商模型 ID 需手工填写）", url: null };
  }
  const request = requestFor(endpoint.api, endpoint.baseUrl, model, endpoint.apiKey, endpoint.authField);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await (options.fetch ?? fetch)(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
    const durationMs = Date.now() - startedAt;
    const text = await response.text().catch(() => "");
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    const category = categoryFor(response.status);
    const ok = category === "2xx";
    const message = ok
      ? `连接成功（${durationMs} ms）`
      : `${MESSAGES[category]}（HTTP ${response.status}）—— 连接失败 ≠ 密钥无效，请对照状态码排查`;
    return {
      ok,
      category,
      status: response.status,
      durationMs,
      model: payload?.model ?? null,
      usage: payload?.usage ?? null,
      message,
      url: request.url,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const category = error?.name === "AbortError" ? "timeout" : "network";
    return {
      ok: false,
      category,
      status: null,
      durationMs,
      model: null,
      usage: null,
      message: `${MESSAGES[category]}—— 连接失败 ≠ 密钥无效`,
      url: request.url,
    };
  } finally {
    clearTimeout(timer);
  }
}

export { resolveUrl as probeUrl };
```

> 测试断言里 `message` 必须包含"连接失败 ≠ 密钥无效"，所以失败分支的文案统一带上这句话（`ok` 分支不带）。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/model-probe.test.mjs`
Expected: PASS（7 个用例）

- [ ] **Step 6: 补导出与类型并提交**

`index.mjs` 加：

```js
export { PRESETS, applyPreset } from "./model/presets.mjs";
export { testConnection } from "./model/probe.mjs";
```

`index.d.ts` 加：

```ts
export interface Preset { id: string; label: string; baseUrl: string; api: ApiType }
export const PRESETS: readonly Preset[];
export function applyPreset(id: string): Preset | null;
export interface ProbeResult {
  ok: boolean;
  category: "2xx" | "auth" | "not-found" | "rate-limited" | "server-error" | "network" | "timeout";
  status: number | null;
  durationMs: number;
  model: string | null;
  usage: unknown;
  message: string;
  url: string | null;
}
export function testConnection(profile: ModelProfile, options?: { timeoutMs?: number; fetch?: typeof fetch }): Promise<ProbeResult>;
```

```bash
git add packages/core/src/model/presets.mjs packages/core/src/model/probe.mjs packages/core/src/index.mjs packages/core/index.d.ts packages/cli/vendor/core-src test/model-probe.test.mjs
git commit -m "feat(core): provider presets and connection probe with failure classification"
```

---

### Task 9: gitignore 规则 + deinit 守卫

**Files:**
- Create: `packages/core/src/model/gitignore.mjs`
- Modify: `packages/core/src/runtime/gitignore.mjs:52-67`、`packages/core/src/index.mjs`、`packages/core/index.d.ts`
- Test: `test/model-gitignore.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `MODEL_RULES = [".agents/model.json", ".claude/settings.local.json", ".agents/tmp/"]`、`ensureModelGitignore(projectRoot)`
  - `removeRuntimeGitignore` 的可移除集合新增两条模型规则，且**仅当对应路径已不存在**时才移除

- [ ] **Step 1: 写失败测试**

创建 `test/model-gitignore.test.mjs`：

```js
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MODEL_RULES, ensureModelGitignore, removeRuntimeGitignore } from "../packages/core/src/index.mjs";

async function withTempDirectory(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("ensureModelGitignore appends the model rules once and is idempotent", async () => {
  await withTempDirectory("avenic-gi-", async (projectRoot) => {
    assert.equal(await ensureModelGitignore(projectRoot), true);
    const first = await readFile(path.join(projectRoot, ".gitignore"), "utf8");
    for (const rule of MODEL_RULES) assert.equal(first.includes(rule), true);
    assert.equal(first.includes("# Agent Runtime"), true);
    assert.equal(await ensureModelGitignore(projectRoot), false);
    assert.equal(await readFile(path.join(projectRoot, ".gitignore"), "utf8"), first);
  });
});

test("removeRuntimeGitignore keeps the model rules while their files exist", async () => {
  await withTempDirectory("avenic-gi-keep-", async (projectRoot) => {
    await ensureModelGitignore(projectRoot);
    await mkdir(path.join(projectRoot, ".agents"), { recursive: true });
    await writeFile(path.join(projectRoot, ".agents", "model.json"), "{}");
    await mkdir(path.join(projectRoot, ".claude"), { recursive: true });
    await writeFile(path.join(projectRoot, ".claude", "settings.local.json"), "{}");
    await removeRuntimeGitignore(projectRoot, { sessions: true });
    const content = await readFile(path.join(projectRoot, ".gitignore"), "utf8");
    assert.equal(content.includes(".agents/model.json"), true);
    assert.equal(content.includes(".claude/settings.local.json"), true);
  });
});

test("removeRuntimeGitignore drops the model rules once their files are gone", async () => {
  await withTempDirectory("avenic-gi-drop-", async (projectRoot) => {
    await ensureModelGitignore(projectRoot);
    await removeRuntimeGitignore(projectRoot, { sessions: true });
    const content = await readFile(path.join(projectRoot, ".gitignore"), "utf8");
    assert.equal(content.includes(".agents/model.json"), false);
    assert.equal(content.includes(".claude/settings.local.json"), false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/model-gitignore.test.mjs`
Expected: FAIL — `ensureModelGitignore is not a function`

- [ ] **Step 3: 实现 `model/gitignore.mjs`**

```js
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// 模型配置专用规则（spec §12.3）：只在保存模型配置时写入，不并入 REQUIRED_RULES
// （避免改变 init 的既有输出与断言）。
// 第三条 `.agents/tmp/` 是事务备份目录的兜底：备份里可能含密钥，而从未 init 过的项目
// 不会有这条规则。它与 REQUIRED_RULES 已含的规则同形，重复写入是幂等的。
export const MODEL_RULES = [".agents/model.json", ".claude/settings.local.json", ".agents/tmp/"];

export async function ensureModelGitignore(projectRoot) {
  const file = path.join(projectRoot, ".gitignore");
  const content = existsSync(file) ? await readFile(file, "utf8") : "";
  const lines = new Set(content.split(/\r?\n/).map((line) => line.trim()));
  const missing = MODEL_RULES.filter((rule) => !lines.has(rule));
  if (missing.length === 0) return false;
  const prefix = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  await writeFile(file, `${content}${prefix}# Agent Runtime\n${missing.join("\n")}\n`, "utf8");
  return true;
}
```

- [ ] **Step 4: 修改 `runtime/gitignore.mjs`**

`removeRuntimeGitignore` 改为：

```js
export async function removeRuntimeGitignore(projectRoot, options = {}) {
  const { content, file } = await readGitignore(projectRoot);
  if (!content) return false;
  const removable = new Set([".agents/local/", ".agents/tmp/"]);
  if (options.sessions) removable.add(SESSIONS_RULE);
  // 模型配置：只有对应文件真的不存在时才允许移除（否则密钥文件会变成可提交）；spec §12.4
  const modelCandidates = [
    [".agents/model.json", path.join(projectRoot, ".agents", "model.json")],
    [".claude/settings.local.json", path.join(projectRoot, ".claude", "settings.local.json")],
  ];
  for (const [rule, target] of modelCandidates) {
    if (!existsSync(target)) removable.add(rule);
  }
  let lines = content.split(/\r?\n/).filter((line) => !removable.has(line.trim()));
  const managedRules = new Set([...REQUIRED_RULES, SESSIONS_RULE, ...MODEL_RULES]);
  if (!lines.some((line) => managedRules.has(line.trim()))) {
    lines = lines.filter((line) => line.trim() !== "# Agent Runtime");
  }
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const updated = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  if (updated === content) return false;
  await writeFile(file, updated, "utf8");
  return true;
}
```

顶部导入 `MODEL_RULES`（`import { MODEL_RULES } from "../model/gitignore.mjs";`）与 `existsSync`（已有）。

> 注意循环依赖：`model/gitignore.mjs` 不导入 `runtime/gitignore.mjs`，因此这条导入是单向的。

- [ ] **Step 5: 运行测试并提交**

Run: `node --test test/model-gitignore.test.mjs && npm test`
Expected: 全绿（既有 gitignore 用例不受影响）

```bash
git add packages/core/src/model/gitignore.mjs packages/core/src/runtime/gitignore.mjs packages/core/src/index.mjs packages/core/index.d.ts packages/cli/vendor/core-src test/model-gitignore.test.mjs
git commit -m "feat(core): gitignore rules for model config with removal guard"
```

`index.mjs` 加 `export { MODEL_RULES, ensureModelGitignore } from "./model/gitignore.mjs";`；`index.d.ts` 加：

```ts
export const MODEL_RULES: readonly string[];
export function ensureModelGitignore(projectRoot: string): Promise<boolean>;
```

---

### Task 10: CLI `avenic model` + 启动注入

**Files:**
- Create: `packages/cli/src/cli/model-cli.mjs`
- Modify: `packages/cli/src/cli/dispatcher.mjs`（导入、`printHelp`、`runCli` 分发、`dispatchAgent` 注入）
- Test: `test/model-cli.test.mjs`

**Interfaces:**
- Consumes: Task 1-9 的全部 core 导出
- Produces: `dispatchModel(argumentsList, options)`（与 `dispatchHub` 同形：`{ io, cwd, environment }`）

- [ ] **Step 1: 写失败测试**

创建 `test/model-cli.test.mjs`（沿用 `test/skills.test.mjs` 的 `runAgent` 约定）：

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function withTempDirectory(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withProject(run) {
  await withTempDirectory("avenic-model-cli-", async (projectRoot) => {
    await withTempDirectory("avenic-model-state-", async (stateDir) => {
      await run({ projectRoot, environment: { AVENIC_STATE_DIR: stateDir } });
    });
  });
}

test("model add/list/show/use/clear round-trip with masked output", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    const added = runAgent(projectRoot, [
      "model", "add", "--name", "MiMo",
      "--base-url", "https://token-plan-cn.xiaomimimo.com/anthropic",
      "--api-key", "sk-aaaabbbbccccdddd",
      "--api", "anthropic",
      "--model", "mimo-v2.5-pro",
    ], environment);
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /mimo/);
    assert.doesNotMatch(added.stdout, /sk-aaaabbbbccccdddd/, "the key is never printed in full");
    assert.match(added.stdout, /sk-…dddd/);

    const listed = runAgent(projectRoot, ["model", "list"], environment);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /MiMo/);

    const used = runAgent(projectRoot, ["model", "use", "mimo"], environment);
    assert.equal(used.status, 0, used.stderr);
    assert.match(used.stdout, /\.claude\/settings\.local\.json|settings\.local\.json/);
    const settings = JSON.parse(await readFile(path.join(projectRoot, ".claude", "settings.local.json"), "utf8"));
    assert.equal(settings.env.ANTHROPIC_MODEL, "mimo-v2.5-pro");
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "sk-aaaabbbbccccdddd");

    const shown = runAgent(projectRoot, ["model", "show"], environment);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /Current profile\s+MiMo/);
    assert.doesNotMatch(shown.stdout, /sk-aaaabbbbccccdddd/);

    const cleared = runAgent(projectRoot, ["model", "clear"], environment);
    assert.equal(cleared.status, 0, cleared.stderr);
    const restored = JSON.parse(await readFile(path.join(projectRoot, ".claude", "settings.local.json"), "utf8"));
    assert.equal("ANTHROPIC_MODEL" in (restored.env ?? {}), false);
    assert.equal((await readFile(path.join(projectRoot, ".gitignore"), "utf8")).includes(".agents/model.json"), true);
  });
});

test("model rejects a URL that cmd.exe would mangle (§12.6 whitelist)", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    const result = runAgent(projectRoot, ["model", "add", "--name", "Bad", "--base-url", "https://x.example/v1?a=1&b=2", "--api-key", "sk-x"], environment);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must not contain/i);
  });
});

test("model does not fall through to the Pack dispatcher and reports usage", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    const result = runAgent(projectRoot, ["model", "bogus"], environment);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: avenic model/);
  });
});

test("a dangling binding disables injection and prints the fixed message", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    runAgent(projectRoot, ["model", "add", "--name", "MiMo", "--base-url", "https://a.example/anthropic", "--api-key", "sk-a", "--model", "m"], environment);
    runAgent(projectRoot, ["model", "use", "mimo"], environment);
    const removed = runAgent(projectRoot, ["model", "remove", "mimo"], environment);
    assert.equal(removed.status, 0, removed.stderr);

    const status = runAgent(projectRoot, ["model", "show"], environment);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Profile "mimo" no longer exists; Avenic configuration disabled for this project\./);

    const again = runAgent(projectRoot, ["model", "show"], environment);
    assert.doesNotMatch(again.stdout, /no longer exists/, "cleanup is idempotent");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/model-cli.test.mjs`
Expected: FAIL — `model` 落到 Pack 兜底分支（`status` 不为 0）

- [ ] **Step 3: 实现 `model-cli.mjs`**

```js
import path from "node:path";
import process from "node:process";
import { isInteractive, select } from "./prompts.mjs";
import {
  applyPreset,
  bindProject,
  clearProjectBinding,
  fail,
  getProfile,
  listProfiles,
  maskSecret,
  modelsFile,
  normalizeProfile,
  PRESETS,
  projectModelFile,
  projectModelStatus,
  removeProfile,
  resolveProjectProfile,
  testConnection,
  upsertProfile,
} from "#core";

function takeOption(argumentsList, option) {
  const index = argumentsList.indexOf(option);
  if (index === -1) return null;
  const value = argumentsList[index + 1];
  if (!value || value.startsWith("--")) fail(`${option} requires a value`);
  argumentsList.splice(index, 2);
  return value;
}

function requireKey(value) {
  const text = String(value ?? "").trim();
  if (!text) fail("An API key is required");
  return text;
}

function profileInputFrom(flags, existing = null) {
  return normalizeProfile(
    {
      id: flags.id ?? existing?.id,
      name: flags.name ?? existing?.name,
      endpoint: {
        baseUrl: flags.baseUrl ?? existing?.endpoint.baseUrl,
        api: flags.api ?? existing?.endpoint.api,
        apiKey: flags.apiKey ?? existing?.endpoint.apiKey,
      },
      models: flags.model ? { ...(existing?.models ?? {}), main: { id: flags.model } } : existing?.models,
    },
    { existing },
  );
}

function summarize(profile) {
  return [
    `Profile    ${profile.name} (${profile.id})`,
    `Endpoint   ${profile.endpoint.baseUrl} (${profile.endpoint.api})`,
    `API key    ${maskSecret(profile.endpoint.apiKey)}`,
    `Main model ${profile.models?.main?.id ?? "—"}`,
  ].join("\n");
}
```

`dispatchModel` 的主干（每个分支对应 spec §8 表格的一行）：

```js
export async function dispatchModel(argumentsList, options = {}) {
  const io = options.io ?? console;
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const [command = "show", ...rest] = argumentsList;

  if (command === "show") {
    if (rest.length > 0) fail("Usage: avenic model show");
    const resolved = await resolveProjectProfile(cwd, environment, io);
    if (resolved.message) io.log(resolved.message);
    io.log(`\nModel configuration\n`);
    io.log(`Library     ${modelsFile(environment)}`);
    io.log(`Project     ${projectModelFile(cwd)}`);
    io.log(`Current     ${resolved.profile ? `${resolved.profile.name} (${resolved.profile.id})` : "Not bound"}`);
    if (resolved.profile) {
      io.log(summarize(resolved.profile));
      const status = await projectModelStatus(cwd, environment);
      io.log(`Projection  ${status.projection ? `${status.projection.file} (${status.projection.keys} keys, fingerprint ${status.projection.fingerprintMatches ? "match" : "stale"})` : "—"}`);
      io.log("Codex       startup injection (-c model_provider=… / -m)");
      io.log("OpenCode    startup injection (OPENCODE_CONFIG_CONTENT)");
    }
    return 0;
  }

  if (command === "list") {
    const profiles = await listProfiles(environment);
    const status = await projectModelStatus(cwd, environment);
    io.log("\nLocal profiles\n");
    for (const profile of profiles) {
      const marker = profile.id === status.binding.activeProfileId ? ">" : " ";
      io.log(`${marker} ${profile.name} (${profile.id})   ${profile.endpoint.baseUrl}   ${maskSecret(profile.endpoint.apiKey)}`);
    }
    io.log("\n> = current project");
    return 0;
  }

  if (command === "add" || command === "set") {
    const flags = parseProfileFlags(rest);
    const library = await listProfiles(environment);
    const boundId = (await projectModelStatus(cwd, environment)).binding.activeProfileId;
    const id = flags.id ?? boundId ?? (flags.name ? slugify(flags.name) : null);
    if (!id) fail("A profile name is required: avenic model add --name <name> --base-url <url> --api-key <key> [--id <id>]");
    const existing = await getProfile(environment, id);
    if (command === "set" && !existing) fail(`Unknown profile: ${id}`);
    await upsertProfile(environment, profileInputFrom({ ...flags, id }, existing), io);
    io.log(`${command === "add" && !existing ? "Added" : "Updated"} profile\n\n${summarize(await getProfile(environment, id))}`);
    return 0;
  }

  if (command === "edit") {
    const [id, ...rest2] = rest;
    if (!id) fail("Usage: avenic model edit <id> [--name … --base-url … --api-key … --api … --model …]");
    const existing = await getProfile(environment, id);
    if (!existing) fail(`Unknown profile: ${id}`);
    await upsertProfile(environment, profileInputFrom({ ...parseProfileFlags(rest2), id }, existing), io);
    io.log(`Updated profile\n\n${summarize(await getProfile(environment, id))}`);
    return 0;
  }

  if (command === "use") {
    const [id] = rest;
    if (rest.length > 1) fail("Usage: avenic model use [id]");
    let targetId = id;
    if (!targetId) {
      const profiles = await listProfiles(environment);
      if (profiles.length === 0) fail("The local library is empty: avenic model add --name … --base-url … --api-key …");
      if (!isInteractive()) fail("Usage: avenic model use <id>");
      targetId = await select({ title: "Choose a profile", options: profiles.map((profile) => ({ value: profile.id, label: profile.name })), initial: 0 });
      if (targetId === null) { io.log("No change."); return 0; }
    }
    const result = await bindProject(cwd, environment, targetId, io);
    io.log(`Current profile  ${result.binding.activeProfileId}`);
    io.log(`Projection       ${result.projection.file} (${result.projection.keys} keys, ${result.changed ? "updated" : "unchanged"})`);
    return 0;
  }

  if (command === "clear") {
    if (rest.length > 0) fail("Usage: avenic model clear");
    const result = await clearProjectBinding(cwd, environment, io);
    io.log(result.changed ? "Project binding cleared" : "No project binding");
    for (const conflict of result.conflicts) {
      io.log(`⚠ ${conflict.path.join(".")} was edited by hand — left untouched: ${maskValue(conflict.current)}`);
    }
    return 0;
  }

  if (command === "remove") {
    const [id] = rest;
    if (!id || rest.length > 1) fail("Usage: avenic model remove <id>");
    const result = await removeProfile(environment, id, io);
    io.log(result.changed ? `Removed ${id} from the local library` : `Unknown profile: ${id}`);
    // 库是设备级的：无法枚举哪些项目绑定了它；绑定它的项目在下次触达时按 §7 清理。
    io.log("Projects bound to this profile will fall back to their Agent defaults on their next launch.");
    return 0;
  }

  if (command === "test") {
    const [id] = rest;
    if (rest.length > 1) fail("Usage: avenic model test [id]");
    const profile = id ? await getProfile(environment, id) : (await resolveProjectProfile(cwd, environment, io)).profile;
    if (!profile) fail(id ? `Unknown profile: ${id}` : "No profile bound to this project");
    io.log(`Testing ${profile.name} — a real request will be sent to ${profile.endpoint.baseUrl}（消耗极少量额度；avenic 没有服务端）`);
    const result = await testConnection(profile);
    io.log(`${result.ok ? "✓" : "✗"} ${result.message}`);
    if (result.url) io.log(`Request  POST ${result.url}`);
    if (result.model) io.log(`Model    ${result.model}`);
    return result.ok ? 0 : 2;
  }

  if (command === "presets") {
    for (const preset of PRESETS) io.log(`${preset.id.padEnd(16)} ${preset.label.padEnd(14)} ${preset.baseUrl} (${preset.api})`);
    io.log("\nPresets are a starting point only — check your provider's documentation.");
    return 0;
  }

  fail("Usage: avenic model <show|list|add|set|edit|use|clear|remove|test|presets>");
}
```

`parseProfileFlags(rest)` 收集 `--name/--id/--base-url/--api-key/--api/--model/--json`；`--json <file|->` 时读文件或 stdin 后走 `parseConfigJson`/`parseConfigText` 只回显识别结果（**不写库**，与"粘贴永不自动保存"一致）：

```js
function parseProfileFlags(argumentsList) {
  const flags = {};
  const rest = [...argumentsList];
  flags.name = takeOption(rest, "--name");
  flags.id = takeOption(rest, "--id");
  flags.baseUrl = takeOption(rest, "--base-url");
  flags.apiKey = takeOption(rest, "--api-key");
  flags.api = takeOption(rest, "--api");
  flags.model = takeOption(rest, "--model");
  flags.json = takeOption(rest, "--json");
  if (rest.length > 0) fail(`Unknown option: ${rest[0]}`);
  return flags;
}
```

`slugify(name)` = 小写、非 `[a-z0-9_]` 一律变 `_`、截断 32 字符。

- [ ] **Step 4: 接线到 `dispatcher.mjs`**

1. 导入：`import { dispatchModel } from "./model-cli.mjs";`
2. `printHelp()` 在 `Hub:` 段之后加：

```
Models:
  avenic model                       Show library path, project binding and projection status
  avenic model list                  List local profiles (marks the one bound to this project)
  avenic model add --name <n> --base-url <u> --api-key <k> [--api <anthropic|openai-chat|openai-responses>] [--model <id>] [--id <id>]
  avenic model set|edit <id> […]     Update a profile in the local library
  avenic model use [id]              Bind a profile to this project (interactive picker on a terminal)
  avenic model clear                 Unbind this project and restore the previous settings
  avenic model remove <id>           Delete a profile from the local library
  avenic model test [id]             Send one minimal real request (exit code 2 on failure)
  avenic model presets               List built-in endpoint presets
```

3. `runCli` 在 `hub` 分支之后、兜底 `dispatchSkills` 之前加：

```js
  if (command === "model") {
    return dispatchModel(remainingArguments, {
      io: console,
      cwd: process.cwd(),
      environment: process.env,
    });
  }
```

4. `dispatchAgent` 的启动注入（第 295-297 行，`launchExecutable` 之前）：

```js
  const launchProfile = await resolveActiveProfileForLaunch(projectRoot, environment);
```

其中新增模块级辅助：

```js
// 启动前解析当前项目绑定的 profile：dangling 时先安全回滚并提示（幂等），
// 然后按 agent 生成注入。任何异常都不阻断启动（配置问题不该让 Agent 打不开）。
async function resolveActiveProfileForLaunch(projectRoot, environment) {
  try {
    const resolved = await resolveProjectProfile(projectRoot, environment, console);
    if (resolved.message) console.log(resolved.message);
    if (!resolved.profile) return null;
    // Claude 的投影是项目内物化文件：指纹不一致时先刷新（事务写）
    const status = await projectModelStatus(projectRoot, environment);
    if (status.projection && !status.projection.fingerprintMatches) {
      await bindProject(projectRoot, environment, resolved.profile.id);
    }
    return resolved.profile;
  } catch (error) {
    console.log(`Model configuration skipped: ${error.message}`);
    return null;
  }
}
```

然后把最后的启动改为：

```js
  const injection = buildLaunchInjection({
    agentId,
    profile: launchProfile,
    argumentsList,
    environment: { ...environment },
  });
  if (injection.note) console.log(injection.note);
  let status;
  try {
    status = launchExecutable(agent.executable, injection.argumentsList, { cwd: projectRoot, environment: injection.environment });
  } finally {
```

> 注意：`environment` 变量本身（供 `adapter.*` 的花名册重定向用：`CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`XDG_CONFIG_HOME`）保持原样，注入只作用于 `injection.environment`（spec §5.2）。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/model-cli.test.mjs`
Expected: PASS（4 个用例）。若第一个用例的 `Current profile\s+MiMo` 不匹配，调整 `show` 的输出对齐（不是改断言）。

- [ ] **Step 6: 跑全量测试并提交**

Run: `npm test`
Expected: 全绿

```bash
git add packages/cli/src/cli/model-cli.mjs packages/cli/src/cli/dispatcher.mjs packages/cli/vendor/core-src test/model-cli.test.mjs
git commit -m "feat(cli): avenic model — library, project binding, launch injection"
```

---

### Task 11: 插件 vscode-free 层（项目根优先 active editor + 服务 + 协议 + 面板数据）

> **前置：core 必须先发布**（插件依赖**已发布**的 `@avenic/core`）。发布是 USER CHECKPOINT。

**Files:**
- Modify: `packages/vscode/package.json`（`@avenic/core` 提升到已发布新版本，如 `^1.2.0`）
- Create: `packages/vscode/src/services/model.ts`、`packages/vscode/src/model/protocol.ts`、`packages/vscode/src/model/state.ts`
- Modify: `packages/vscode/src/project.ts`
- Test: `packages/vscode/test/model-state.test.ts`、`packages/vscode/test/model-protocol.test.ts`、`packages/vscode/test/project.test.ts`（追加）

**Interfaces:**
- Consumes: 已发布的 `@avenic/core` 的 `listProfiles`、`upsertProfile`、`removeProfile`、`bindProject`、`clearProjectBinding`、`projectModelStatus`、`resolveProjectProfile`、`testConnection`、`parseConfigJson`、`parseConfigText`、`maskSecret`、`modelsFile`、`modelsTempRoot`、`normalizeProfile`、`agentCompatibility`、`PRESETS`、`ensureModelGitignore`
- Produces:
  - `projectRootForActiveEditor(folders, activeUri, platform?)` → `string | null`
  - `src/services/model.ts`：`panelData`、`saveProfile`、`deleteProfile`、`bind`、`clear`、`probe`、`parseJson`、`parseText`
  - `src/model/protocol.ts`：`isModelViewMessage`、`ModelViewMessage`、`ModelSenderMessage`、`ModelPanelData`
  - `src/model/state.ts`：`buildModelPanelData({ projectRoot, environment })`

- [ ] **Step 1: 写失败测试**

`packages/vscode/test/project.test.ts` 追加：

```ts
test("projectRootForActiveEditor picks the folder that owns the active editor", () => {
  const folders = [{ uri: { fsPath: "/work/a" } }, { uri: { fsPath: "/work/b" } }];
  assert.equal(projectRootForActiveEditor(folders, "/work/b/src/index.ts"), "/work/b");
  assert.equal(projectRootForActiveEditor(folders, "/elsewhere/file.ts"), null);
  assert.equal(projectRootForActiveEditor(folders, undefined), null);
  assert.equal(projectRootForActiveEditor([{ uri: { fsPath: "C:\\work\\A" } }], "c:\\work\\a\\src\\x.ts", "win32"), "C:\\work\\A");
});
```

创建 `packages/vscode/test/model-protocol.test.ts`：

```ts
test("isModelViewMessage accepts only the whitelisted shapes", () => {
  assert.equal(isModelViewMessage({ type: "ready" }), true);
  assert.equal(isModelViewMessage({ type: "refresh" }), true);
  assert.equal(isModelViewMessage({ type: "bindProject", id: "mimo" }), true);
  assert.equal(isModelViewMessage({ type: "saveProfile", profile: { id: "x", name: "X", baseUrl: "https://a.example", api: "anthropic", apiKey: null } }), true);
  assert.equal(isModelViewMessage({ type: "command", command: "rm -rf /" }), false);
  assert.equal(isModelViewMessage({ type: "bindProject" }), false);
  assert.equal(isModelViewMessage({ type: "bindProject", id: 42 }), false);
  assert.equal(isModelViewMessage({ type: "openFile", path: "C:/x" }), false, "the webview can never name a path");
  assert.equal(isModelViewMessage(null), false);
});

test("saveProfile rejects oversized or wrongly typed fields", () => {
  const base = { type: "saveProfile", profile: { id: "x", name: "X", baseUrl: "https://a.example", api: "anthropic", apiKey: null } };
  assert.equal(isModelViewMessage({ ...base, profile: { ...base.profile, name: "x".repeat(201) } }), false);
  assert.equal(isModelViewMessage({ ...base, profile: { ...base.profile, api: "made-up" } }), false);
  assert.equal(isModelViewMessage({ ...base, profile: { ...base.profile, apiKey: "sk-1" } }), true);
});
```

创建 `packages/vscode/test/model-state.test.ts`（vscode-free，用 `testEnv` + 临时目录）：

```ts
test("buildModelPanelData never leaks a full key", async () => {
  await withStateEnv(async ({ environment }) => {
    await upsertProfile(environment, {
      id: "mimo",
      name: "MiMo",
      endpoint: { baseUrl: "https://a.example/anthropic", api: "anthropic", apiKey: "sk-aaaabbbbccccdddd" },
      models: { main: { id: "mimo-v2.5-pro" } },
    });
    const data = await buildModelPanelData({ projectRoot: null, environment });
    assert.equal(data.cards.length, 1);
    assert.equal(data.cards[0].apiKeyMasked, "sk-…dddd");
    assert.equal(JSON.stringify(data).includes("sk-aaaabbbbccccdddd"), false);
    assert.equal(data.projectRoot, null);
    assert.equal(data.libraryPath.endsWith("models.json"), true);
  });
});

test("buildModelPanelData marks the bound card and the projection state", async () => {
  await withStateEnv(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, { id: "mimo", name: "MiMo", endpoint: { baseUrl: "https://a.example/anthropic", api: "anthropic", apiKey: "sk-1" }, models: { main: { id: "m" } } });
    await bindProject(projectRoot, environment, "mimo");
    const data = await buildModelPanelData({ projectRoot, environment });
    assert.equal(data.cards[0].current, true);
    assert.equal(data.binding?.profileId, "mimo");
    assert.equal(data.projection?.fingerprintMatches, true);
    assert.equal(data.message, null);
  });
});

test("buildModelPanelData surfaces a broken library as a readable error", async () => {
  await withStateEnv(async ({ environment }) => {
    await writeFile(modelsFile(environment), "{ broken");
    const data = await buildModelPanelData({ projectRoot: null, environment });
    assert.equal(data.cards.length, 0);
    assert.match(data.libraryBroken ?? "", /Cannot parse JSON file/);
    assert.equal(JSON.stringify(data).includes("sk-"), false);
  });
});
```

`withStateEnv` 放在 `packages/vscode/test/model-state.test.ts` 内的局部 helper（沿用 `testEnv` + `mkdtemp`）：临时 state 目录 + 临时项目目录，结束删除。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:vscode`
Expected: FAIL — `projectRootForActiveEditor` / `buildModelPanelData` 未定义

- [ ] **Step 3: 实现 `projectRootForActiveEditor`**

`packages/vscode/src/project.ts` 追加：

```ts
// 多根时优先用 active editor 所属的 workspace folder（用户当下正在编辑哪个项目，就用哪个）。
// 绝不静默取 folders[0]；匹配不到返回 null，由调用方继续走"记忆根 → QuickPick"。
export function projectRootForActiveEditor(
  folders: readonly WorkspaceFolderLike[],
  activeUri: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (activeUri === undefined || folders.length === 0) return null;
  const separator = platform === "win32" ? /[\\/]/ : /\//;
  const normalizedFile = platform === "win32" ? activeUri.toLowerCase() : activeUri;
  let best: string | null = null;
  for (const folder of folders) {
    const root = folder.uri.fsPath;
    const normalizedRoot = platform === "win32" ? root.toLowerCase() : root;
    if (normalizedFile === normalizedRoot) return root;
    if (!normalizedFile.startsWith(normalizedRoot)) continue;
    const rest = normalizedFile.slice(normalizedRoot.length, normalizedRoot.length + 1);
    if (separator.test(rest) && (best === null || root.length > best.length)) best = root;
  }
  return best;
}
```

- [ ] **Step 4: 实现 `src/model/protocol.ts`**

```ts
// 面板消息白名单（仿 dashboard/protocol.ts）：webview 永远不能指定路径或命令，
// 只能提交结构化的 profile 草稿与 id。apiKey === null 表示"不修改现有密钥"。
export interface ProfileDraft {
  id: string;
  name: string;
  baseUrl: string;
  api: "anthropic" | "openai-chat" | "openai-responses";
  apiKey: string | null;
  mainModel?: string;
  passthrough?: Record<string, unknown>;
}

export type ModelViewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "saveProfile"; profile: ProfileDraft }
  | { type: "deleteProfile"; id: string }
  | { type: "bindProject"; id: string }
  | { type: "clearProject" }
  | { type: "testConnection"; id: string }
  | { type: "parseJson"; text: string }
  | { type: "parseText"; text: string }
  | { type: "openLibraryFile" }
  | { type: "openSettingsFile" };

export interface ModelCardData {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKeyMasked: string;
  mainModel: string;
  current: boolean;
  compatibility: { claude: { ok: boolean; reason?: string }; codex: { ok: boolean; reason?: string }; opencode: { ok: boolean; reason?: string } };
}

export interface ModelPanelData {
  libraryPath: string;
  libraryExists: boolean;
  libraryBroken: string | null;
  projectRoot: string | null;
  cards: ModelCardData[];
  binding: { profileId: string; name: string } | null;
  projection: { file: string; keys: number; fingerprintMatches: boolean } | null;
  notes: string[];
  message: string | null;
}

export type ModelSenderMessage =
  | { type: "data"; payload: ModelPanelData }
  | { type: "parsed"; payload: unknown }
  | { type: "testResult"; payload: unknown }
  | { type: "error"; message: string };

const MAX_TEXT = 20_000;
const APIS = ["anthropic", "openai-chat", "openai-responses"];

function isShortString(value: unknown, max = 200): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isDraft(value: unknown): value is ProfileDraft {
  if (typeof value !== "object" || value === null) return false;
  const draft = value as Record<string, unknown>;
  if (!isShortString(draft.id, 32) || !isShortString(draft.name, 200)) return false;
  if (!isShortString(draft.baseUrl, 2000)) return false;
  if (typeof draft.api !== "string" || !APIS.includes(draft.api)) return false;
  if (draft.apiKey !== null && !isShortString(draft.apiKey, 1000)) return false;
  if (draft.mainModel !== undefined && !isShortString(draft.mainModel, 128)) return false;
  return true;
}

export function isModelViewMessage(value: unknown): value is ModelViewMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "ready":
    case "refresh":
    case "clearProject":
    case "openLibraryFile":
    case "openSettingsFile":
      return true;
    case "deleteProfile":
    case "bindProject":
    case "testConnection":
      return isShortString(message.id, 32);
    case "parseJson":
    case "parseText":
      return typeof message.text === "string" && message.text.length <= MAX_TEXT;
    case "saveProfile":
      return isDraft(message.profile);
    default:
      return false;
  }
}
```

- [ ] **Step 5: 实现 `src/model/state.ts`**

```ts
import {
  agentCompatibility,
  getProfile,
  listProfiles,
  maskSecret,
  modelsFile,
  projectModelStatus,
  readLibrary,
} from "@avenic/core";
import type { ModelCardData, ModelPanelData } from "./protocol.ts";

// vscode-free：面板数据组装在纯模块里（插件测试没有 vscode stub），
// 且只输出掩码——完整密钥永不进入 webview。
export async function buildModelPanelData(input: { projectRoot: string | null; environment: NodeJS.ProcessEnv }): Promise<ModelPanelData> {
  const { projectRoot, environment } = input;
  const libraryPath = modelsFile(environment);
  const base: ModelPanelData = {
    libraryPath,
    libraryExists: false,
    libraryBroken: null,
    projectRoot,
    cards: [],
    binding: null,
    projection: null,
    notes: [],
    message: null,
  };
  try {
    const library = await readLibrary(environment);
    base.libraryExists = library.exists;
    const status = projectRoot === null ? null : await projectModelStatus(projectRoot, environment);
    base.message = status?.message ?? null;
    base.cards = Object.values(library.profiles)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((profile) => ({
        id: profile.id,
        name: profile.name,
        baseUrl: profile.endpoint.baseUrl,
        api: profile.endpoint.api,
        apiKeyMasked: maskSecret(profile.endpoint.apiKey),
        mainModel: profile.models?.main?.id ?? "",
        current: status?.binding.activeProfileId === profile.id,
        compatibility: agentCompatibility(profile),
      }));
    if (status?.profile) {
      base.binding = { profileId: status.profile.id, name: status.profile.name };
      base.projection = status.projection;
      base.notes.push("Codex：启动时注入 -c model_provider / -m（不写项目文件）");
      base.notes.push("OpenCode：启动时注入 OPENCODE_CONFIG_CONTENT（不写项目文件）");
      if (status.projection && !status.projection.fingerprintMatches) {
        base.notes.push("投影指纹不一致：下次启动会重新生成");
      }
    }
  } catch (error) {
    base.libraryBroken = error instanceof Error ? error.message : String(error);
  }
  if (projectRoot === null) {
    base.notes.push("未打开项目文件夹：「用于当前项目」不可用");
  }
  return base;
}
```

- [ ] **Step 6: 实现 `src/services/model.ts`**

```ts
import {
  bindProject,
  clearProjectBinding,
  ensureModelGitignore,
  getProfile,
  listProfiles,
  normalizeProfile,
  parseConfigJson,
  parseConfigText,
  removeProfile,
  testConnection,
  upsertProfile,
  type ProcessEnvLike,
} from "@avenic/core";
import { buildModelPanelData } from "../model/state.ts";
import type { ProfileDraft } from "../model/protocol.ts";

type Env = ProcessEnvLike;
const environment = (env?: Env): Env => env ?? (process.env as Env);

export function panelData(projectRoot: string | null, env?: Env) {
  return buildModelPanelData({ projectRoot, environment: environment(env) as NodeJS.ProcessEnv });
}

export function profiles(env?: Env) {
  return listProfiles(environment(env));
}

// draft.apiKey === null → 保留库中现有密钥（面板只回显掩码，永远不把明文发回前端）
export async function saveProfile(draft: ProfileDraft, env?: Env) {
  const env2 = environment(env);
  const existing = await getProfile(env2, draft.id);
  const apiKey = draft.apiKey ?? existing?.endpoint.apiKey ?? "";
  const profile = normalizeProfile(
    {
      id: draft.id,
      name: draft.name,
      endpoint: { baseUrl: draft.baseUrl, api: draft.api, apiKey },
      models: draft.mainModel ? { ...(existing?.models ?? {}), main: { id: draft.mainModel } } : existing?.models,
      toggles: existing?.toggles,
      env: existing?.env,
      claude: existing?.claude,
    },
    { existing },
  );
  await upsertProfile(env2, profile);
  return profile;
}

export function deleteProfile(id: string, env?: Env) {
  return removeProfile(environment(env), id);
}

export async function bind(projectRoot: string, id: string, env?: Env) {
  const env2 = environment(env);
  await ensureModelGitignore(projectRoot);
  return bindProject(projectRoot, env2, id);
}

export function clear(projectRoot: string, env?: Env) {
  return clearProjectBinding(projectRoot, environment(env));
}

export function probe(id: string, env?: Env) {
  return getProfile(environment(env), id).then((profile) => (profile ? testConnection(profile) : null));
}

export const parseJson = (text: string) => parseConfigJson(text);
export const parseText = (text: string) => parseConfigText(text);
```

- [ ] **Step 7: 运行测试并提交**

Run: `npm install --prefix packages/vscode && npm run test:vscode`
Expected: typecheck + 全部测试通过

```bash
git add packages/vscode/src/project.ts packages/vscode/src/model packages/vscode/src/services/model.ts packages/vscode/test/model-state.test.ts packages/vscode/test/model-protocol.test.ts packages/vscode/test/project.test.ts packages/vscode/package.json packages/vscode/package-lock.json
git commit -m "feat(vscode): model panel data layer, protocol whitelist, active-editor project root"
```

---

### Task 12: 面板宿主 + 资源（`media/model/*`）

**Files:**
- Create: `packages/vscode/src/dashboard/model-panel.ts`、`packages/vscode/media/model/{view.html,main.js,style.css}`
- Test: `packages/vscode/test/model-media.test.ts`

**Interfaces:**
- Consumes: Task 11 的协议与数据层
- Produces: `ModelPanel.show(extensionUri, deps)` / `ModelPanel.current`（单例，重复打开聚焦已有面板）

- [ ] **Step 1: 写失败测试**

创建 `packages/vscode/test/model-media.test.ts`（仿 `dashboard-media.test.ts`）：

```ts
const mediaRoot = path.resolve("media/model");

test("view.html has the CSP placeholders and no remote resources", async () => {
  const html = await readFile(path.join(mediaRoot, "view.html"), "utf8");
  assert.match(html, /\{\{nonce\}\}/);
  assert.match(html, /\{\{cspSource\}\}/);
  assert.match(html, /\{\{mainJs\}\}/);
  assert.match(html, /\{\{style\}\}/);
  assert.equal(/https?:\/\//.test(html.replaceAll("{{cspSource}}", "")), false);
});

test("main.js renders user data with textContent only", async () => {
  const script = await readFile(path.join(mediaRoot, "main.js"), "utf8");
  assert.equal(script.includes("innerHTML"), false);
  assert.equal(/https?:\/\//.test(script), false);
  assert.match(script, /acquireVsCodeApi/);
  assert.match(script, /textContent/);
});

test("style.css uses VS Code theme variables", async () => {
  const style = await readFile(path.join(mediaRoot, "style.css"), "utf8");
  assert.match(style, /--vscode-/);
  assert.equal(/https?:\/\//.test(style), false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:vscode`
Expected: FAIL — `media/model/view.html` 不存在

- [ ] **Step 3: 实现 `model-panel.ts`**

```ts
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import { isModelViewMessage, type ModelSenderMessage } from "../model/protocol.ts";
import { panelData } from "../services/model.ts";

export interface ModelPanelDeps {
  projectRoot: () => string | null;
  resolveRoot: () => Promise<string | null>;
  onMutation: () => void;
}

// 本仓库第一个编辑器标签页 WebviewPanel（现有 webview 只有侧边栏 Overview）。
// 薄壳：模板注入（CSP nonce + webview Uri）、消息白名单、数据单向。
export class ModelPanel {
  static current: ModelPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly deps: ModelPanelDeps,
  ) {
    panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!isModelViewMessage(message)) return;
      void this.handle(message).catch((error: unknown) => {
        this.post({ type: "error", message: error instanceof Error ? error.message : String(error) });
      });
    }, undefined, this.disposables);
  }

  static show(extensionUri: vscode.Uri, deps: ModelPanelDeps): ModelPanel {
    if (ModelPanel.current) {
      ModelPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return ModelPanel.current;
    }
    const panel = vscode.window.createWebviewPanel("avenic.model", "Avenic 模型配置", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    });
    ModelPanel.current = new ModelPanel(panel, extensionUri, deps);
    void ModelPanel.current.render().catch(() => { /* 面板已销毁 */ });
    return ModelPanel.current;
  }

  refresh(): void {
    void this.sendData();
  }

  private async handle(message: import("../model/protocol.ts").ModelViewMessage): Promise<void> {
    if (message.type === "ready" || message.type === "refresh") return this.sendData();
    if (message.type === "openLibraryFile") return void vscode.commands.executeCommand("avenic.model.openLibraryFile");
    if (message.type === "openSettingsFile") return void vscode.commands.executeCommand("avenic.model.openSettingsFile");
    if (message.type === "parseJson") return void this.post({ type: "parsed", payload: { json: safeParse(() => parseJson(message.text)) } });
    if (message.type === "parseText") return void this.post({ type: "parsed", payload: { text: safeParse(() => parseText(message.text)) } });
    // 其余（保存/删除/绑定/解绑/测试）都转发到命令层，保证 MutationQueue 串行与刷新一致
    const forwarded: Record<string, string> = {
      saveProfile: "avenic.model.saveProfile",
      deleteProfile: "avenic.model.deleteProfile",
      bindProject: "avenic.model.bindProject",
      clearProject: "avenic.model.clearProject",
      testConnection: "avenic.model.testConnection",
    };
    const command = forwarded[message.type];
    if (!command) return;
    const result = await vscode.commands.executeCommand(command, message);
    if (message.type === "testConnection" && result !== undefined) {
      this.post({ type: "testResult", payload: result });
    }
  }
}

function safeParse(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
```

`render()` / `sendData()` / `post()` 与 `dashboard/overview.ts:41-68` 同形：读 `media/model/view.html`，替换 `{{nonce}}` / `{{cspSource}}` / `{{mainJs}}` / `{{style}}`；`sendData()` 调 `panelData(this.deps.projectRoot())` 后 `post({type:"data", payload})`；模板读取失败时降级为无脚本静态提示。

- [ ] **Step 4: 实现 `media/model/*`**

`view.html` 骨架（CSP 与 dashboard 一致；无远程资源；内联 SVG 图标）：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src {{cspSource}}; script-src 'nonce-{{nonce}}';" />
  <link rel="stylesheet" href="{{style}}" />
  <title>Avenic 模型配置</title>
</head>
<body>
  <header>
    <div>
      <h1>本机配置库</h1>
      <div class="path" id="library-path"></div>
    </div>
    <div class="actions">
      <button id="new">+ 新建</button>
      <button id="paste">粘贴导入</button>
      <button id="refresh">刷新</button>
    </div>
  </header>
  <section id="cards"></section>
  <section id="paste-area" hidden>
    <div class="tabs">
      <button id="tab-json">JSON</button>
      <button id="tab-text">自由文本</button>
    </div>
    <textarea id="paste-input" rows="10"></textarea>
    <div class="actions">
      <button id="recognize">识别</button>
      <button id="fill">填入表单</button>
    </div>
    <div id="paste-result"></div>
  </section>
  <footer id="project"></footer>
  <div id="editor" hidden></div>
  <script nonce="{{nonce}}" src="{{mainJs}}"></script>
</body>
</html>
```

`main.js` 要求：只用 `createElement` + `textContent`（**禁用 `innerHTML`**）、`acquireVsCodeApi()`、`addEventListener` 绑定、数据来自 `data` 消息。卡片渲染：

```js
function renderCard(card) {
  const node = document.createElement("article");
  node.className = card.current ? "card current" : "card";
  const title = document.createElement("h2");
  title.textContent = card.name;
  node.append(title);
  if (card.current) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "当前项目";
    node.append(badge);
  }
  const endpoint = document.createElement("p");
  endpoint.textContent = `${card.baseUrl}  ·  密钥 ${card.apiKeyMasked}`;
  node.append(endpoint);
  const compat = document.createElement("p");
  compat.className = "compat";
  for (const [agentId, label] of [["claude", "Claude"], ["codex", "Codex"], ["opencode", "OpenCode"]]) {
    const mark = document.createElement("span");
    const state = card.compatibility[agentId];
    mark.textContent = `${label} ${state.ok ? "✓" : "✗"}`;
    if (!state.ok) mark.title = state.reason ?? "";
    compat.append(mark);
  }
  node.append(compat);
  const actions = document.createElement("div");
  actions.className = "card-actions";
  for (const [label, message] of [
    ["用于当前项目", { type: "bindProject", id: card.id }],
    ["编辑", { type: "edit", id: card.id }], // 本地：展开编辑区，不发消息
    ["测试", { type: "testConnection", id: card.id }],
    ["删除", { type: "deleteProfile", id: card.id }],
  ]) {
    const button = document.createElement("button");
    button.textContent = label;
    button.disabled = !state ? false : false;
    button.addEventListener("click", () => handle(label, message));
    actions.append(button);
  }
  node.append(actions);
  return node;
}
```

「用于当前项目」在 `data.projectRoot === null` 时 `disabled` 并加 `title="未打开项目文件夹"`；顶部"当前项目"区显示 `libraryPath`（便于用户在 WSL/Remote 下确认环境）与绑定/投影状态；编辑区按 §9.3 分区块，底部固定 [保存] [取消]，含折叠的"最终将写入 `.claude/settings.local.json`"掩码 JSON 预览。

`style.css` 只用 `--vscode-*` 变量（`--vscode-font-family`、`--vscode-editor-background`、`--vscode-panel-border`、`--vscode-button-background`…），布局用 grid/flex，最大宽度 1100px 居中。

- [ ] **Step 5: 运行测试并提交**

Run: `npm run test:vscode`
Expected: 全绿（含媒体断言）

```bash
git add packages/vscode/src/dashboard/model-panel.ts packages/vscode/media/model packages/vscode/test/model-media.test.ts
git commit -m "feat(vscode): model configuration webview panel (editor tab) and assets"
```

---

### Task 13: 命令 + 启动注入 + 清单

**Files:**
- Create: `packages/vscode/src/commands/model-commands.ts`
- Modify: `packages/vscode/src/extension.ts`、`packages/vscode/src/services/agents.ts`、`packages/vscode/package.json`
- Test: `packages/vscode/test/model-commands.test.ts`、`packages/vscode/test/manifest.test.ts`（追加）

**Interfaces:**
- Consumes: Task 11/12
- Produces: 命令 `avenic.model.open`、`avenic.model.switch` 及面板内部转发用的 `avenic.model.{saveProfile,deleteProfile,bindProject,clearProject,testConnection,openLibraryFile,openSettingsFile}`

- [ ] **Step 1: 写失败测试**

`packages/vscode/test/manifest.test.ts` 追加：

```ts
test("model commands are declared in the manifest", async () => {
  const manifest = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
  const ids = manifest.contributes.commands.map((entry: { command: string }) => entry.command);
  assert.equal(ids.includes("avenic.model.open"), true);
  assert.equal(ids.includes("avenic.model.switch"), true);
  const internal = manifest.contributes.menus.commandPalette.map((entry: { command: string }) => entry.command);
  assert.equal(internal.includes("avenic.model.open"), true);
  assert.equal(internal.includes("avenic.model.openLibraryFile"), false, "internal plumbing stays out of the palette");
});
```

`packages/vscode/test/model-commands.test.ts`：

```ts
test("the bind command refuses without a project folder", async () => {
  const calls: string[] = [];
  const fakeVscode = { window: { showWarningMessage: async (message: string) => calls.push(message) } };
  const deps = { queue: new MutationQueue(), resolveRoot: async () => null, refresh: () => {}, panel: () => {} };
  const result = await bindProjectFor(fakeVscode as never, deps, "mimo");
  assert.equal(result, null);
  assert.deepEqual(calls, ["未选择项目文件夹"]);
});
```

（`bindProjectFor` 从 `model-commands.ts` 导出的可测辅助：只做"解析项目根 → 调用服务 → 返回结果"这段，命令注册本身在 `registerModelCommands` 里。）

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:vscode`
Expected: FAIL — `avenic.model.open` 未在清单里

- [ ] **Step 3: 实现 `commands/model-commands.ts`**

```ts
import * as vscode from "vscode";
import path from "node:path";
import { commands } from "./registry.ts"; // 若不存在，沿用 skills-commands.ts 的 register 模板
import { runMutation, type MutationQueue } from "../ui/mutation-queue.ts";
import { withProgress } from "./progress.ts";
import { showError } from "./errors.ts";
import * as model from "../services/model.ts";
import { ModelPanel } from "../dashboard/model-panel.ts";

export interface ModelCommandDeps {
  queue: MutationQueue;
  resolveRoot: () => Promise<string | null>;
  refresh: () => void;
  panel: () => void;
}

// 可测片段：项目根解析（无根 → 提示并返回 null，与 scopeCwd 同约定）
export async function bindProjectFor(windowLike: Pick<typeof vscode.window, "showWarningMessage">, deps: ModelCommandDeps, id: string, environment?: NodeJS.ProcessEnv) {
  const projectRoot = deps.resolveRoot ? await deps.resolveRoot() : null;
  if (projectRoot === null) {
    await windowLike.showWarningMessage("未选择项目文件夹");
    return null;
  }
  return model.bind(projectRoot, id, environment);
}

export function registerModelCommands(context: vscode.ExtensionContext, deps: ModelCommandDeps): void {
  const register = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(`avenic.model.${id}`, fn));

  register("open", () => {
    ModelPanel.show(context.extensionUri, {
      projectRoot: () => null, // 由 deps 注入真实解析（extension.ts 传入 root）
      resolveRoot: deps.resolveRoot,
      onMutation: deps.refresh,
    });
  });
  register("switch", async () => {
    const projectRoot = await deps.resolveRoot();
    if (projectRoot === null) {
      await vscode.window.showWarningMessage("未选择项目文件夹");
      return;
    }
    const profiles = await model.profiles();
    if (profiles.length === 0) {
      await vscode.window.showInformationMessage("本机配置库为空，请先执行「Avenic: 模型配置」新建配置");
      return;
    }
    const picked = await vscode.window.showQuickPick(profiles.map((profile) => ({ label: profile.name, description: profile.endpoint.baseUrl, id: profile.id })));
    if (!picked) return;
    await runMutation(deps.queue, () => bindProjectFor(vscode.window, deps, picked.id), deps.refresh);
  });
  register("saveProfile", async (message) => {
    const { profile } = message as { profile: import("../model/protocol.ts").ProfileDraft };
    await runMutation(deps.queue, () => withProgress("保存模型配置", () => model.saveProfile(profile)), deps.refresh);
  });
  register("deleteProfile", async (message) => {
    const { id } = message as { id: string };
    const confirmed = await vscode.window.showWarningMessage(`删除配置 ${id}？绑定了它项目会在下次启动时回退到 Agent 默认配置。`, { modal: true }, "删除");
    if (confirmed !== "删除") return;
    await runMutation(deps.queue, () => model.deleteProfile(id), deps.refresh);
  });
  register("bindProject", async (message) => {
    const { id } = message as { id: string };
    await runMutation(deps.queue, () => bindProjectFor(vscode.window, deps, id), deps.refresh);
  });
  register("clearProject", async () => {
    const projectRoot = await deps.resolveRoot();
    if (projectRoot === null) return void vscode.window.showWarningMessage("未选择项目文件夹");
    await runMutation(deps.queue, () => model.clear(projectRoot), deps.refresh);
  });
  register("testConnection", async (message) => {
    const { id } = message as { id: string };
    return withProgress("测试连接", () => model.probe(id));
  });
  register("openLibraryFile", async () => {
    const data = await model.panelData(null);
    await vscode.window.showTextDocument(vscode.Uri.file(data.libraryPath), { preview: false });
  });
  register("openSettingsFile", async () => {
    const projectRoot = await deps.resolveRoot();
    if (projectRoot === null) return void vscode.window.showWarningMessage("未选择项目文件夹");
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(projectRoot, ".claude", "settings.local.json")), { preview: false });
  });
}
```

> 文件顶部按 `skills-commands.ts` 的真实模板调整（该文件用的是 `register(id, fn)` 闭包 + `busy()` + `runMutation` + `withProgress` + `showError`）。实现时逐字对照 `packages/vscode/src/commands/skills-commands.ts`，不要引入本仓库没有的 `commands/registry.ts`。

- [ ] **Step 4: 接线 `extension.ts`**

```ts
  const modelPanels = new ModelPanelController(root, resolveRoot, refresh); // 或者直接持有 ModelPanel.show
  registerModelCommands(context, { queue, resolveRoot, refresh, panel: () => modelPanels.open(context.extensionUri) });
```

`root()` 增加 active editor 优先分支：

```ts
  const root = () => {
    const live = vscode.workspace.workspaceFolders ?? [];
    return (
      resolveProjectRoot(live)
      ?? projectRootForActiveEditor(live, vscode.window.activeTextEditor?.document.uri.fsPath)
      ?? rememberedProjectRoot(live, context.workspaceState)
    );
  };
```

- [ ] **Step 5: `services/agents.ts` 的启动注入**

在 `prepareAgentLaunch` 里、`const environment: Record<string, string> = { ...process.env } as Record<string, string>;`（第 104 行）之后加：

```ts
  // 项目绑定的模型配置：dangling 先安全回滚（幂等），指纹不一致先刷新 Claude 投影；
  // 最终注入交给 core，插件侧零业务逻辑。任何异常都不阻断启动。
  let launchArguments: string[] = [];
  let launchEnvironment = environment;
  let launchNote: string | null = null;
  try {
    const resolved = await resolveProjectProfile(projectRoot, (process.env as ProcessEnvLike));
    if (resolved.profile) {
      const status = await projectModelStatus(projectRoot, (process.env as ProcessEnvLike));
      if (status.projection && !status.projection.fingerprintMatches) {
        await bindProject(projectRoot, (process.env as ProcessEnvLike), resolved.profile.id);
      }
      const injection = buildLaunchInjection({ agentId, profile: resolved.profile, argumentsList: [], environment });
      launchArguments = injection.argumentsList;
      launchEnvironment = injection.environment;
      launchNote = injection.note;
    }
  } catch (error) {
    launchNote = `Model configuration skipped: ${error instanceof Error ? error.message : String(error)}`;
  }
```

`AgentLaunchDefinition` 增加 `argumentsList: string[]`，供命令层用 `createTerminal({ shellPath, shellArgs })` argv 直启（spec §5.2：优先 argv 直启，避免 shell 二次解析）。`command` 字段保留为兜底：`launchArguments.length > 0 ? [agent.executable, ...launchArguments].join(" ") : agent.executable`。

- [ ] **Step 6: `package.json`**

- `contributes.commands` 追加两条（`avenic.model.open`「Avenic: 模型配置」、`avenic.model.switch`「Avenic: 切换本项目模型配置」）
- 面板内部命令（`saveProfile`/`deleteProfile`/`bindProject`/`clearProject`/`testConnection`/`openLibraryFile`/`openSettingsFile`）**也必须在 `contributes.commands` 里声明**（否则 `registerCommand` 可用但命令面板会列出未声明项；声明后从 `commandPalette` 菜单里排除），即每个加一条 `contributes.commands` + 全部加进 `contributes.menus.commandPalette` 的**排除**写法：

```json
{ "command": "avenic.model.saveProfile", "when": "false" }
```

- `contributes.menus["view/title"]` 为 `avenic.agents` 加 `{ "command": "avenic.model.open", "when": "view == avenic.agents", "group": "navigation" }`
- `version` 提升到 `0.1.12`

- [ ] **Step 7: 运行测试并提交**

Run: `npm install --prefix packages/vscode && npm run test:vscode`
Expected: 全绿

```bash
git add packages/vscode/src packages/vscode/package.json packages/vscode/package-lock.json packages/vscode/test
git commit -m "feat(vscode): model configuration commands, panel entry, launch injection"
```

---

### Task 14: 文档、版本与发布顺序

**Files:**
- Modify: `README.md`、`packages/cli/README.md`、`docs/development.md`、`packages/vscode/CHANGELOG.md`、`packages/core/package.json`、`packages/cli/package.json`、`packages/vscode/package.json`

- [ ] **Step 1: 文档**

- `README.md` / `packages/cli/README.md`：新增「Models」章节 —— 两层模型（本机库 `~/.config/avenic/models.json` / 项目绑定 `.agents/model.json`）、`avenic model` 用法表、三个 Agent 的生效方式（Claude 写项目 `.claude/settings.local.json` + env 兜底；Codex 启动 argv；OpenCode `OPENCODE_CONFIG_CONTENT`）、"不写 Agent 全局配置"、密钥掩码与"仍为明文存储，勿提交"的提醒。
- `docs/development.md`：发布流程补一句"core 变更后必须先 `npm run sync-core` 再发布 CLI；插件依赖已发布的 `@avenic/core`，插件改动排在其后"。
- `packages/vscode/CHANGELOG.md`：新增 `0.1.12` 段落（本机模型配置库 + 项目绑定、编辑器标签页面板、粘贴识别、测试连接、切换命令）。

- [ ] **Step 2: core 版本提升 + 同步 + 全量测试**

```bash
node -e "const f='packages/core/package.json';const p=require('./'+f);p.version='1.2.0';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
npm run sync-core
npm test          # 必须全绿再往下
```

- [ ] **Step 3: 提交并推送 core（USER CHECKPOINT：发布前停下来确认）**

```bash
git add packages/core/package.json packages/cli/vendor/core-src README.md packages/cli/README.md docs/development.md packages/vscode/CHANGELOG.md
git commit -m "chore(core): 1.2.0 — machine model library, project binding, launch injection, panel API"
git push
```

**请用户确认后**再执行（npm 发布是认证类操作）：

```bash
cd packages/core && npm publish
```

- [ ] **Step 4: CLI 版本提升 + 发布（USER CHECKPOINT）**

```bash
node -e "const f='packages/cli/package.json';const p=require('./'+f);p.version='1.3.0';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
npm test
git add packages/cli/package.json && git commit -m "chore(cli): 1.3.0 — avenic model, launch injection"
git push
cd packages/cli && npm publish   # 需用户确认
```

- [ ] **Step 5: 打包 VSIX（不上传）**

Run: `npm --prefix packages/vscode run package`
Expected: `packages/vscode/dist/avenic-agent-manager.vsix`（`0.1.12`）；报告路径给用户，**由用户自行上传 Marketplace（本计划不上传任何版本，尤其不得再操作 0.1.10）**。

- [ ] **Step 6: 交付报告**

报告：core/CLI 已发布版本、VSIX 路径与版本、等待用户上传。

---

## 自审记录

- **Spec 覆盖**：§4.1 库 → Task 1/2；§4.2 项目绑定 → Task 4；§5.1 Claude 投影 → Task 3；§5.2 Codex argv + `process.mjs` 加固 → Task 5/6；§5.3 OpenCode → Task 5；§5.4 指纹刷新 → Task 4（`bindProject` 指纹一致即返回 `changed:false`）/Task 10（启动前刷新）/Task 13（插件启动前刷新）；§5.5 事务与并发 → Task 2（重读重放 ≤3）；§6 回滚三态 → Task 3/4；§7 dangling → Task 4（固定文案 + 幂等）；§8 CLI → Task 10；§9 插件界面 → Task 11/12/13；§10 粘贴 → Task 7/12；§11 测试连接 → Task 8；§12 安全与 Git → Task 1（白名单/掩码）、Task 9（gitignore）、Task 11（面板只发掩码）；§13 降级 → Task 5/6/10（不静默跳过、可读错误、无绑定静默跳过）；§14 一致性 → 全程共用同一套 core 函数；§15 影响面 → 各 Task 的 Files 块；§16 测试 → 各 Task 的测试；§17 发布顺序 → Task 14。
- **对 spec 的三处有意细化**（不改变结论，实施时按本计划执行）：
  1. **一次事务一个根**：库（`~/.config/avenic`）与项目（`<root>/.agents`）可能位于不同卷，因此拆成两个独立事务；同一事务内只出现同一卷的文件。spec §5.5 step 5 的"备份目录用项目内 `.agents/tmp/`"只适用于项目侧，库侧用 `stateRoot/tmp`。
  2. **`MODEL_RULES` 增加第三条 `.agents/tmp/`**：事务备份可能短暂包含密钥，而从未 `init` 过的项目没有这条规则。它本就属于 `REQUIRED_RULES`，重复写入幂等。
  3. **`claudeEnvironment` 无条件注入**（spec §13 原为"仅当实测项 2 结论为不读时"）：`settings.env` 会覆盖同名 shell 变量（§3.1），因此文件被读取时该注入不改变行为；文件未被读取时它是唯一生效路径。比对实测结论更重要的是"两种情形都正确"。
- **命名一致性**：`transact` / `readLibrary` / `upsertProfile` / `removeProfile` / `bindProject` / `clearProjectBinding` / `resolveProjectProfile` / `projectModelStatus` / `buildClaudeEntries` / `mergeClaudeSettings` / `rollbackClaudeSettings` / `buildLaunchInjection` / `codexInjection` / `opencodeInjection` / `claudeEnvironment` / `parseConfigJson` / `parseConfigText` / `recognizeEnvMap` / `testConnection` / `PRESETS` / `applyPreset` / `MODEL_RULES` / `ensureModelGitignore` / `modelsFile` / `projectModelFile` / `claudeSettingsFile` / `maskSecret` / `libraryFingerprint` / `canonicalJson` / `normalizeProfile` 在全部 Task 中同名同形。
- **已知未覆盖**：`avenic model edit` 的终端交互流程（Task 10 用 `--json` 形态与 flag 形态覆盖了写入路径，交互式表单沿用 `prompts.mjs` 既有件，实施时按 `skills-cli.mjs` 的 `interactiveInstall` 结构补齐，不在本计划的测试断言范围内）。
