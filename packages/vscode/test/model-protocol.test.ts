import assert from "node:assert/strict";
import test from "node:test";
import { isModelViewMessage } from "../src/model/protocol.ts";

/** 一份合法的完整草稿；各条测试只覆盖自己关心的字段。 */
function draft(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "x",
    name: "X",
    baseUrl: "https://a.example",
    api: "anthropic",
    authField: "ANTHROPIC_AUTH_TOKEN",
    apiKey: null,
    models: { main: { id: "m" } },
    toggles: [],
    env: [],
    overrides: {},
    codex: { providerId: "avenic_x", envKey: "AVENIC_MODEL_KEY", reasoningEffort: "medium" },
    opencode: { providerId: "x", npmAdapter: "@ai-sdk/openai-compatible" },
    ...patch,
  };
}

const save = (patch: Record<string, unknown> = {}) => isModelViewMessage({ type: "saveProfile", profile: draft(patch) });
const preview = (patch: Record<string, unknown> = {}) => isModelViewMessage({ type: "preview", profile: draft(patch) });

test("isModelViewMessage accepts only the whitelisted shapes", () => {
  assert.equal(isModelViewMessage({ type: "ready" }), true);
  assert.equal(isModelViewMessage({ type: "refresh" }), true);
  assert.equal(isModelViewMessage({ type: "bindProject", id: "mimo" }), true);
  assert.equal(save(), true);
  assert.equal(preview(), true);
  assert.equal(isModelViewMessage({ type: "command", command: "rm -rf /" }), false);
  assert.equal(isModelViewMessage({ type: "bindProject" }), false);
  assert.equal(isModelViewMessage({ type: "bindProject", id: 42 }), false);
  assert.equal(isModelViewMessage({ type: "openFile", path: "C:/x" }), false, "the webview can never name a path");
  assert.equal(isModelViewMessage(null), false);
});

test("isModelViewMessage accepts every legitimate message shape", () => {
  assert.equal(isModelViewMessage({ type: "clearProject" }), true);
  assert.equal(isModelViewMessage({ type: "openLibraryFile" }), true);
  assert.equal(isModelViewMessage({ type: "openSettingsFile" }), true);
  assert.equal(isModelViewMessage({ type: "deleteProfile", id: "mimo" }), true);
  assert.equal(isModelViewMessage({ type: "duplicateProfile", id: "mimo" }), true);
  assert.equal(isModelViewMessage({ type: "testConnection", id: "mimo" }), true);
  assert.equal(isModelViewMessage({ type: "parseJson", text: "{}" }), true);
  assert.equal(isModelViewMessage({ type: "parseText", text: "" }), true);
  assert.equal(save({ api: "openai-chat" }), true);
  assert.equal(save({ models: {} }), true, "六个角色全空也是一份合法草稿");
  assert.equal(save({ models: { main: { id: "" } } }), true, "清空某个角色 = 删除该映射");
  assert.equal(save({ models: { opus: { id: "o", display: "Opus", longContext: true } } }), true);
  assert.equal(save({ env: [{ key: "AVENIC_FLAG", value: "1" }] }), true);
  assert.equal(save({ toggles: ["teams", "hideAttribution"] }), true);
  assert.equal(save({ overrides: { codex: { baseUrl: "https://c.example", api: "openai-chat", providerId: "p1" } } }), true);
  assert.equal(save({ authField: "ANTHROPIC_API_KEY" }), true);
  assert.equal(save({ passthrough: { statusLine: { type: "command" } } }), true);
});

// apiKey 的三态是 §7 的全部语义：null = 保留、"" = 清除、字符串 = 替换。
// 缺省（undefined）必须拒绝：草稿要显式表态，歧义不放行。
test("apiKey distinguishes keep / clear / replace and rejects ambiguity", () => {
  assert.equal(save({ apiKey: null }), true, "null = 保留库中现有密钥");
  assert.equal(save({ apiKey: "" }), true, "空串 = 明确清除");
  assert.equal(save({ apiKey: "sk-new" }), true, "字符串 = 替换");
  assert.equal(save({ apiKey: undefined }), false, "缺省 = 歧义，拒绝");
  assert.equal(save({ apiKey: 42 }), false);
  assert.equal(save({ apiKey: "x".repeat(1000) }), true);
  assert.equal(save({ apiKey: "x".repeat(1001) }), false);
});

// 草稿是白名单：webview 不能借它往库里塞 core 不认识的角色、开关、Agent 或认证字段。
test("the draft rejects members outside core's lists", () => {
  assert.equal(save({ models: { main: { id: "m" }, madeUpRole: { id: "x" } } }), false);
  assert.equal(save({ toggles: ["teams", "madeUpToggle"] }), false);
  assert.equal(save({ overrides: { claude: { baseUrl: "https://a.example" } } }), false, "core 只为 codex/opencode 建覆盖");
  assert.equal(save({ authField: "ANTHROPIC_SOMETHING_ELSE" }), false);
  assert.equal(save({ api: "made-up" }), false);
  assert.equal(save({ codex: { providerId: "x", envKey: "K", reasoningEffort: "xhigh" } }), false);
  // 开关清单最多一项一个；重复项没有意义，长度超过清单本身就说明是伪造的。
  assert.equal(save({ toggles: ["teams", "teams", "teams", "teams", "teams", "teams", "teams"] }), false);
});

test("isModelViewMessage enforces the field caps", () => {
  assert.equal(save({ id: "x".repeat(32) }), true);
  assert.equal(save({ id: "x".repeat(33) }), false);
  assert.equal(save({ id: "" }), false);
  assert.equal(save({ name: "" }), false);
  assert.equal(save({ baseUrl: "x".repeat(2000) }), true);
  assert.equal(save({ baseUrl: "x".repeat(2001) }), false);
  assert.equal(save({ models: { main: { id: "x".repeat(128) } } }), true);
  assert.equal(save({ models: { main: { id: "x".repeat(129) } } }), false);
  assert.equal(save({ codex: { providerId: "x", envKey: "x".repeat(64), reasoningEffort: "medium" } }), true);
  assert.equal(save({ codex: { providerId: "x", envKey: "x".repeat(65), reasoningEffort: "medium" } }), false);

  const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ key: `K${index}`, value: "v" }));
  assert.equal(save({ env: rows(100) }), true);
  assert.equal(save({ env: rows(101) }), false);
  assert.equal(save({ env: [{ key: "K", value: "x".repeat(2000) }] }), true);
  assert.equal(save({ env: [{ key: "K", value: "x".repeat(2001) }] }), false);
  assert.equal(save({ env: [{ key: "K" }] }), false);
  assert.equal(save({ env: "AVENIC_FLAG=1" }), false, "env 是行数组，不是对象或字符串");

  // 透传区直接落进 Claude settings 顶层，所以限制体积并拒绝非普通对象。
  assert.equal(save({ passthrough: { k: "x".repeat(20_000) } }), false);
  assert.equal(save({ passthrough: [1, 2] }), false);
  assert.equal(save({ passthrough: null }), false);

  assert.equal(isModelViewMessage({ type: "bindProject", id: "x".repeat(33) }), false);
  assert.equal(isModelViewMessage({ type: "parseJson", text: "x".repeat(20_000) }), true);
  assert.equal(isModelViewMessage({ type: "parseJson", text: "x".repeat(20_001) }), false);
});
