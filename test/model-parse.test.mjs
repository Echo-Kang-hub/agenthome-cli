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

test("parseConfigText accepts both KEY=value and KEY: value separators", () => {
  const result = parseConfigText([
    "ANTHROPIC_BASE_URL: https://x.example",
    "ANTHROPIC_API_KEY=sk-aaaabbbbccccdddd",
  ].join("\n"));
  const fields = Object.fromEntries(result.recognized.map((entry) => [entry.field, entry.value]));
  assert.equal(fields.baseUrl, "https://x.example");
  assert.equal(fields.apiKey, "sk-aaaabbbbccccdddd");
});

test("parseConfigText strips single and double quotes from pasted values", () => {
  const single = parseConfigText("export ANTHROPIC_AUTH_TOKEN='sk-aaaabbbbccccdddd'");
  const singleFields = Object.fromEntries(single.recognized.map((entry) => [entry.field, entry.value]));
  assert.equal(singleFields.apiKey, "sk-aaaabbbbccccdddd");

  const double = parseConfigText('export ANTHROPIC_AUTH_TOKEN="sk-aaaabbbbccccdddd"');
  const doubleFields = Object.fromEntries(double.recognized.map((entry) => [entry.field, entry.value]));
  assert.equal(doubleFields.apiKey, "sk-aaaabbbbccccdddd");
});

test("recognizeEnvMap maps every model role to its own field", () => {
  const { recognized } = recognizeEnvMap({
    ANTHROPIC_DEFAULT_OPUS_MODEL: "opus-large",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet-large",
    CLAUDE_CODE_SUBAGENT_MODEL: "subagent-small",
  });
  const fields = Object.fromEntries(recognized.map((entry) => [entry.field, entry.value]));
  assert.equal(fields.opusModel, "opus-large");
  assert.equal(fields.sonnetModel, "sonnet-large");
  assert.equal(fields.subagentModel, "subagent-small");
});

test("recognizeEnvMap exposes model candidates under the role key", () => {
  const { candidates } = recognizeEnvMap({ ANTHROPIC_MODEL: "example-large" });
  assert.deepEqual(candidates.main, ["example-large"]);
  assert.equal(candidates.mainModel, undefined);
});

test("parseConfigText survives empty input and parseConfigJson reports unknown shapes", () => {
  for (const input of ["", null]) {
    const result = parseConfigText(input);
    assert.deepEqual(result.recognized, []);
    assert.equal(result.warnings.some((warning) => /model/i.test(warning)), true);
  }
  assert.equal(parseConfigJson("[]").form, "unknown");
  assert.equal(parseConfigJson('"just a string"').form, "unknown");
  assert.equal(parseConfigJson("null").form, "unknown");
});

test("parseConfigJson keeps unknown env keys out of recognized and secrets out of passthrough", () => {
  const result = parseConfigJson(JSON.stringify({
    env: {
      ANTHROPIC_AUTH_TOKEN: "sk-aaaabbbbccccdddd",
      UNKNOWN_THING: "leave-me-alone",
    },
    theme: "dark",
  }));
  assert.equal(result.recognized.some((entry) => entry.field === "unknownThing"), false);
  assert.deepEqual(Object.keys(result.passthrough), ["theme"]);
  assert.equal(JSON.stringify(result.passthrough).includes("sk-aaaabbbbccccdddd"), false);
});

test("parseConfigText does not mistake a bare URL for a model name", () => {
  const result = parseConfigText("https://x.example/v1");
  assert.equal(result.recognized.some((entry) => entry.field.endsWith("Model")), false);
  assert.equal(result.warnings.some((warning) => /model/i.test(warning)), true);
});
