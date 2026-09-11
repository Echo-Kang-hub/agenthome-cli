import assert from "node:assert/strict";
import test from "node:test";
import {
  agentCompatibility,
  buildLaunchInjection,
  claudeEnvironment,
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

function assertNoUndefined(value, path = "$") {
  if (value === undefined) assert.fail(`undefined value at ${path}`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUndefined(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertNoUndefined(item, `${path}.${key}`);
  }
}

test("codexInjection yields the whole provider unit when the user passes -c model_provider=", () => {
  const injected = codexInjection(ANTHROPIC_PROFILE, { argumentsList: ["-c", "model_provider=user_provider"], environment: {} });
  // 用户段逐字保留；provider 单元（model_provider= + 4 对定义）整体让位。
  assert.deepEqual(injected.argumentsList, ["-m", "mimo-v2.5-pro", "-c", "model_provider=user_provider"]);
  assert.equal(injected.argumentsList.some((argument) => argument.startsWith("model_providers.")), false);
  assert.equal(injected.environment.AVENIC_MODEL_KEY, "sk-aaaabbbbccccdddd");
  assert.deepEqual(injected.skipped, ["model_provider"]);
});

test("codexInjection still injects the provider unit when the user only passes -m", () => {
  const injected = codexInjection(ANTHROPIC_PROFILE, { argumentsList: ["-m", "user-model"], environment: {} });
  assert.deepEqual(injected.argumentsList.slice(0, 10), [
    "-c", "model_provider=avenic_mimo",
    "-c", "model_providers.avenic_mimo.name=小米 MiMo",
    "-c", "model_providers.avenic_mimo.base_url=https://token-plan-cn.xiaomimimo.com/v1",
    "-c", "model_providers.avenic_mimo.env_key=AVENIC_MODEL_KEY",
    "-c", "model_providers.avenic_mimo.wire_api=responses",
  ]);
  assert.deepEqual(injected.argumentsList.slice(-2), ["-m", "user-model"]);
  assert.equal(injected.skipped.length, 1);
  assert.deepEqual(injected.skipped, ["model"]);
});

test("codexInjection yields to the long --model spelling too", () => {
  const injected = codexInjection(ANTHROPIC_PROFILE, { argumentsList: ["--model", "user-model"], environment: {} });
  assert.equal(injected.argumentsList.some((argument) => argument.startsWith("model_providers.")), true);
  assert.equal(injected.argumentsList.includes("mimo-v2.5-pro"), false);
  assert.deepEqual(injected.skipped, ["model"]);
});

test("codexInjection refuses to inject a quoted argument", () => {
  const quoted = normalizeProfile({ ...ANTHROPIC_PROFILE, name: 'a"b' }, { now: "2026-09-10T00:00:00.000Z" });
  assert.throws(
    () => codexInjection(quoted, { argumentsList: [], environment: {} }),
    /Refusing to inject a quoted Codex argument/,
  );
});

test("opencodeInjection routes an Anthropic endpoint through a per-agent opencode override", () => {
  const profile = normalizeProfile(
    {
      id: "moonshot",
      name: "Moonshot",
      endpoint: { baseUrl: "https://api.moonshot.cn/anthropic", api: "anthropic", apiKey: "sk-kimi" },
      overrides: { opencode: { baseUrl: "https://api.moonshot.cn/v1", api: "openai-chat" } },
      models: { main: { id: "kimi-k2" } },
    },
    { now: "2026-09-10T00:00:00.000Z" },
  );
  const environment = { PATH: "/bin" };
  const injected = opencodeInjection(profile, environment);
  assert.equal(injected.mode, "custom-provider");
  assert.equal(injected.providerId, profile.opencode.providerId);
  assert.equal(environment.OPENCODE_CONFIG_CONTENT, undefined, "the caller's environment object is not mutated");
  assert.deepEqual(Object.keys(environment), ["PATH"]);
  const config = JSON.parse(injected.environment.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.provider[profile.opencode.providerId].options.baseURL, "https://api.moonshot.cn/v1");
});

test("buildLaunchInjection leaves unknown agents and a missing profile untouched", () => {
  const unknown = buildLaunchInjection({ agentId: "openai", profile: ANTHROPIC_PROFILE, argumentsList: ["x"], environment: { PATH: "/bin" } });
  assert.deepEqual(unknown.argumentsList, ["x"]);
  assert.deepEqual(unknown.environment, { PATH: "/bin" });
  assert.equal(unknown.note, null);

  const withoutProfile = buildLaunchInjection({ agentId: "codex", profile: null, argumentsList: [], environment: {} });
  assert.deepEqual(withoutProfile, { argumentsList: [], environment: {}, note: null });
});

test("direct codexInjection fails on an incompatible profile while buildLaunchInjection degrades to a note", () => {
  const incompatible = normalizeProfile({ ...ANTHROPIC_PROFILE, overrides: {} }, { now: "2026-09-10T00:00:00.000Z" });
  assert.throws(
    () => codexInjection(incompatible, { argumentsList: [], environment: {} }),
    /Codex does not support this profile/,
  );
  const result = buildLaunchInjection({ agentId: "codex", profile: incompatible, argumentsList: [], environment: {} });
  assert.equal(result.note.includes("does not support this profile"), true);
});

test("opencodeInjection does not mutate the caller environment and writes no undefined", () => {
  const profile = normalizeProfile(
    {
      id: "kimi",
      name: "Kimi",
      endpoint: { baseUrl: "https://api.moonshot.cn/v1", api: "openai-chat", apiKey: "sk-kimi" },
      models: { main: { id: "kimi-k2" } },
    },
    { now: "2026-09-10T00:00:00.000Z" },
  );
  const environment = {};
  const injected = opencodeInjection(profile, environment);
  assert.deepEqual(environment, {}, "the caller's environment object is not mutated");
  const raw = injected.environment.OPENCODE_CONFIG_CONTENT;
  assert.equal(raw.includes("undefined"), false);
  const config = JSON.parse(raw);
  // 断言的是：解析后的对象树里既没有 undefined 值，也没有由 undefined 派生出来的键
  // （JSON.stringify 会把 undefined 值直接丢掉，因此只看字符串会漏掉键缺失的语义）。
  assertNoUndefined(config);
  assert.equal(Object.hasOwn(config, "small_model"), false, "no haiku row → small_model key is absent, not undefined/null");
  assert.deepEqual(Object.keys(config.provider.kimi.models), ["kimi-k2"]);
});

test("claudeEnvironment emits only defined values", () => {
  const bare = normalizeProfile(
    {
      id: "bare",
      name: "Bare",
      endpoint: { baseUrl: "https://bare.example/anthropic", api: "anthropic", apiKey: "sk-bare" },
      models: { haiku: { id: "bare-small" } },
    },
    { now: "2026-09-10T00:00:00.000Z" },
  );
  const environment = claudeEnvironment(bare);
  assert.equal(Object.hasOwn(environment, "ANTHROPIC_MODEL"), false);
  assert.equal(Object.values(environment).every((value) => value !== undefined), true);
  assert.equal(JSON.stringify(environment).includes("undefined"), false);
  assert.deepEqual(environment, {
    ANTHROPIC_BASE_URL: "https://bare.example/anthropic",
    ANTHROPIC_AUTH_TOKEN: "sk-bare",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "bare-small",
  });
});

test("codex envKey keeps the endpoint apiKey when the codex override carries a different one (observation)", () => {
  const profile = normalizeProfile(
    {
      id: "obs",
      name: "Obs",
      endpoint: { baseUrl: "https://endpoint.example/anthropic", api: "anthropic", apiKey: "sk-aaaabbbbccccdddd" },
      overrides: { codex: { baseUrl: "https://override.example/v1", api: "openai-responses", apiKey: "sk-override-key" } },
      models: { main: { id: "obs-main" } },
    },
    { now: "2026-09-10T00:00:00.000Z" },
  );
  const injected = codexInjection(profile, { argumentsList: [], environment: {} });
  assert.equal(injected.environment.AVENIC_MODEL_KEY, "sk-aaaabbbbccccdddd");
  assert.equal(injected.argumentsList.includes("model_providers.avenic_obs.base_url=https://override.example/v1"), true);
  assert.equal(injected.argumentsList.some((argument) => argument.includes("sk-override-key")), false);
});
