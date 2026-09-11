import assert from "node:assert/strict";
import test from "node:test";
import { isModelViewMessage } from "../src/model/protocol.ts";

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

// 合法形态不得被过度拒绝（白名单的"真"分支逐条钉住）
test("isModelViewMessage accepts every legitimate message shape", () => {
  assert.equal(isModelViewMessage({ type: "clearProject" }), true);
  assert.equal(isModelViewMessage({ type: "openLibraryFile" }), true);
  assert.equal(isModelViewMessage({ type: "openSettingsFile" }), true);
  assert.equal(isModelViewMessage({ type: "deleteProfile", id: "mimo" }), true);
  assert.equal(isModelViewMessage({ type: "testConnection", id: "mimo" }), true);
  assert.equal(isModelViewMessage({ type: "parseJson", text: "{}" }), true);
  assert.equal(isModelViewMessage({ type: "parseText", text: "" }), true);
  // mainModel 缺省合法；apiKey: null 表示"不修改现有密钥"
  assert.equal(isModelViewMessage({ type: "saveProfile", profile: { id: "x", name: "X", baseUrl: "https://a.example", api: "openai-chat", apiKey: null } }), true);
  // apiKey 整个缺省（undefined）必须拒绝：草稿要显式表达"保留"（null）或"更新"（字符串），歧义不放行
  assert.equal(isModelViewMessage({ type: "saveProfile", profile: { id: "x", name: "X", baseUrl: "https://a.example", api: "openai-chat" } }), false);
  const draft = { id: "x", name: "X", baseUrl: "https://a.example", api: "openai-responses", apiKey: null, mainModel: "m" };
  assert.equal(isModelViewMessage({ type: "saveProfile", profile: draft }), true);
});

test("isModelViewMessage enforces the field caps", () => {
  const profile = { id: "x", name: "X", baseUrl: "https://a.example", api: "anthropic", apiKey: null };
  const save = (patch: Record<string, unknown>) => isModelViewMessage({ type: "saveProfile", profile: { ...profile, ...patch } });
  assert.equal(save({ id: "x".repeat(32) }), true);
  assert.equal(save({ id: "x".repeat(33) }), false);
  assert.equal(save({ id: "" }), false);
  assert.equal(save({ baseUrl: "x".repeat(2000) }), true);
  assert.equal(save({ baseUrl: "x".repeat(2001) }), false);
  assert.equal(save({ apiKey: "x".repeat(1000) }), true);
  assert.equal(save({ apiKey: "x".repeat(1001) }), false);
  assert.equal(save({ mainModel: "x".repeat(128) }), true);
  assert.equal(save({ mainModel: "x".repeat(129) }), false);
  assert.equal(isModelViewMessage({ type: "bindProject", id: "x".repeat(33) }), false);
  assert.equal(isModelViewMessage({ type: "parseJson", text: "x".repeat(20_000) }), true);
  assert.equal(isModelViewMessage({ type: "parseJson", text: "x".repeat(20_001) }), false);
});
