import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bindProject, getProfile, maskSecret, modelsFile, upsertProfile } from "@avenic/core";
import type { ModelProfile } from "@avenic/core";
import { API_TYPES, AUTH_FIELDS, CODEX_EFFORTS, MODEL_ROLES, PRESETS, TOGGLE_KEYS } from "@avenic/core";
import { buildDraftPreview, buildModelPanelData, panelOptions, profileToDraft } from "../src/model/state.ts";
import { duplicateProfile, saveProfile } from "../src/services/model.ts";
import type { ProfileDraft } from "../src/model/protocol.ts";
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

async function stored(environment: NodeJS.ProcessEnv, id: string): Promise<ModelProfile> {
  const profile = await getProfile(environment, id);
  assert.ok(profile, `库中必须有 ${id}`);
  return profile;
}

/**
 * 面板的一次保存，端到端走真实路径：库 → profileToDraft（卡片数据）→ 用户改动 → saveProfile。
 * 刻意不用手写的草稿字面量：字面量会随草稿结构演进而失真，而这条路径的性质（无损）才是要钉住的。
 */
async function saveViaPanel(environment: NodeJS.ProcessEnv, id: string, edit: (draft: ProfileDraft) => void = () => {}): Promise<void> {
  const draft = profileToDraft(await stored(environment, id));
  edit(draft);
  await saveProfile(draft, environment);
}

async function seed(environment: NodeJS.ProcessEnv, input: Record<string, unknown>): Promise<void> {
  await upsertProfile(environment, input as never);
}

test("buildModelPanelData never leaks a full key", async () => {
  await withStateEnv(async ({ environment }) => {
    await seed(environment, {
      id: "mimo",
      name: "MiMo",
      endpoint: { baseUrl: "https://a.example/anthropic", api: "anthropic", apiKey: "sk-aaaabbbbccccdddd", authField: "ANTHROPIC_AUTH_TOKEN" },
      models: { main: { id: "mimo-v2.5-pro" } },
    });
    const data = await buildModelPanelData({ projectRoot: null, environment });
    assert.equal(data.cards.length, 1);
    assert.equal(data.cards[0].apiKeyMasked, "sk-…dddd");
    assert.equal(data.cards[0].apiKeyMasked, maskSecret("sk-aaaabbbbccccdddd"));
    assert.equal(data.cards[0].hasStoredApiKey, true);
    // 整份面板数据（含新增的 profile 草稿）都不得出现明文——这是 §7 的硬边界。
    assert.equal(JSON.stringify(data).includes("sk-aaaabbbbccccdddd"), false);
    for (const value of Object.values(data.cards[0])) assert.notEqual(value, "sk-aaaabbbbccccdddd");
    // 草稿里承载的是"不修改密钥"，不是掩码、更不是明文（§7：不用掩码字符串承载状态）。
    assert.equal(data.cards[0].profile.apiKey, null);
    assert.equal(data.projectRoot, null);
    assert.equal(data.libraryPath.endsWith("models.json"), true);
  });
});

test("a profile with no stored key reports hasStoredApiKey false", async () => {
  await withStateEnv(async ({ environment }) => {
    await seed(environment, { id: "bare", name: "Bare", endpoint: { baseUrl: "https://a.example", api: "anthropic", authField: "ANTHROPIC_AUTH_TOKEN", apiKey: "" }, models: { main: { id: "m" } } });
    const data = await buildModelPanelData({ projectRoot: null, environment });
    assert.equal(data.cards[0].hasStoredApiKey, false);
    assert.equal(data.cards[0].apiKeyMasked, "");
  });
});

test("buildModelPanelData marks the bound card and the projection state", async () => {
  await withStateEnv(async ({ projectRoot, environment }) => {
    await seed(environment, { id: "mimo", name: "MiMo", endpoint: { baseUrl: "https://a.example/anthropic", api: "anthropic", apiKey: "sk-1", authField: "ANTHROPIC_AUTH_TOKEN" }, models: { main: { id: "m" } } });
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
    await seed(environment, { id: "aaa", name: "Beta", endpoint: { baseUrl: "https://b.example", api: "anthropic", authField: "ANTHROPIC_AUTH_TOKEN", apiKey: "" }, models: { main: { id: "b" } } });
    await seed(environment, { id: "zzz", name: "Alpha", endpoint: { baseUrl: "https://a.example", api: "anthropic", authField: "ANTHROPIC_AUTH_TOKEN", apiKey: "" }, models: { main: { id: "a" } } });
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

// 面板的成员清单全部来自 core：core 加一个开关/角色/预设，界面跟着多一行，不需要插件改代码。
test("panel options derive their membership from core", () => {
  const options = panelOptions();
  assert.deepEqual(options.roles.map((role) => role.id), [...MODEL_ROLES]);
  assert.deepEqual(options.toggles.map((toggle) => toggle.id), [...TOGGLE_KEYS]);
  assert.deepEqual(options.apis, [...API_TYPES]);
  assert.deepEqual(options.authFields, [...AUTH_FIELDS]);
  assert.deepEqual(options.presets.map((preset) => preset.id), PRESETS.map((preset) => preset.id));
  assert.deepEqual(options.codexEffort, [...CODEX_EFFORTS]);
  // 每个开关都必须带着"实际写入的键名"（§9.3），空标签会让那一行没法显示落点。
  for (const toggle of options.toggles) {
    assert.equal(toggle.writes.length > 0, true, `${toggle.id} 必须声明实际写入的键名`);
    assert.equal(toggle.label.length > 0, true, `${toggle.id} 必须有可读的名字`);
  }
  // 1M 只允许 Opus / Sonnet（§9.3）。
  assert.deepEqual(options.longContextRoles, ["opus", "sonnet"]);
});

// 安全语义：草稿 apiKey === null 时保留库中现有密钥（面板只回显掩码，绝不清空用户已存的密钥）。
test("a panel save with apiKey null keeps the stored key byte for byte", async () => {
  await withStateEnv(async ({ environment }) => {
    await seed(environment, {
      id: "mimo",
      name: "MiMo",
      endpoint: { baseUrl: "https://a.example/anthropic", api: "anthropic", apiKey: "sk-keepme-123456", authField: "ANTHROPIC_AUTH_TOKEN" },
      models: { main: { id: "m" } },
    });
    const before = await stored(environment, "mimo");
    assert.equal(before.endpoint.apiKey, "sk-keepme-123456");
    await saveViaPanel(environment, "mimo", (draft) => { draft.name = "MiMo 重命名"; });
    const after = await stored(environment, "mimo");
    assert.equal(after.endpoint.apiKey, "sk-keepme-123456");
    assert.equal(after.endpoint.apiKey, before.endpoint.apiKey);
    assert.equal(after.name, "MiMo 重命名");
  });
});

test("a panel save with a new apiKey replaces the stored key", async () => {
  await withStateEnv(async ({ environment }) => {
    await seed(environment, {
      id: "mimo",
      name: "MiMo",
      endpoint: { baseUrl: "https://a.example/anthropic", api: "anthropic", apiKey: "sk-old-000000", authField: "ANTHROPIC_AUTH_TOKEN" },
      models: { main: { id: "m" } },
    });
    await saveViaPanel(environment, "mimo", (draft) => {
      draft.apiKey = "sk-new-111111";
      draft.baseUrl = "https://b.example/anthropic";
    });
    const after = await stored(environment, "mimo");
    assert.equal(after.endpoint.apiKey, "sk-new-111111");
    assert.equal(after.endpoint.baseUrl, "https://b.example/anthropic");
  });
});

// §7 的第三种语义：明确点「清除密钥」→ 草稿 apiKey === ""（而不是 null）。
// 这条路径以前根本表达不出来：protocol 的 isDraft 用 isShortString 校验 apiKey，空串会被拒。
test("a panel save with apiKey empty string clears the stored key", async () => {
  await withStateEnv(async ({ environment }) => {
    await seed(environment, {
      id: "mimo",
      name: "MiMo",
      endpoint: { baseUrl: "https://a.example/anthropic", api: "anthropic", apiKey: "sk-erase-999999", authField: "ANTHROPIC_AUTH_TOKEN" },
      models: { main: { id: "m" } },
    });
    await saveViaPanel(environment, "mimo", (draft) => { draft.apiKey = ""; });
    const after = await stored(environment, "mimo");
    assert.equal(after.endpoint.apiKey, "");
    // 清掉之后投影里就不该再有认证键（buildClaudeEntries 只在密钥非空时写它）。
    const preview = buildDraftPreview(profileToDraft(after), after);
    assert.equal(preview.entries.some((entry) => entry.path.join(".").includes("ANTHROPIC_AUTH_TOKEN")), false);
  });
});

// 面板保存必须无损：草稿没编辑到的字段一律逐字保留。
// 反例（修复前的真实行为）：normalizeProfile 是「白名单化」——没传的字段不留原值而是取默认值，
// 且 overrides/codex/opencode 在草稿里完全缺席 → 在面板里改一次名字就会永久抹掉该配置的
// Codex/OpenCode 端点覆盖与 provider 设置，且不可撤销。
test("a panel save preserves every library field the draft does not edit", async () => {
  await withStateEnv(async ({ environment }) => {
    await seed(environment, {
      id: "rich",
      name: "Rich",
      endpoint: { baseUrl: "https://a.example/anthropic", api: "anthropic", apiKey: "sk-keepme-123456", authField: "ANTHROPIC_API_KEY" },
      overrides: {
        codex: { baseUrl: "https://api.openai.com/v1", api: "openai-responses", authField: "ANTHROPIC_API_KEY", apiKey: "sk-codex-999999", providerId: "richcodex" },
      },
      models: { main: { id: "m" }, opus: { id: "o", display: "Opus", longContext: true }, haiku: { id: "h", longContext: true } },
      toggles: { teams: true, maxEffort: true },
      env: { AVENIC_CUSTOM_FLAG: "1" },
      claude: { settings: { someKey: true } },
      codex: { providerId: "richcodex", envKey: "RICH_KEY", reasoningEffort: "high" },
      opencode: { providerId: "richoc", npmAdapter: "@ai-sdk/openai-compatible" },
    });
    const before = await stored(environment, "rich");

    // 只改名字——面板的一次最普通保存
    await saveViaPanel(environment, "rich", (draft) => { draft.name = "Rich 改名"; });
    const after = await stored(environment, "rich");

    assert.equal(after.name, "Rich 改名", "草稿里的字段当然要生效");
    // 逐字段比对会随 core 加字段而失效；整体比对（只挖掉「本来就该变」的 updatedAt 与 name）
    // 是**金丝雀**：core 将来新增任何字段、而这条路径忘了带过，这里立刻变红，
    // 不必等有人想起来补断言。
    const untouched = (profile: unknown) => {
      const { updatedAt, name, ...rest } = profile as Record<string, unknown>;
      return rest;
    };
    assert.deepEqual(untouched(after), untouched(before), "除 updatedAt 与本次改名外，库中字段必须逐字保留");
    assert.deepEqual(after.overrides, before.overrides, "Codex/OpenCode 端点覆盖不得被抹掉");
    assert.deepEqual(after.endpoint, before.endpoint, "未被编辑的 endpoint（含 authField 与密钥）必须逐字保留");
    assert.deepEqual(after.codex, before.codex);
    assert.deepEqual(after.opencode, before.opencode);
    assert.deepEqual(after.claude, before.claude);
    // haiku 的 longContext 在界面上没有勾选框（只为 Opus/Sonnet 提供），但库里的值不得被抹掉。
    assert.deepEqual(after.models.haiku, { id: "h", longContext: true });
  });
});

test("the panel round-trips roles, toggles, env and agent overrides", async () => {
  await withStateEnv(async ({ environment }) => {
    await seed(environment, { id: "rt", name: "RT", endpoint: { baseUrl: "https://a.example/anthropic", api: "anthropic", authField: "ANTHROPIC_AUTH_TOKEN", apiKey: "sk-rt-12345678" }, models: { main: { id: "m" } } });
    await saveViaPanel(environment, "rt", (draft) => {
      draft.models = {
        main: { id: "m" },
        opus: { id: "claude-opus-4", display: "Opus 4", longContext: true },
        sonnet: { id: "claude-sonnet-4", longContext: true },
        haiku: { id: "claude-haiku-4" },
        fable: { id: "claude-fable-5" },
        subagent: { id: "claude-haiku-4" },
      };
      draft.toggles = ["teams", "hideAttribution"];
      draft.env = [{ key: "AVENIC_FLAG", value: "on" }];
      draft.overrides = { codex: { baseUrl: "https://codex.example/v1", api: "openai-responses", providerId: "mycodex" } };
      draft.codex = { providerId: "mycodex", envKey: "MY_KEY", reasoningEffort: "low" };
      draft.opencode = { providerId: "myoc", npmAdapter: "@ai-sdk/openai-compatible" };
      draft.authField = "ANTHROPIC_API_KEY";
    });
    const after = await stored(environment, "rt");
    assert.deepEqual(Object.keys(after.models).sort(), MODEL_ROLES.slice().sort());
    assert.deepEqual(after.models.opus, { id: "claude-opus-4", display: "Opus 4", longContext: true });
    assert.equal(after.models.sonnet?.longContext, true);
    assert.deepEqual(after.toggles, { teams: true, hideAttribution: true });
    assert.deepEqual(after.env, { AVENIC_FLAG: "on" });
    assert.equal(after.endpoint.authField, "ANTHROPIC_API_KEY");
    assert.equal(after.codex.reasoningEffort, "low");
    assert.equal(after.opencode.npmAdapter, "@ai-sdk/openai-compatible");
    // 覆盖对象的密钥与认证字段面板不发，必须沿用库中（这里是新建时的 endpoint 值）。
    assert.equal(after.overrides.codex?.apiKey, "sk-rt-12345678");
    assert.equal(after.overrides.codex?.providerId, "mycodex");

    // 清空某个角色的输入框 = 删除该角色映射。
    await saveViaPanel(environment, "rt", (draft) => { draft.models.haiku = { id: "" }; });
    const trimmed = await stored(environment, "rt");
    assert.equal("haiku" in trimmed.models, false);
    assert.deepEqual(Object.keys(trimmed.models).sort(), ["fable", "main", "opus", "sonnet", "subagent"]);
  });
});

// §5.5：重复键与受管 env 冲突由 core 判定，并且要能定位到具体那一行。
test("draftIssues locate duplicate and managed env keys on the offending row", async () => {
  await withStateEnv(async ({ environment }) => {
    await seed(environment, { id: "env", name: "Env", endpoint: { baseUrl: "https://a.example/anthropic", api: "anthropic", authField: "ANTHROPIC_AUTH_TOKEN", apiKey: "sk-1" }, models: { main: { id: "m" } } });
    const existing = await stored(environment, "env");
    const draft = profileToDraft(existing);

    draft.env = [{ key: "AVENIC_OK", value: "1" }];
    assert.deepEqual(buildDraftPreview(draft, existing).issues, []);

    // 重复键：第二次出现的那一行被点名。
    draft.env = [{ key: "AVENIC_OK", value: "1" }, { key: "AVENIC_OK", value: "2" }];
    const duplicate = buildDraftPreview(draft, existing).issues;
    assert.equal(duplicate.length, 1);
    assert.equal(duplicate[0].field, "env.1.key");
    assert.match(duplicate[0].message, /重复/);

    // 键名非法：core 的 validateEnvKey 判定。
    draft.env = [{ key: "lowercase", value: "1" }];
    const invalid = buildDraftPreview(draft, existing).issues;
    assert.equal(invalid.length, 1);
    assert.equal(invalid[0].field, "env.0.key");
    assert.match(invalid[0].message, /environment variable/i);

    // 与受管 env 冲突：端点会写 ANTHROPIC_BASE_URL，用户不能再自定义同名键。
    draft.env = [{ key: "AVENIC_OK", value: "1" }, { key: "ANTHROPIC_BASE_URL", value: "https://evil.example" }];
    const managed = buildDraftPreview(draft, existing).issues;
    assert.equal(managed.length, 1);
    assert.equal(managed[0].field, "env.1.key");
    assert.match(managed[0].message, /ANTHROPIC_BASE_URL/);
  });
});

// §7：投影预览由 core 算，但**出去之前密钥必须已经被换成掩码**——明文不出 host。
test("buildDraftPreview masks the secret and predicts the request URL", async () => {
  await withStateEnv(async ({ environment }) => {
    await seed(environment, {
      id: "pv",
      name: "PV",
      endpoint: { baseUrl: "https://a.example/anthropic", api: "anthropic", authField: "ANTHROPIC_AUTH_TOKEN", apiKey: "sk-secret-abcdefgh" },
      models: { main: { id: "m" } },
      toggles: { teams: true },
    });
    const existing = await stored(environment, "pv");
    const draft = profileToDraft(existing);

    const preview = buildDraftPreview(draft, existing);
    assert.deepEqual(preview.issues, []);
    assert.equal(preview.error, null);
    // 请求地址由 core 的 probeUrl 解析（面板不再自己拼）。
    assert.equal(preview.requestUrl, "https://a.example/anthropic/v1/messages");
    const auth = preview.entries.find((entry) => entry.path.join(".") === "env.ANTHROPIC_AUTH_TOKEN");
    assert.ok(auth, "投影里必须有认证键");
    assert.equal(auth.value, maskSecret("sk-secret-abcdefgh"));
    assert.equal(auth.secret, true);
    // 开关那一条按 core 的表出现在列表里（这才是"每行显示实际写入的键名"的同一份来源）。
    assert.equal(preview.entries.some((entry) => entry.path.join(".") === "env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"), true);
    assert.equal(JSON.stringify(preview).includes("sk-secret-abcdefgh"), false, "明文密钥绝不能出现在回包数据里");

    // 用户输入新密钥：预览显示的是**新密钥的掩码**，而不是旧掩码。
    draft.apiKey = "sk-typed-newkey-9999";
    const typed = buildDraftPreview(draft, existing);
    assert.equal(typed.entries.find((entry) => entry.secret === true)?.value, maskSecret("sk-typed-newkey-9999"));
    assert.equal(JSON.stringify(typed).includes("sk-typed-newkey-9999"), false);

    // 非法 Base URL：报成 baseUrl 上的问题，而不是把非法地址拿去解析。
    draft.baseUrl = "not-a-url";
    const broken = buildDraftPreview(draft, existing);
    assert.equal(broken.issues[0].field, "baseUrl");
    assert.equal(broken.requestUrl, null);
  });
});

// §9.2 的 [复制]：整份复制，只换 id 与名称。
test("duplicateProfile copies the whole profile with a fresh id", async () => {
  await withStateEnv(async ({ environment }) => {
    await seed(environment, {
      id: "src",
      name: "源配置",
      endpoint: { baseUrl: "https://a.example/anthropic", api: "anthropic", authField: "ANTHROPIC_AUTH_TOKEN", apiKey: "sk-copy-12345678" },
      models: { main: { id: "m" }, opus: { id: "o", longContext: true } },
      toggles: { teams: true },
      env: { AVENIC_FLAG: "1" },
      codex: { providerId: "srcodex", envKey: "SRC_KEY", reasoningEffort: "high" },
    });
    const first = await duplicateProfile("src", environment);
    assert.ok(first);
    assert.notEqual(first.id, "src");
    assert.equal(first.name, "源配置 副本");
    const copy = await stored(environment, first.id);
    assert.deepEqual(copy.models, (await stored(environment, "src")).models);
    assert.deepEqual(copy.toggles, { teams: true });
    assert.deepEqual(copy.env, { AVENIC_FLAG: "1" });
    assert.equal(copy.endpoint.apiKey, "sk-copy-12345678");
    assert.equal(copy.codex.reasoningEffort, "high");

    // 再复制一次不得撞 id。
    const second = await duplicateProfile("src", environment);
    assert.ok(second);
    assert.notEqual(second.id, first.id);
  });
});
