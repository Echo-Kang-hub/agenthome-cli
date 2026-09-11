import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getProfile, upsertProfile } from "../packages/core/src/index.mjs";
import { dispatchModel } from "../packages/cli/src/cli/model-cli.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentBin = path.join(packageRoot, "packages", "cli", "scripts", "skills.mjs");

function runAgent(cwd, argumentsList, environment = {}) {
  return spawnSync(process.execPath, [agentBin, ...argumentsList], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...environment },
  });
}

// 裁决 3 的 stdin 形式：spawnSync 的 input 把粘贴文本接进子进程 fd 0。
function runAgentWithInput(cwd, argumentsList, environment, input) {
  return spawnSync(process.execPath, [agentBin, ...argumentsList], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    input,
    env: { ...process.env, ...environment },
  });
}

async function withTempDirectory(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withProject(run) {
  await withTempDirectory("avenic-model-cli-", async (projectRoot) => {
    await withTempDirectory("avenic-model-state-", async (stateDir) => {
      await run({ projectRoot, environment: { AVENIC_STATE_DIR: stateDir } });
    });
  });
}

const silentIo = { log() {} };

// 裁决 5：`model test` 的网络调用必须可注入，测试永不打真实请求。
const FAKE_TEST_CONNECTION_FAILURE = {
  ok: false,
  message: "网络 / DNS / TLS 不可达——连接失败 ≠ 密钥无效",
  url: "http://127.0.0.1/v1/messages",
  model: "m",
};

test("model add/list/show/use/clear round-trip with masked output", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    const added = runAgent(projectRoot, [
      "model", "add", "--name", "MiMo",
      "--base-url", "https://token-plan-cn.xiaomimimo.com/anthropic",
      "--api-key", "sk-aaaabbbbccccdddd",
      "--api", "anthropic",
      "--model", "mimo-v2.5-pro",
    ], environment);
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /mimo/);
    assert.doesNotMatch(added.stdout, /sk-aaaabbbbccccdddd/, "the key is never printed in full");
    assert.match(added.stdout, /sk-…dddd/);

    const listed = runAgent(projectRoot, ["model", "list"], environment);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /MiMo/);

    const used = runAgent(projectRoot, ["model", "use", "mimo"], environment);
    assert.equal(used.status, 0, used.stderr);
    assert.match(used.stdout, /\.claude\/settings\.local\.json|settings\.local\.json/);
    const settings = JSON.parse(await readFile(path.join(projectRoot, ".claude", "settings.local.json"), "utf8"));
    assert.equal(settings.env.ANTHROPIC_MODEL, "mimo-v2.5-pro");
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "sk-aaaabbbbccccdddd");

    const shown = runAgent(projectRoot, ["model", "show"], environment);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /Current profile\s+MiMo/);
    assert.doesNotMatch(shown.stdout, /sk-aaaabbbbccccdddd/);

    const cleared = runAgent(projectRoot, ["model", "clear"], environment);
    assert.equal(cleared.status, 0, cleared.stderr);
    // 裁决 6：clear 走 spec §6 收尾——该文件由 Avenic 自己创建且回滚后无残留 → 被删除。
    // 断言的意图是「注入的键已消失」，文件不存在同样满足（core 侧 model-binding.test.mjs:115 钉死删除行为）。
    const settingsPath = path.join(projectRoot, ".claude", "settings.local.json");
    const restored = existsSync(settingsPath) ? JSON.parse(await readFile(settingsPath, "utf8")) : { env: {} };
    assert.equal("ANTHROPIC_MODEL" in (restored.env ?? {}), false);
    assert.equal((await readFile(path.join(projectRoot, ".gitignore"), "utf8")).includes(".agents/model.json"), true);
  });
});

test("model rejects a URL that cmd.exe would mangle (§12.6 whitelist)", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    const result = runAgent(projectRoot, ["model", "add", "--name", "Bad", "--base-url", "https://x.example/v1?a=1&b=2", "--api-key", "sk-x"], environment);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must not contain/i);
  });
});

test("model does not fall through to the Pack dispatcher and reports usage", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    const result = runAgent(projectRoot, ["model", "bogus"], environment);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: avenic model/);
  });
});

test("a dangling binding disables injection and prints the fixed message", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    runAgent(projectRoot, ["model", "add", "--name", "MiMo", "--base-url", "https://a.example/anthropic", "--api-key", "sk-a", "--model", "m"], environment);
    runAgent(projectRoot, ["model", "use", "mimo"], environment);
    const removed = runAgent(projectRoot, ["model", "remove", "mimo"], environment);
    assert.equal(removed.status, 0, removed.stderr);

    const status = runAgent(projectRoot, ["model", "show"], environment);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Profile "mimo" no longer exists; Avenic configuration disabled for this project\./);

    const again = runAgent(projectRoot, ["model", "show"], environment);
    assert.doesNotMatch(again.stdout, /no longer exists/, "cleanup is idempotent");
  });
});

// ---- 裁决 3：`--json <file|->` 只做预览，绝不写库（粘贴永不自动保存）----

test("model add --json previews a pasted file without saving it", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    const pasteFile = path.join(projectRoot, "paste.txt");
    await writeFile(pasteFile, [
      "export ANTHROPIC_BASE_URL=https://paste.example/anthropic",
      "export ANTHROPIC_AUTH_TOKEN=sk-pasted-not-a-real-key",
      "主模型 mimo-v2.5-pro",
    ].join("\n"));

    const result = runAgent(projectRoot, ["model", "add", "--name", "Pasted", "--json", pasteFile], environment);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /mimo-v2\.5-pro/, "the recognized model is echoed back");
    assert.doesNotMatch(result.stdout, /sk-pasted-not-a-real-key/, "the pasted key is never echoed in full");
    assert.equal(existsSync(path.join(environment.AVENIC_STATE_DIR, "models.json")), false, "preview never writes the library");

    const listed = runAgent(projectRoot, ["model", "list"], environment);
    assert.doesNotMatch(listed.stdout, /Pasted/);
  });
});

test("model add --json - reads the paste from stdin and still writes nothing", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    const paste = [
      "ANTHROPIC_BASE_URL=https://stdin.example/anthropic",
      "ANTHROPIC_API_KEY=sk-stdin-not-a-real-key",
      "ANTHROPIC_MODEL=stdin-model-v1",
    ].join("\n");
    const result = runAgentWithInput(projectRoot, ["model", "add", "--name", "Stdin", "--json", "-"], environment, paste);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /stdin-model-v1/);
    assert.doesNotMatch(result.stdout, /sk-stdin-not-a-real-key/);
    assert.equal(existsSync(path.join(environment.AVENIC_STATE_DIR, "models.json")), false);
  });
});

// ---- 裁决 5：`model test` 的退出码 2 用注入的假 testConnection 覆盖 ----

test("model test exits 2 on a failed probe and never prints the key", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    const fullEnvironment = { ...process.env, ...environment };
    await upsertProfile(fullEnvironment, {
      id: "probe",
      name: "Probe",
      endpoint: { baseUrl: "https://probe.example/anthropic", apiKey: "sk-not-a-real-key-0001" },
      models: { main: { id: "probe-model" } },
    }, silentIo);

    const lines = [];
    const status = await dispatchModel(["test", "probe"], {
      io: { log: (line = "") => lines.push(String(line)) },
      cwd: projectRoot,
      environment: fullEnvironment,
      testConnection: async () => FAKE_TEST_CONNECTION_FAILURE,
    });
    assert.equal(status, 2);
    assert.match(lines.join("\n"), /✗/);
    assert.doesNotMatch(JSON.stringify(lines), /sk-not-a-real-key-0001/);
  });
});

test("model test exits 0 on a successful probe and never prints the key", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    const fullEnvironment = { ...process.env, ...environment };
    await upsertProfile(fullEnvironment, {
      id: "probe",
      name: "Probe",
      endpoint: { baseUrl: "https://probe.example/anthropic", apiKey: "sk-not-a-real-key-0001" },
      models: { main: { id: "probe-model" } },
    }, silentIo);

    const lines = [];
    const status = await dispatchModel(["test", "probe"], {
      io: { log: (line = "") => lines.push(String(line)) },
      cwd: projectRoot,
      environment: fullEnvironment,
      testConnection: async () => ({ ok: true, message: "连接成功（12 ms）", url: "http://127.0.0.1/v1/messages", model: "m" }),
    });
    assert.equal(status, 0);
    assert.match(lines.join("\n"), /✓/);
    assert.doesNotMatch(JSON.stringify(lines), /sk-not-a-real-key-0001/);
  });
});

// ---- 「必须自己验证」1：use 的输出同样不得出现完整密钥 ----

test("model use never prints the full key", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    runAgent(projectRoot, ["model", "add", "--name", "MiMo", "--base-url", "https://a.example/anthropic", "--api-key", "sk-aaaabbbbccccdddd", "--model", "m"], environment);
    const used = runAgent(projectRoot, ["model", "use", "mimo"], environment);
    assert.equal(used.status, 0, used.stderr);
    assert.doesNotMatch(used.stdout, /sk-aaaabbbbccccdddd/);
  });
});

// ---- edit/set 不得静默抹掉自己管不到的字段 ----

// profileInputFrom 只从 flags 与 existing 拼出 id/name/endpoint/models 五个字段，
// 而 core 的 normalizeProfile 是「白名单化」：没传的字段不留原值、而是取默认值。
// 于是 `avenic model edit <id> --name X` 会顺手把 overrides / codex / opencode / env /
// toggles / claude 全部清掉，并把 endpoint.authField 悄悄换回默认——都不可撤销。
// CLI 没有任何覆盖这些字段的 flag，所以唯一正确的语义就是「原样带过」。
test("model edit keeps every field the flags cannot express", async () => {
  await withProject(async ({ projectRoot, environment }) => {
    await upsertProfile(environment, {
      id: "rich",
      name: "Rich",
      endpoint: { baseUrl: "https://a.example/anthropic", api: "anthropic", apiKey: "sk-keepme-123456", authField: "ANTHROPIC_API_KEY" },
      overrides: {
        codex: { baseUrl: "https://api.openai.com/v1", api: "openai-responses", authField: "ANTHROPIC_API_KEY", apiKey: "sk-codex-999999", providerId: "richcodex" },
      },
      models: { main: { id: "m" }, opus: { id: "o", display: "Opus", longContext: true } },
      toggles: { teams: true, maxEffort: true },
      env: { AVENIC_CUSTOM_FLAG: "1" },
      claude: { settings: { someKey: true } },
      codex: { providerId: "richcodex", envKey: "RICH_KEY", reasoningEffort: "high" },
      opencode: { providerId: "richoc", npmAdapter: "@ai-sdk/openai-compatible" },
    });
    const before = await getProfile(environment, "rich");

    const status = await dispatchModel(["edit", "rich", "--name", "Rich 改名"], { cwd: projectRoot, environment, io: silentIo });
    assert.equal(status, 0);
    const after = await getProfile(environment, "rich");

    assert.equal(after.name, "Rich 改名", "flag 指定的字段当然要生效");
    // 逐字段比对会随 core 加字段而失效；整体比对（只挖掉「本来就该变」的 updatedAt 与 name）
    // 是**金丝雀**：core 将来新增任何字段、而 profileInputFrom 忘了带过，这里立刻变红。
    const untouched = ({ updatedAt, name, ...rest }) => rest;
    assert.deepEqual(untouched(after), untouched(before), "除 updatedAt 与本次改名外，库中字段必须逐字保留");
    assert.deepEqual(after.overrides, before.overrides, "Codex/OpenCode 端点覆盖不得被抹掉");
    assert.deepEqual(after.endpoint, before.endpoint, "未被编辑的 endpoint（含 authField 与密钥）必须逐字保留");
  });
});
