import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
