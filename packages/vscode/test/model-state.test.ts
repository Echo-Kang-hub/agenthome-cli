import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bindProject, getProfile, maskSecret, modelsFile, upsertProfile } from "@avenic/core";
import { buildModelPanelData } from "../src/model/state.ts";
import { saveProfile } from "../src/services/model.ts";
import { testEnv } from "./helpers.ts";

// 临时 state 目录 + 临时项目目录；结束一律删除（vscode-free，无宿主环境依赖）。
async function withStateEnv(run: (context: { projectRoot: string; environment: NodeJS.ProcessEnv }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-model-state-"));
  const projectRoot = path.join(root, "project");
  const stateDir = path.join(root, "state");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  try {
    await run({ projectRoot, environment: testEnv(stateDir) as NodeJS.ProcessEnv });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("buildModelPanelData never leaks a full key", async () => {
  await withStateEnv(async ({ environment }) => {
    await upsertProfile(environment, {
      id: "mimo",
      name: "MiMo",
      endpoint: { baseUrl: "https://a.example/anthropic", api: "anthropic", apiKey: "sk-aaaabbbbccccdddd", authField: "ANTHROPIC_AUTH_TOKEN" },
      models: { main: { id: "mimo-v2.5-pro" } },
    });
    const data = await buildModelPanelData({ projectRoot: null, environment });
    assert.equal(data.cards.length, 1);
    assert.equal(data.cards[0].apiKeyMasked, "sk-…dddd");
    assert.equal(data.cards[0].apiKeyMasked, maskSecret("sk-aaaabbbbccccdddd"));
    assert.equal(JSON.stringify(data).includes("sk-aaaabbbbccccdddd"), false);
    // 加固：任何字段都不得逐字等于明文密钥
    for (const value of Object.values(data.cards[0])) assert.notEqual(value, "sk-aaaabbbbccccdddd");
    assert.equal(data.projectRoot, null);
    assert.equal(data.libraryPath.endsWith("models.json"), true);
  });
});

test("buildModelPanelData marks the bound card and the projection state", async () => {
  await withStateEnv(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, { id: "mimo", name: "MiMo", endpoint: { baseUrl: "https://a.example/anthropic", api: "anthropic", apiKey: "sk-1", authField: "ANTHROPIC_AUTH_TOKEN" }, models: { main: { id: "m" } } });
    await bindProject(projectRoot, environment, "mimo");
    const data = await buildModelPanelData({ projectRoot, environment });
    assert.equal(data.cards[0].current, true);
    assert.equal(data.binding?.profileId, "mimo");
    assert.equal(data.projection?.fingerprintMatches, true);
    assert.equal(data.message, null);
  });
});

// 库的 profiles 是"按 id 索引的对象"，卡片顺序必须按 name 排（与插入顺序/id 顺序都不同才具判别力）
test("buildModelPanelData lists every profile sorted by name", async () => {
  await withStateEnv(async ({ environment }) => {
    await upsertProfile(environment, { id: "aaa", name: "Beta", endpoint: { baseUrl: "https://b.example", api: "anthropic", authField: "ANTHROPIC_AUTH_TOKEN", apiKey: "" }, models: { main: { id: "b" } } });
    await upsertProfile(environment, { id: "zzz", name: "Alpha", endpoint: { baseUrl: "https://a.example", api: "anthropic", authField: "ANTHROPIC_AUTH_TOKEN", apiKey: "" }, models: { main: { id: "a" } } });
    const data = await buildModelPanelData({ projectRoot: null, environment });
    assert.deepEqual(data.cards.map((card) => card.id), ["zzz", "aaa"]);
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

// 安全语义：草稿 apiKey === null 时保留库中现有密钥（面板只回显掩码，绝不清空用户已存的密钥）。
test("saveProfile with apiKey null keeps the stored key byte for byte", async () => {
  await withStateEnv(async ({ environment }) => {
    await upsertProfile(environment, {
      id: "mimo",
      name: "MiMo",
      endpoint: { baseUrl: "https://a.example/anthropic", api: "anthropic", apiKey: "sk-keepme-123456", authField: "ANTHROPIC_AUTH_TOKEN" },
      models: { main: { id: "m" } },
    });
    const before = await getProfile(environment, "mimo");
    assert.equal(before?.endpoint.apiKey, "sk-keepme-123456");
    await saveProfile({ id: "mimo", name: "MiMo 重命名", baseUrl: "https://a.example/anthropic", api: "anthropic", apiKey: null }, environment);
    const after = await getProfile(environment, "mimo");
    assert.equal(after?.endpoint.apiKey, "sk-keepme-123456");
    assert.equal(after?.endpoint.apiKey, before?.endpoint.apiKey);
    assert.equal(after?.name, "MiMo 重命名");
  });
});

test("saveProfile with a new apiKey replaces the stored key", async () => {
  await withStateEnv(async ({ environment }) => {
    await upsertProfile(environment, {
      id: "mimo",
      name: "MiMo",
      endpoint: { baseUrl: "https://a.example/anthropic", api: "anthropic", apiKey: "sk-old-000000", authField: "ANTHROPIC_AUTH_TOKEN" },
      models: { main: { id: "m" } },
    });
    await saveProfile({ id: "mimo", name: "MiMo", baseUrl: "https://b.example/anthropic", api: "anthropic", apiKey: "sk-new-111111" }, environment);
    const after = await getProfile(environment, "mimo");
    assert.equal(after?.endpoint.apiKey, "sk-new-111111");
    assert.equal(after?.endpoint.baseUrl, "https://b.example/anthropic");
  });
});
