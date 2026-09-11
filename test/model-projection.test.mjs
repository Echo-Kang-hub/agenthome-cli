import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClaudeEntries,
  mergeClaudeSettings,
  normalizeProfile,
  rollbackClaudeSettings,
  writePath,
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

// ---- 以下为简报「必须自己验证的实现细节」补充的断言（1-6）----

test("buildClaudeEntries emits managed paths in a stable, documented order", () => {
  const entries = buildClaudeEntries(PROFILE);
  const order = entries.map((entry) => entry.path.join("."));
  assert.deepEqual(order, [
    "env.ANTHROPIC_BASE_URL",
    "env.ANTHROPIC_AUTH_TOKEN",
    "env.ANTHROPIC_MODEL",
    "env.ANTHROPIC_DEFAULT_OPUS_MODEL",
    "env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    "env.ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "env.CLAUDE_CODE_SUBAGENT_MODEL",
    "env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
    "env.ENABLE_TOOL_SEARCH",
    "env.CLAUDE_CODE_EFFORT_LEVEL",
    "env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "attribution",
    "env.CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    "theme",
  ]);
  const { ledger } = mergeClaudeSettings({}, entries);
  assert.deepEqual(ledger.map((entry) => entry.path.join(".")), order);
});

test("mergeClaudeSettings does not mutate the existing settings object", () => {
  const existing = {
    permissions: { allow: ["Bash(git status)"] },
    env: { ANTHROPIC_MODEL: "original-model", MY_VAR: "keep" },
  };
  const snapshot = structuredClone(existing);
  mergeClaudeSettings(existing, buildClaudeEntries(PROFILE));
  assert.deepEqual(existing, snapshot);
});

test("merge and rollback handle a missing settings file", () => {
  const entries = buildClaudeEntries(PROFILE);
  for (const missing of [null, undefined]) {
    const { content, ledger, created } = mergeClaudeSettings(missing, entries);
    assert.equal(created, true);
    assert.deepEqual(Object.keys(content).sort(), ["attribution", "env", "theme"]);
    assert.equal(content.env.ANTHROPIC_MODEL, "mimo-v2.5-pro");
    assert.equal(ledger.length, entries.length);
    // 新建文件的回滚：调用方拿到的是投影后的当前内容。
    const rolledBack = rollbackClaudeSettings(content, ledger);
    assert.equal(rolledBack.conflicts.length, 0);
    // deletePath 只删叶子、不清理变空的父对象，因此 env 空壳会留下（Task 4 依赖该行为）。
    assert.deepEqual(rolledBack.content, { env: {} });
    // 文件已缺失时回滚不抛异常：每条都记 conflict。
    const onMissing = rollbackClaudeSettings(null, ledger);
    assert.equal(onMissing.conflicts.length, entries.length);
    assert.deepEqual(onMissing.content, {});
  }
  assert.deepEqual(rollbackClaudeSettings(undefined, undefined), { content: {}, conflicts: [] });
});

test("rollback writes the original value back when it differs from the projected one", () => {
  const existing = { env: { ANTHROPIC_MODEL: "mimo-v2.5-pro" } };
  const ledger = [{ path: ["env", "ANTHROPIC_MODEL"], before: { exists: true, value: "original-model" }, written: "mimo-v2.5-pro" }];
  const { content, conflicts } = rollbackClaudeSettings(existing, ledger);
  assert.deepEqual(conflicts, []);
  assert.equal(content.env.ANTHROPIC_MODEL, "original-model");
  assert.deepEqual(content, { env: { ANTHROPIC_MODEL: "original-model" } });
});

test("rollback deletes nested leaves without pruning emptied parents", () => {
  const ledger = [{ path: ["env", "A"], before: { exists: false }, written: "written" }];
  const { content, conflicts } = rollbackClaudeSettings({ env: { A: "written", B: "keep" } }, ledger);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(content, { env: { B: "keep" } });
  const emptied = rollbackClaudeSettings({ env: { A: "written" } }, ledger);
  assert.deepEqual(emptied.content, { env: {} });
});

test("writePath overwrites non-object intermediate values with an object", () => {
  const text = { env: "oops" };
  writePath(text, ["env", "A"], 1);
  assert.deepEqual(text, { env: { A: 1 } });

  const nul = { env: null };
  writePath(nul, ["env", "A"], 1);
  assert.deepEqual(nul, { env: { A: 1 } });

  // 数组是 object：不会被覆盖成 {}，而是把键直接挂在数组对象上。
  const array = { env: [] };
  writePath(array, ["env", "A"], 1);
  assert.equal(Array.isArray(array.env), true);
  assert.equal(array.env.A, 1);
  assert.equal(array.env.length, 0);
});
