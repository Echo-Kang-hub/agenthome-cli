import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClaudeEntries,
  mergeClaudeSettings,
  normalizeProfile,
  readPath,
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
  assert.equal(Object.hasOwn(flat, "env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME"), false, "no display name → no _NAME key");
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

  // 数组不是普通对象：与字符串/null 一样必须被重置成 {}。
  // 修复前键会挂在数组对象上、JSON.stringify 时被丢弃 → 投影静默失效。
  const array = { env: [], keep: true };
  writePath(array, ["env", "A"], 1);
  assert.equal(Array.isArray(array.env), false);
  assert.deepEqual(array, { env: { A: 1 }, keep: true });
});

// ---- 修复轮：路径冲突检测（WARN-1）与形状守卫（WARN-2） ----

// 冲突 profile 必须 schema 合法（normalizeProfile 全绿），只是 env / claude.settings 用了受管键名。
function conflictProfile(id, extra) {
  return normalizeProfile({
    id,
    name: id,
    endpoint: { baseUrl: "https://conflict.example/anthropic", api: "anthropic", apiKey: "sk-test-collision" },
    ...extra,
  });
}

test("buildClaudeEntries rejects a profile env key that collides with the projected model key", () => {
  const profile = conflictProfile("p1", {
    models: { main: { id: "managed-model" } },
    env: { ANTHROPIC_MODEL: "user-model" },
  });
  assert.throws(
    () => buildClaudeEntries(profile),
    (error) => error.message.includes('Profile "p1" sets conflicting Claude settings') && error.message.includes("env.ANTHROPIC_MODEL"),
  );
});

test("buildClaudeEntries rejects a profile env key that collides with the endpoint auth field", () => {
  const profile = conflictProfile("p2", { env: { ANTHROPIC_AUTH_TOKEN: "sk-test-user-value" } });
  assert.throws(
    () => buildClaudeEntries(profile),
    (error) => error.message.includes('Profile "p2"') && error.message.includes("env.ANTHROPIC_AUTH_TOKEN"),
  );
});

test("buildClaudeEntries rejects claude.settings keys that shadow a projected path", () => {
  // 顶层 env 包含整棵 env 投影（前缀包含）。
  const envShadow = conflictProfile("p3", { claude: { settings: { env: { ANTHROPIC_MODEL: "nested-model" } } } });
  assert.throws(
    () => buildClaudeEntries(envShadow),
    (error) => error.message.includes('Profile "p3"') && error.message.includes("env and env.ANTHROPIC_BASE_URL"),
  );
  // 顶层 attribution 与 hideAttribution 投出的键完全重复。
  const attributionShadow = conflictProfile("p4", {
    toggles: { hideAttribution: true },
    claude: { settings: { attribution: { commit: "user" } } },
  });
  assert.throws(
    () => buildClaudeEntries(attributionShadow),
    (error) => error.message.includes('Profile "p4"') && error.message.includes("attribution is written twice"),
  );
});

test("mergeClaudeSettings rejects conflicting entry paths", () => {
  assert.throws(
    () => mergeClaudeSettings({}, [
      { path: ["env", "ANTHROPIC_MODEL"], value: "a" },
      { path: ["env", "ANTHROPIC_MODEL"], value: "b" },
    ]),
    /conflict/i,
  );
  assert.throws(
    () => mergeClaudeSettings({}, [
      { path: ["env"], value: { A: 1 } },
      { path: ["env", "A"], value: 2 },
    ]),
    /conflict/i,
  );
});

test("mergeClaudeSettings treats array and null intermediates as missing", () => {
  const entries = buildClaudeEntries(PROFILE);
  const arrayEnv = mergeClaudeSettings({ env: [], permissions: { allow: ["Bash(ls)"] } }, entries);
  assert.equal(Array.isArray(arrayEnv.content.env), false, "数组中间层必须被重置为对象");
  assert.equal(arrayEnv.content.env.ANTHROPIC_MODEL, "mimo-v2.5-pro");
  assert.deepEqual(arrayEnv.content.permissions, { allow: ["Bash(ls)"] });
  // 投影必须经得起 JSON 往返：修复前数组会吞掉所有非索引键，落盘即静默失效。
  const roundTripped = JSON.parse(JSON.stringify(arrayEnv.content));
  assert.equal(roundTripped.env.ANTHROPIC_MODEL, "mimo-v2.5-pro");

  const nullEnv = mergeClaudeSettings({ env: null }, entries);
  assert.equal(nullEnv.content.env.ANTHROPIC_MODEL, "mimo-v2.5-pro");
});

test("mergeClaudeSettings rejects a non-object settings root", () => {
  const entries = buildClaudeEntries(PROFILE);
  assert.throws(() => mergeClaudeSettings([], entries), /Claude settings must be a JSON object, got an array/);
  assert.throws(() => mergeClaudeSettings("hello", entries), /Claude settings must be a JSON object, got a string/);
  assert.throws(() => mergeClaudeSettings(42, entries), /Claude settings must be a JSON object, got a number/);
  assert.throws(() => mergeClaudeSettings(true, entries), /Claude settings must be a JSON object, got a boolean/);
  assert.equal(mergeClaudeSettings(null, entries).created, true, "null 仍是「无既有设置」路径");
});

test("readPath treats null intermediates as missing", () => {
  assert.deepEqual(readPath({ env: null }, ["env", "ANTHROPIC_MODEL"]), { exists: false });
  assert.deepEqual(readPath({ env: { ANTHROPIC_MODEL: "x" } }, ["env", "ANTHROPIC_MODEL"]), { exists: true, value: "x" });
});

test("buildClaudeEntries omits the auth field when apiKey is empty or missing", () => {
  for (const endpoint of [
    { baseUrl: "https://nokey.example/anthropic", api: "anthropic" },
    { baseUrl: "https://nokey.example/anthropic", api: "anthropic", apiKey: "" },
  ]) {
    const profile = normalizeProfile({ id: "no_key", name: "No Key", endpoint });
    const paths = buildClaudeEntries(profile).map((entry) => entry.path.join("."));
    assert.equal(paths.includes("env.ANTHROPIC_AUTH_TOKEN"), false, "空 apiKey 不得写空 token 覆盖用户 shell 里的真 token");
    assert.equal(paths.includes("env.ANTHROPIC_API_KEY"), false);
  }
});

test("buildClaudeEntries omits attribution unless hideAttribution is on", () => {
  for (const toggles of [undefined, {}, { hideAttribution: false }]) {
    const profile = normalizeProfile({ id: "no_attribution", name: "No Attribution", endpoint: { baseUrl: "https://x.example/anthropic", api: "anthropic" }, toggles });
    assert.equal(
      buildClaudeEntries(profile).some((entry) => entry.path.join(".") === "attribution"),
      false,
      "开关未开不得产出 attribution，避免清掉用户已有配置",
    );
  }
  const enabled = normalizeProfile({
    id: "attribution_on",
    name: "Attribution On",
    endpoint: { baseUrl: "https://x.example/anthropic", api: "anthropic" },
    toggles: { hideAttribution: true },
  });
  assert.equal(buildClaudeEntries(enabled).some((entry) => entry.path.join(".") === "attribution"), true);
});

test("merge and rollback isolate ledger values and caller inputs", () => {
  const { content, ledger } = mergeClaudeSettings({}, buildClaudeEntries(PROFILE));
  const attribution = ledger.find((entry) => entry.path.join(".") === "attribution");
  content.attribution.commit = "HACKED";
  assert.deepEqual(attribution.written, { commit: "", pr: "" }, "账本值必须是写盘值的克隆");

  const existing = { env: { ANTHROPIC_MODEL: "original-model" } };
  const rolled = rollbackClaudeSettings(existing, [
    { path: ["env", "ANTHROPIC_MODEL"], before: { exists: true, value: "original-model" }, written: "mimo-v2.5-pro" },
  ]);
  rolled.content.env.ANTHROPIC_MODEL = "HACKED";
  assert.equal(existing.env.ANTHROPIC_MODEL, "original-model", "回滚不得改写调用方传入的对象");
});
