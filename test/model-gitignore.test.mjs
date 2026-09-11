import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MODEL_RULES,
  bindProject,
  ensureModelGitignore,
  projectModelFile,
  removeRuntimeGitignore,
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

const PAST = new Date("2000-01-01T00:00:00.000Z");

// 把 mtime 冻到过去再返回基线：只要发生任何写盘，mtime 必然不再是这个值。
async function freezeMtime(file) {
  await utimes(file, PAST, PAST);
  return (await stat(file)).mtimeMs;
}

function gitAvailable() {
  const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
  return probe.status === 0;
}

const PROFILE_INPUT = {
  id: "gi_probe",
  name: "Gitignore Probe",
  endpoint: {
    baseUrl: "https://gi.example/anthropic",
    api: "anthropic",
    apiKey: "sk-00001111222233334444",
  },
  models: { main: { id: "gi-model" } },
};

async function withProject(run) {
  await withTempDirectory("avenic-gi-project-", async (projectRoot) => {
    await withTempDirectory("avenic-gi-state-", async (stateDir) => {
      await run({ projectRoot, environment: { AVENIC_STATE_DIR: stateDir } });
    });
  });
}

test("ensureModelGitignore appends the model rules once and is idempotent", async () => {
  await withTempDirectory("avenic-gi-", async (projectRoot) => {
    assert.equal(await ensureModelGitignore(projectRoot), true);
    const first = await readFile(path.join(projectRoot, ".gitignore"), "utf8");
    for (const rule of MODEL_RULES) assert.equal(first.includes(rule), true);
    assert.equal(first.includes("# Agent Runtime"), true);
    assert.equal(await ensureModelGitignore(projectRoot), false);
    assert.equal(await readFile(path.join(projectRoot, ".gitignore"), "utf8"), first);
  });
});

test("removeRuntimeGitignore keeps the model rules while their files exist", async () => {
  await withTempDirectory("avenic-gi-keep-", async (projectRoot) => {
    await ensureModelGitignore(projectRoot);
    await mkdir(path.join(projectRoot, ".agents"), { recursive: true });
    await writeFile(path.join(projectRoot, ".agents", "model.json"), "{}");
    await mkdir(path.join(projectRoot, ".claude"), { recursive: true });
    await writeFile(path.join(projectRoot, ".claude", "settings.local.json"), "{}");
    await removeRuntimeGitignore(projectRoot, { sessions: true });
    const content = await readFile(path.join(projectRoot, ".gitignore"), "utf8");
    assert.equal(content.includes(".agents/model.json"), true);
    assert.equal(content.includes(".claude/settings.local.json"), true);
  });
});

test("removeRuntimeGitignore drops the model rules once their files are gone", async () => {
  await withTempDirectory("avenic-gi-drop-", async (projectRoot) => {
    await ensureModelGitignore(projectRoot);
    await removeRuntimeGitignore(projectRoot, { sessions: true });
    const content = await readFile(path.join(projectRoot, ".gitignore"), "utf8");
    assert.equal(content.includes(".agents/model.json"), false);
    assert.equal(content.includes(".claude/settings.local.json"), false);
  });
});

// A：崩溃残留的 .agents/model.lock 会出现在用户 git status 里；规则必须写入，
// 移除守卫与另两条模型规则同语义——文件仍在就不许移除。
test("MODEL_RULES covers the project lock file and removal guards it", async () => {
  assert.deepEqual(MODEL_RULES, [
    ".agents/model.json",
    ".claude/settings.local.json",
    ".agents/model.lock",
    ".agents/tmp/",
  ]);
  await withTempDirectory("avenic-gi-lock-", async (projectRoot) => {
    await ensureModelGitignore(projectRoot);
    await mkdir(path.join(projectRoot, ".agents"), { recursive: true });
    await writeFile(path.join(projectRoot, ".agents", "model.lock"), "{}\n");
    await removeRuntimeGitignore(projectRoot, { sessions: true });
    let content = await readFile(path.join(projectRoot, ".gitignore"), "utf8");
    assert.equal(content.includes(".agents/model.lock"), true);

    await rm(path.join(projectRoot, ".agents", "model.lock"));
    await removeRuntimeGitignore(projectRoot, { sessions: true });
    content = await readFile(path.join(projectRoot, ".gitignore"), "utf8");
    assert.equal(content.includes(".agents/model.lock"), false);
  });
});

// B：init 过的项目已有 `# Agent Runtime` 分节，保存模型配置不得再写第二个同名头。
test("ensureModelGitignore does not duplicate the Agent Runtime header", async () => {
  await withTempDirectory("avenic-gi-header-", async (projectRoot) => {
    const original = "# Agent Runtime\n.agents/local/\n";
    await writeFile(path.join(projectRoot, ".gitignore"), original);
    assert.equal(await ensureModelGitignore(projectRoot), true);
    const content = await readFile(path.join(projectRoot, ".gitignore"), "utf8");
    assert.equal(content.split("# Agent Runtime").length - 1, 1);
    assert.equal(content.startsWith(original), true); // 原有行逐字保留
    for (const rule of MODEL_RULES) assert.equal(content.includes(rule), true);
  });
});

// B 的边界：受管规则已存在但没有头时，只追加缺行，不再补一个新头。
test("ensureModelGitignore adds no header when managed rules already exist", async () => {
  await withTempDirectory("avenic-gi-nohdr-", async (projectRoot) => {
    await writeFile(path.join(projectRoot, ".gitignore"), ".agents/skills/\n");
    assert.equal(await ensureModelGitignore(projectRoot), true);
    const content = await readFile(path.join(projectRoot, ".gitignore"), "utf8");
    assert.equal(content.split("# Agent Runtime").length - 1, 0);
    assert.equal(content.startsWith(".agents/skills/\n"), true);
    assert.equal(content.includes(".agents/model.json"), true);
  });
});

// C：绑定必须自己保证密钥文件被 ignore（CLI / VS Code / 指纹刷新都走 bindProject）。
test("bindProject ensures the secret-bearing files are ignored", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, PROFILE_INPUT);
    await bindProject(projectRoot, environment, PROFILE_INPUT.id);

    const content = await readFile(path.join(projectRoot, ".gitignore"), "utf8");
    assert.equal(content.includes(".agents/model.json"), true);
    assert.equal(content.includes(".claude/settings.local.json"), true);
    assert.equal(existsSync(projectModelFile(projectRoot)), true);
    const settings = path.join(projectRoot, ".claude", "settings.local.json");
    assert.equal(existsSync(settings), true);

    if (!gitAvailable()) {
      console.error("git unavailable: falling back to .gitignore line assertions only");
      return;
    }
    spawnSync("git", ["init", "--quiet"], { cwd: projectRoot });
    for (const target of [".agents/model.json", ".claude/settings.local.json"]) {
      const check = spawnSync("git", ["check-ignore", "-v", target], { cwd: projectRoot, encoding: "utf8" });
      assert.equal(check.status, 0, check.stderr);
      assert.match(check.stdout, /^\.gitignore:\d+:/m);
      assert.equal(check.stdout.includes(target), true);
    }
  });
});

// C：幂等——重绑同一 profile 不得重写 .gitignore（逐字节 + mtime 都不许变）。
test("rebinding the same profile leaves .gitignore byte-identical", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, PROFILE_INPUT);
    await bindProject(projectRoot, environment, PROFILE_INPUT.id);
    const file = path.join(projectRoot, ".gitignore");
    const before = await readFile(file, "utf8");
    const frozen = await freezeMtime(file);

    const again = await bindProject(projectRoot, environment, PROFILE_INPUT.id);
    assert.equal(again.changed, false);
    assert.equal(await readFile(file, "utf8"), before);
    assert.equal((await stat(file)).mtimeMs, frozen);
  });
});

// C：gitignore 写不进去时绑定必须响亮失败，且不得先写出任何含密钥的文件。
test("bindProject fails loudly and writes nothing when .gitignore cannot be updated", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, PROFILE_INPUT);
    await mkdir(path.join(projectRoot, ".gitignore")); // 目录占位 → 读写必然失败
    await assert.rejects(
      bindProject(projectRoot, environment, PROFILE_INPUT.id),
      (error) => {
        assert.match(error.message, /\.gitignore/);
        assert.equal(error.cause?.code, "EISDIR");
        return true;
      },
    );
    assert.equal(existsSync(projectModelFile(projectRoot)), false);
    assert.equal(existsSync(path.join(projectRoot, ".claude", "settings.local.json")), false);
  });
});
