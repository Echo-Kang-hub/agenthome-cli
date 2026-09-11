import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import {
  bindProject,
  clearProjectBinding,
  projectModelFile,
  projectModelStatus,
  projectTempRoot,
  readBinding,
  removeProfile,
  resolveProjectProfile,
  transact,
  upsertProfile,
} from "../packages/core/src/index.mjs";
import { commitProject } from "../packages/core/src/model/binding.mjs";

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

// 换绑用例的 A 侧：toggles + 自定义 env + claude.settings，比 PROFILE_INPUT 多写若干键。
const PROFILE_WITH_TOGGLES = {
  id: "mimo",
  name: "小米 MiMo",
  endpoint: { baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic", api: "anthropic", apiKey: "sk-aaaabbbbccccdddd" },
  models: { main: { id: "mimo-v2.5-pro" } },
  toggles: { teams: true, toolSearch: true, hideAttribution: true },
  env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "131072" },
  claude: { settings: { theme: "dark" } },
};

// 换绑用例的 B 侧：不含 A 的 toggles / theme，但同样管理 CLAUDE_CODE_MAX_OUTPUT_TOKENS。
const PROFILE_LITE = {
  id: "mimo_lite",
  name: "MiMo Lite",
  endpoint: { baseUrl: "https://lite.example/anthropic", api: "anthropic", apiKey: "sk-eeeeffff00001111" },
  models: { main: { id: "mimo-lite" } },
  env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "65536" },
};

async function withProject(run) {
  await withTempDirectory("avenic-bind-project-", async (projectRoot) => {
    await withTempDirectory("avenic-bind-state-", async (stateDir) => {
      await run({ projectRoot, environment: { AVENIC_STATE_DIR: stateDir } });
    });
  });
}

const PAST = new Date("2000-01-01T00:00:00.000Z");

// 把 mtime 冻到过去再返回读回的基线：只要发生任何写盘（原地写或 rename 新文件），
// mtime 必然变成"现在"，与基线不再相等。
async function freezeMtime(file) {
  await utimes(file, PAST, PAST);
  return (await stat(file)).mtimeMs;
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

    // 「必须自己验证」6：第二次 clear 幂等，不再写盘（mtime 冻结后不得变化）。
    const bindingFile = projectModelFile(projectRoot);
    const frozenSettings = await freezeMtime(settings);
    const frozenBinding = await freezeMtime(bindingFile);
    const again = await clearProjectBinding(projectRoot, environment);
    assert.equal(again.changed, false, "nothing left to clear");
    assert.deepEqual(again.conflicts, []);
    assert.equal((await stat(settings)).mtimeMs, frozenSettings);
    assert.equal((await stat(bindingFile)).mtimeMs, frozenBinding);
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
    // 「必须自己验证」5：指纹一致 → 零写入，连 mtime 都不许动。
    const frozenSettings = await freezeMtime(settings);
    const frozenBinding = await freezeMtime(projectModelFile(projectRoot));
    const again = await bindProject(projectRoot, environment, "mimo");
    assert.equal(again.changed, false);
    assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), before);
    assert.equal((await stat(settings)).mtimeMs, frozenSettings, "指纹一致 → 不刷新文件时间戳");
    assert.equal((await stat(projectModelFile(projectRoot))).mtimeMs, frozenBinding, "绑定文件同样不得重写");
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
    // 硬伤 A 修正：created === true 时文件按 spec §6 被删除，不能再无条件 readFile+parse。
    const settingsPath = path.join(projectRoot, ".claude", "settings.local.json");
    const settings = existsSync(settingsPath) ? JSON.parse(await readFile(settingsPath, "utf8")) : {};
    assert.equal("ANTHROPIC_BASE_URL" in (settings.env ?? {}), false);
    assert.equal(existsSync(settingsPath), false, "spec §6 收尾：本功能创建的文件回滚后无残留 → 删除");

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

// ---- 简报要求补的 3 个用例 + 「必须自己验证」断言 ----

test("clear keeps a file this feature did not create even when only an empty env shell remains", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, PROFILE_INPUT);
    const settingsPath = path.join(projectRoot, ".claude", "settings.local.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    // 预先存在的文件 + 回滚后恰好只剩 { env: {} }：只有 created === false 这一道关卡
    // 能阻止删除（isResidualEmpty({env:{}}) === true），这是 spec §6 前半句的直钉用例。
    await writeFile(settingsPath, `${JSON.stringify({ env: {} }, null, 2)}\n`);

    const bound = await bindProject(projectRoot, environment, "mimo");
    assert.equal(bound.binding.projection.claude.created, false);
    const cleared = await clearProjectBinding(projectRoot, environment);
    assert.deepEqual(cleared.conflicts, []);
    assert.equal(existsSync(settingsPath), true, "created === false → 保留文件（spec §6 前半句）");
    const restored = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal("ANTHROPIC_BASE_URL" in restored.env, false);
    assert.equal("ANTHROPIC_MODEL" in restored.env, false);
    assert.deepEqual(restored.env, {}, "空 env 壳保留：isResidualEmpty 不得用于 created === false 的分支");
  });
});

test("rebinding clears the previous profile's keys, keeps the new profile's and the user's", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, PROFILE_WITH_TOGGLES);
    await upsertProfile(environment, PROFILE_LITE);
    const settings = path.join(projectRoot, ".claude", "settings.local.json");
    await mkdir(path.dirname(settings), { recursive: true });
    await writeFile(settings, `${JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, env: { USER_KEEP: "1" } }, null, 2)}\n`);

    await bindProject(projectRoot, environment, "mimo");
    const first = JSON.parse(await readFile(settings, "utf8"));
    assert.equal(first.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, "1");
    assert.equal(first.env.ENABLE_TOOL_SEARCH, "true");
    assert.deepEqual(first.attribution, { commit: "", pr: "" });
    assert.equal(first.theme, "dark");
    assert.equal(first.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "131072");

    const rebound = await bindProject(projectRoot, environment, "mimo_lite");
    assert.equal(rebound.changed, true);
    assert.equal(rebound.binding.activeProfileId, "mimo_lite");
    const second = JSON.parse(await readFile(settings, "utf8"));
    assert.equal("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS" in second.env, false, "A 独有开关被回滚清除");
    assert.equal("ENABLE_TOOL_SEARCH" in second.env, false);
    assert.equal("attribution" in second, false);
    assert.equal("theme" in second, false);
    assert.equal(second.env.ANTHROPIC_BASE_URL, "https://lite.example/anthropic");
    assert.equal(second.env.ANTHROPIC_MODEL, "mimo-lite");
    assert.equal(second.env.ANTHROPIC_AUTH_TOKEN, "sk-eeeeffff00001111");
    assert.equal(second.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "65536");
    assert.deepEqual(second.permissions, { allow: ["Bash(ls)"] });
    assert.equal(second.env.USER_KEEP, "1");
    const binding = JSON.parse(await readFile(projectModelFile(projectRoot), "utf8"));
    assert.equal(binding.projection.claude.created, false);
    assert.equal(binding.projection.claude.entries.length, rebound.projection.keys);
  });
});

test("clearing a project with no binding is a no-op and never creates files", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    const result = await clearProjectBinding(projectRoot, environment);
    assert.equal(result.changed, false);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.binding.activeProfileId, null);
    assert.equal(existsSync(projectModelFile(projectRoot)), false);
    assert.equal(existsSync(projectTempRoot(projectRoot)), false, "不得创建 .agents/tmp");
    assert.equal(existsSync(path.join(projectRoot, ".claude")), false);
  });
});

test("bind and clear leave no transaction directory behind", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, PROFILE_INPUT);
    await bindProject(projectRoot, environment, "mimo");
    assert.deepEqual(existsSync(projectTempRoot(projectRoot)) ? await readdir(projectTempRoot(projectRoot)) : [], []);
    await clearProjectBinding(projectRoot, environment);
    assert.deepEqual(existsSync(projectTempRoot(projectRoot)) ? await readdir(projectTempRoot(projectRoot)) : [], []);
  });
});

test("a corrupt project binding fails loudly and is never rewritten", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, PROFILE_INPUT);
    const file = projectModelFile(projectRoot);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{oops");
    await assert.rejects(() => readBinding(projectRoot), /Cannot parse JSON file/);
    await assert.rejects(() => bindProject(projectRoot, environment, "mimo"), /Cannot parse JSON file/);
    assert.equal(await readFile(file, "utf8"), "{oops", "损坏文件逐字不变，不自动修复");
    assert.equal(existsSync(path.join(projectRoot, ".claude", "settings.local.json")), false);
  });
});

// ---- 修复轮：路径冲突必须于任何写盘之前响亮失败（WARN-1） ----

const COLLIDING_PROFILES = [
  // A: profile.env.ANTHROPIC_MODEL 撞 models.main 投出的同一个路径。
  {
    id: "p1",
    name: "P1",
    endpoint: { baseUrl: "https://conflict.example/anthropic", api: "anthropic", apiKey: "sk-test-collision-0001" },
    models: { main: { id: "managed-model" } },
    env: { ANTHROPIC_MODEL: "user-model" },
  },
  // B: profile.env.ANTHROPIC_AUTH_TOKEN 撞 endpoint.authField 投出的投影密钥。
  {
    id: "p2",
    name: "P2",
    endpoint: { baseUrl: "https://conflict.example/anthropic", api: "anthropic", apiKey: "sk-test-collision-0002" },
    env: { ANTHROPIC_AUTH_TOKEN: "sk-test-user-value" },
  },
  // C: claude.settings 透传的顶层 env 键包含整棵 env 投影。
  {
    id: "p3",
    name: "P3",
    endpoint: { baseUrl: "https://conflict.example/anthropic", api: "anthropic", apiKey: "sk-test-collision-0003" },
    claude: { settings: { env: { ANTHROPIC_MODEL: "nested-model" } } },
  },
];

test("a conflicting profile fails before anything is written to disk", async () => {
  for (const input of COLLIDING_PROFILES) {
    await withProject(async ({ projectRoot, environment }) => {
      await upsertProfile(environment, input);
      const settings = path.join(projectRoot, ".claude", "settings.local.json");
      await mkdir(path.dirname(settings), { recursive: true });
      const original = `${JSON.stringify({ env: { ANTHROPIC_MODEL: "ORIGINAL", KEEP: "1" }, permissions: { allow: ["Bash(ls)"] } }, null, 2)}\n`;
      await writeFile(settings, original);

      await assert.rejects(() => bindProject(projectRoot, environment, input.id), /sets conflicting Claude settings/);

      assert.equal(await readFile(settings, "utf8"), original, `${input.id}: 用户设置必须逐字节未变`);
      assert.equal(existsSync(projectModelFile(projectRoot)), false, `${input.id}: 绑定文件不得创建`);
      assert.equal(existsSync(projectTempRoot(projectRoot)), false, `${input.id}: 事务目录不得创建`);
    });
  }
});

// ---- 修复轮：非对象/数组形状守卫（WARN-2） ----

test("bindProject replaces a non-object nested value instead of silently dropping the projection", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, PROFILE_INPUT);
    const settings = path.join(projectRoot, ".claude", "settings.local.json");
    await mkdir(path.dirname(settings), { recursive: true });
    await writeFile(settings, `${JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, env: [] }, null, 2)}\n`);

    const bound = await bindProject(projectRoot, environment, "mimo");
    assert.equal(bound.changed, true);
    const written = JSON.parse(await readFile(settings, "utf8"));
    assert.equal(Array.isArray(written.env), false, "数组中间层必须被替换成对象");
    assert.equal(written.env.ANTHROPIC_MODEL, "mimo-v2.5-pro");
    assert.deepEqual(written.permissions, { allow: ["Bash(ls)"] }, "用户其余键必须保留");
    // 重新 parse 后投影仍在：这正是修复前的静默失效路径。
    assert.equal(JSON.parse(JSON.stringify(written)).env.ANTHROPIC_MODEL, "mimo-v2.5-pro");
  });
});

test("a settings file whose root is not an object fails loudly and is never rewritten", async () => {
  for (const raw of ["[]", '"hello"', "42", "true", "null"]) {
    await withProject(async ({ projectRoot, environment }) => {
      await upsertProfile(environment, PROFILE_INPUT);
      const settings = path.join(projectRoot, ".claude", "settings.local.json");
      await mkdir(path.dirname(settings), { recursive: true });
      await writeFile(settings, `${raw}\n`);

      await assert.rejects(
        () => bindProject(projectRoot, environment, "mimo"),
        (error) => error.message.includes(settings) && error.message.includes("JSON object"),
        `根节点 ${raw} 必须带文件路径响亮失败`,
      );
      assert.equal(await readFile(settings, "utf8"), `${raw}\n`, `${raw}: 损坏文件逐字不变`);
      assert.equal(existsSync(projectModelFile(projectRoot)), false, `${raw}: 绑定文件不得创建`);
    });
  }
});

// ---- T4 修复轮：FAIL-1 同进程并发绑定不得留下半写对/损坏文件 ----

const EXPECTED_PROJECTION = {
  mimo: {
    baseUrl: PROFILE_INPUT.endpoint.baseUrl,
    token: PROFILE_INPUT.endpoint.apiKey,
    model: PROFILE_INPUT.models.main.id,
  },
  mimo_lite: {
    baseUrl: PROFILE_LITE.endpoint.baseUrl,
    token: PROFILE_LITE.endpoint.apiKey,
    model: PROFILE_LITE.models.main.id,
  },
};

test("concurrent binds in one process never leave a mixed binding/projection pair", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, PROFILE_INPUT);
    await upsertProfile(environment, PROFILE_LITE);
    const settingsPath = path.join(projectRoot, ".claude", "settings.local.json");
    for (let iteration = 0; iteration < 30; iteration += 1) {
      const results = await Promise.allSettled([
        bindProject(projectRoot, environment, "mimo"),
        bindProject(projectRoot, environment, "mimo_lite"),
      ]);
      const failures = results.filter((result) => result.status === "rejected");
      assert.deepEqual(
        failures.map((failure) => failure.reason?.message),
        [],
        `iteration ${iteration}: 并发绑定在两个写者之间必须被锁串行化`,
      );
      const binding = JSON.parse(await readFile(projectModelFile(projectRoot), "utf8"));
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      const expected = EXPECTED_PROJECTION[binding.activeProfileId];
      assert.ok(expected, `iteration ${iteration}: activeProfileId=${binding.activeProfileId}`);
      assert.equal(settings.env.ANTHROPIC_BASE_URL, expected.baseUrl, `iteration ${iteration}: 绑定与投影必须指向同一 profile`);
      assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, expected.token, `iteration ${iteration}: token 不得来自另一个 profile`);
      assert.equal(settings.env.ANTHROPIC_MODEL, expected.model, `iteration ${iteration}: model 不得来自另一个 profile`);
    }
    assert.deepEqual(existsSync(projectTempRoot(projectRoot)) ? await readdir(projectTempRoot(projectRoot)) : [], []);
  });
});

// ---- T4 修复轮：WARN-1 绑定文件逐字段形状校验 ----

const MALFORMED_BINDINGS = [
  ["the document is an array", []],
  ["activeProfileId is a number", { schemaVersion: 1, revision: 1, activeProfileId: 42, overrides: {}, projection: {} }],
  ["activeProfileId is an object", { schemaVersion: 1, revision: 1, activeProfileId: {}, overrides: {}, projection: {} }],
  ["overrides is an array", { schemaVersion: 1, revision: 1, activeProfileId: null, overrides: [], projection: {} }],
  ["projection is a string", { schemaVersion: 1, revision: 1, activeProfileId: null, overrides: {}, projection: "nope" }],
  ["projection.claude is an array", { schemaVersion: 1, revision: 1, activeProfileId: "mimo", overrides: {}, projection: { claude: [] } }],
  ["projection.claude.entries is a string", {
    schemaVersion: 1,
    revision: 1,
    activeProfileId: "mimo",
    overrides: {},
    projection: { claude: { file: ".claude/settings.local.json", created: false, entries: "boom" } },
  }],
  ["projection.claude.entries is an object", {
    schemaVersion: 1,
    revision: 1,
    activeProfileId: "mimo",
    overrides: {},
    projection: { claude: { file: ".claude/settings.local.json", created: false, entries: {} } },
  }],
  ["an entry is not an object", {
    schemaVersion: 1,
    revision: 1,
    activeProfileId: "mimo",
    overrides: {},
    projection: { claude: { file: ".claude/settings.local.json", created: false, entries: ["boom"] } },
  }],
  ["an entry path is not an array of strings", {
    schemaVersion: 1,
    revision: 1,
    activeProfileId: "mimo",
    overrides: {},
    projection: { claude: { file: ".claude/settings.local.json", created: false, entries: [{ path: "env.X", before: { exists: false }, written: "1" }] } },
  }],
  ["before.exists is not a boolean", {
    schemaVersion: 1,
    revision: 1,
    activeProfileId: "mimo",
    overrides: {},
    projection: { claude: { file: ".claude/settings.local.json", created: false, entries: [{ path: ["env", "X"], before: {}, written: "1" }] } },
  }],
];

for (const [label, document] of MALFORMED_BINDINGS) {
  test(`a project binding whose ${label} fails loudly and is never rewritten`, async () => {
    await withProject(async ({ projectRoot, environment }) => {
      await upsertProfile(environment, PROFILE_INPUT);
      const file = projectModelFile(projectRoot);
      await mkdir(path.dirname(file), { recursive: true });
      const raw = `${JSON.stringify(document, null, 2)}\n`;
      await writeFile(file, raw);
      const malformed = (error) => error.message.includes("Project model binding is malformed") && error.message.includes(file);
      await assert.rejects(() => readBinding(projectRoot), malformed);
      await assert.rejects(() => projectModelStatus(projectRoot, environment), malformed);
      await assert.rejects(() => bindProject(projectRoot, environment, "mimo"), malformed);
      // entries 为字符串时旧实现抛裸 TypeError: pathArray is not iterable —— 必须是带文件路径的响亮失败。
      await assert.rejects(() => clearProjectBinding(projectRoot, environment), malformed);
      assert.equal(await readFile(file, "utf8"), raw, "形状不符的绑定文件逐字不变，不自动修复");
    });
  });
}

// ---- T4 修复轮补充：项目绑定 overrides 在 v1 无消费方，非空必须响亮失败 ----

test("a project binding with non-empty overrides fails loudly on every entry point and is never rewritten", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, PROFILE_INPUT);
    await bindProject(projectRoot, environment, "mimo");
    const file = projectModelFile(projectRoot);
    const document = JSON.parse(await readFile(file, "utf8"));
    document.overrides = { main: { id: "user-thinks-this-changes-the-model" } }; // 用户手改，以为换了模型
    const raw = `${JSON.stringify(document, null, 2)}\n`;
    await writeFile(file, raw);

    const unsupported = (label) => (error) => {
      assert.ok(error.message.includes("Project overrides are not supported in this version"), `${label}: ${error.message}`);
      assert.ok(error.message.includes(file), `${label}: 失败信息必须带文件路径`);
      assert.ok(error.message.includes("edit the profile in the model library instead"), `${label}: 必须给出替代做法`);
      return true;
    };
    await assert.rejects(() => readBinding(projectRoot), unsupported("readBinding"));
    await assert.rejects(() => projectModelStatus(projectRoot, environment), unsupported("projectModelStatus"));
    await assert.rejects(() => resolveProjectProfile(projectRoot, environment), unsupported("resolveProjectProfile"));
    await assert.rejects(() => bindProject(projectRoot, environment, "mimo"), unsupported("bindProject"));
    assert.equal(await readFile(file, "utf8"), raw, "被拒绝的绑定文件逐字不变，不自动修复也不静默丢弃 overrides");
  });
});

test("overrides present as an empty object or absent is the default shape and still works", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, PROFILE_INPUT);
    const file = projectModelFile(projectRoot);
    await mkdir(path.dirname(file), { recursive: true });

    await writeFile(file, `${JSON.stringify({ schemaVersion: 1, revision: 0, activeProfileId: null, overrides: {}, projection: {} }, null, 2)}\n`);
    assert.deepEqual((await readBinding(projectRoot)).value.overrides, {});
    await bindProject(projectRoot, environment, "mimo");
    assert.equal((await clearProjectBinding(projectRoot, environment)).changed, true);

    await writeFile(file, `${JSON.stringify({ schemaVersion: 1, revision: 0, activeProfileId: null, projection: {} }, null, 2)}\n`);
    assert.deepEqual((await readBinding(projectRoot)).value.overrides, {});
    assert.equal((await bindProject(projectRoot, environment, "mimo")).changed, true);
    assert.equal((await projectModelStatus(projectRoot, environment)).dangling, false);
  });
});

// ---- T4 修复轮：WARN-2 数组算内容（B-B 变异体杀手） ----

test("an array left behind by the user counts as content, so clear keeps the created file", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, PROFILE_INPUT);
    const settingsPath = path.join(projectRoot, ".claude", "settings.local.json");
    await bindProject(projectRoot, environment, "mimo"); // created === true
    const content = JSON.parse(await readFile(settingsPath, "utf8"));
    content.env.MY_LIST = ["x"]; // 用户自己添加的非受管键，值是数组
    await writeFile(settingsPath, `${JSON.stringify(content, null, 2)}\n`);

    const cleared = await clearProjectBinding(projectRoot, environment);
    assert.deepEqual(cleared.conflicts, []);
    assert.equal(existsSync(settingsPath), true, "数组是内容：回滚后不得把本功能创建的文件当空删除");
    const kept = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepEqual(kept.env.MY_LIST, ["x"]);
    assert.equal("ANTHROPIC_BASE_URL" in kept.env, false, "受管键仍必须回滚干净");
  });
});

// ---- T4 修复轮：WARN-3 换绑后 created 分支（O2 变异体杀手） ----

test("rebinding keeps created=true so clearing still removes a file this feature created", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, PROFILE_INPUT);
    await upsertProfile(environment, PROFILE_LITE);
    const settingsPath = path.join(projectRoot, ".claude", "settings.local.json");
    assert.equal(existsSync(settingsPath), false);

    await bindProject(projectRoot, environment, "mimo"); // 文件由本功能创建 → created === true
    await bindProject(projectRoot, environment, "mimo_lite"); // 换绑不得把 created 退回"看磁盘"
    const binding = JSON.parse(await readFile(projectModelFile(projectRoot), "utf8"));
    assert.equal(binding.projection.claude.created, true, "created 必须来自账本而不是当前磁盘状态");
    const cleared = await clearProjectBinding(projectRoot, environment);
    assert.deepEqual(cleared.conflicts, []);
    assert.equal(existsSync(settingsPath), false, "spec L240：created === true 且回滚后无残留 → 删除文件");
  });
});

test("rebinding a user's own file keeps it as an empty shell after clear", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, PROFILE_WITH_TOGGLES);
    await upsertProfile(environment, PROFILE_LITE);
    const settingsPath = path.join(projectRoot, ".claude", "settings.local.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, `${JSON.stringify({ env: { USER_KEEP: "1" } }, null, 2)}\n`);

    await bindProject(projectRoot, environment, "mimo");
    await bindProject(projectRoot, environment, "mimo_lite");
    const binding = JSON.parse(await readFile(projectModelFile(projectRoot), "utf8"));
    assert.equal(binding.projection.claude.created, false);
    await clearProjectBinding(projectRoot, environment);
    assert.equal(existsSync(settingsPath), true, "用户原有文件永远保留");
    const restored = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(restored.env.USER_KEEP, "1");
    assert.equal("ANTHROPIC_BASE_URL" in restored.env, false);
  });
});

// ---- T4 修复轮：WARN-4 fingerprintMatches 方向（O10 变异体杀手） ----

test("fingerprintMatches flips when a profile field that reaches the projection changes", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, PROFILE_INPUT);
    await bindProject(projectRoot, environment, "mimo");
    const before = await projectModelStatus(projectRoot, environment);
    assert.equal(before.projection.fingerprintMatches, true);
    assert.equal(before.projection.fingerprint, before.binding.projection.claude.fingerprint);

    await upsertProfile(environment, {
      ...PROFILE_INPUT,
      endpoint: { ...PROFILE_INPUT.endpoint, baseUrl: "https://changed.example/anthropic" },
    });
    const after = await projectModelStatus(projectRoot, environment);
    assert.equal(after.projection.fingerprintMatches, false, "库中 profile 改了投影相关字段 → 项目投影必须判为过期");
    assert.equal(after.projection.fingerprint, before.projection.fingerprint, "只读状态检查不得改写绑定");
  });
});

// ---- T4 修复轮：WARN-5 项目 commit 回滚循环（O13 变异体杀手） ----

test("a failed second project file replacement rolls both project files back", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, PROFILE_INPUT);
    await bindProject(projectRoot, environment, "mimo");
    const modelFile = projectModelFile(projectRoot);
    const settingsFile = path.join(projectRoot, ".claude", "settings.local.json");
    const modelBefore = await readFile(modelFile);
    const settingsBefore = await readFile(settingsFile);
    const tempRoot = projectTempRoot(projectRoot);

    await assert.rejects(
      () => transact({
        tempRoot,
        read: async () => ({ revision: 0, value: null }),
        build: () => "next",
        stage: async (next, directory) => {
          const stagedModel = path.join(directory, "staged", "model.json");
          await mkdir(path.dirname(stagedModel), { recursive: true });
          await writeFile(stagedModel, `${JSON.stringify({ changed: true }, null, 2)}\n`);
          return [
            { relativePath: "model.json", staged: stagedModel, target: modelFile },
            // 第二个文件的 staged 不存在：commit 的中途失败必须整体回滚
            { relativePath: "settings.local.json", staged: path.join(directory, "staged", "missing.json"), target: settingsFile },
          ];
        },
        commit: commitProject,
      }),
      /ENOENT/,
    );

    assert.equal(modelBefore.equals(await readFile(modelFile)), true, "第一个文件必须逐字节回到原值");
    assert.equal(settingsBefore.equals(await readFile(settingsFile)), true, "第二个文件不得被半写");
    assert.deepEqual(existsSync(tempRoot) ? await readdir(tempRoot) : [], [], "事务目录不得残留");
  });
});

// ---- T4 修复轮：FAIL-2 项目文件权限 0600（POSIX；Windows 依赖 ACL，chmod 是 no-op） ----

test("bind and clear restrict both project files to 0600 on POSIX", { skip: process.platform === "win32" }, async () => {
  await withProject(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, PROFILE_INPUT);
    const settingsPath = path.join(projectRoot, ".claude", "settings.local.json");

    await bindProject(projectRoot, environment, "mimo");
    assert.equal((await stat(projectModelFile(projectRoot))).mode & 0o777, 0o600, ".agents/model.json 含明文 token，必须 0600");
    assert.equal((await stat(settingsPath)).mode & 0o777, 0o600, "投影文件含 token，必须 0600");

    // clear 后本功能创建的文件被删除；绑定文件仍是 0600
    await clearProjectBinding(projectRoot, environment);
    assert.equal(existsSync(settingsPath), false);
    assert.equal((await stat(projectModelFile(projectRoot))).mode & 0o777, 0o600, "clear 同样不得把权限放回 0644");

    // 用户原有文件：换绑 → clear 保留空壳，权限也必须收紧（我们往里写过 token）
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, `${JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }, null, 2)}\n`);
    await bindProject(projectRoot, environment, "mimo");
    await clearProjectBinding(projectRoot, environment);
    assert.equal(existsSync(settingsPath), true);
    assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
  });
});
