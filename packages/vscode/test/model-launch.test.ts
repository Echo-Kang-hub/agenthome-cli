import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bindProject, removeProfile, upsertProfile } from "@avenic/core";
import { initialize, prepareAgentLaunch } from "../src/services/agents.ts";

// prepareAgentLaunch 读的是真实 process.env（与生产一致：用户可以靠 AVENIC_STATE_DIR 换状态根），
// 所以这里临时改它再还原，而不是用 testEnv 的副本——那会让被测代码仍然读宿主真机库。
// 同时剥离宿主的 ANTHROPIC_*/CLAUDE_*：开发机自己往往就跑在某个自定义端点上（本机就是这样），
// 留着它们则"绑定前"也已经有这些变量，注入断言既失去区分力、又会随开发机环境漂移。
// node --test 同一文件内的用例是顺序执行的，try/finally 还原即可。
const HOST_MODEL_ENV = /^(?:ANTHROPIC_|CLAUDE_)/;

async function withStateRoot<T>(stateRoot: string, run: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  const capture = (key: string) => { saved.set(key, process.env[key]); delete process.env[key]; };
  for (const key of Object.keys(process.env)) {
    if (HOST_MODEL_ENV.test(key)) capture(key);
  }
  capture("AVENIC_STATE_DIR"); // 原本不存在时 saved 记 undefined，finally 里 delete 即可
  process.env.AVENIC_STATE_DIR = stateRoot;
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function fixture(): Promise<{ root: string; state: string; dir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-model-launch-"));
  const state = path.join(root, "state");
  const dir = path.join(root, "project");
  await mkdir(dir, { recursive: true });
  return { root, state, dir };
}

test("an unbound project launches exactly as before (no injection, no note)", async () => {
  const { root, state, dir } = await fixture();
  try {
    await withStateRoot(state, async () => {
      await initialize(dir, "claude", "project", "project");
      const prepared = await prepareAgentLaunch(dir, "claude");
      assert.equal(prepared.definition.command, "claude");
      assert.deepEqual(prepared.definition.argumentsList, []);
      assert.equal(prepared.definition.note, null);
      await prepared.finishRun();
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Claude 走环境变量：注入必须"合并"进基础环境，而不是把它整个换掉——
// 若 launchEnvironment 直接用 injection.environment 而不带上原始 environment，PATH 会消失、终端起不来。
test("a bound profile injects Claude env by merging into the base environment", async () => {
  const { root, state, dir } = await fixture();
  try {
    await withStateRoot(state, async () => {
      await upsertProfile(process.env, {
        id: "bound",
        name: "Anthropic 官方",
        endpoint: { baseUrl: "https://api.anthropic.com", api: "anthropic", authField: "ANTHROPIC_AUTH_TOKEN", apiKey: "sk-test-bound" },
        models: { main: { id: "claude-sonnet-5" } },
      });
      await initialize(dir, "claude", "project", "project");
      const before = await prepareAgentLaunch(dir, "claude");
      assert.equal(before.definition.environment.ANTHROPIC_BASE_URL, undefined, "绑定前不该有注入");
      await before.finishRun();

      await bindProject(dir, process.env, "bound");
      const prepared = await prepareAgentLaunch(dir, "claude");
      assert.equal(prepared.definition.command, "claude", "Claude 不需要 argv，命令保持裸可执行名");
      assert.deepEqual(prepared.definition.argumentsList, []);
      assert.equal(prepared.definition.environment.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
      assert.equal(prepared.definition.environment.ANTHROPIC_AUTH_TOKEN, "sk-test-bound");
      assert.equal(prepared.definition.environment.ANTHROPIC_MODEL, "claude-sonnet-5");
      // 基础环境仍在：PATH 这类宿主变量必须逐字保留
      const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH");
      assert.ok(pathKey !== undefined, "宿主环境里应有 PATH");
      assert.equal(prepared.definition.environment[pathKey!], process.env[pathKey!], "注入不得吞掉宿主环境");
      // 项目域认证变量（会话/认证子系统用的那份 environment）同样还在
      assert.equal(prepared.definition.environment.CLAUDE_CONFIG_DIR, path.join(dir, ".agents", "local", "claude"));
      await prepared.finishRun();
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Codex 走 argv。sendText 会把整行交给用户的 shell 二次解析，所以含空格的取值必须先引号化，
// 否则会被拆成两个参数——而预设名里就带空格（「小米 MiMo」「Moonshot Kimi」「智谱 GLM」）。
test("a bound Codex profile injects argv with whitespace-containing values quoted", async () => {
  const { root, state, dir } = await fixture();
  try {
    await withStateRoot(state, async () => {
      await upsertProfile(process.env, {
        id: "mimo",
        name: "小米 MiMo",
        endpoint: { baseUrl: "https://api.anthropic.com", api: "anthropic", authField: "ANTHROPIC_AUTH_TOKEN", apiKey: "sk-main" },
        // Codex 需要 Responses 端点：没有 overrides.codex 时 core 会判定不兼容而不注入
        overrides: {
          // authField 只有两个合法值（core 的 AUTH_FIELDS），它描述的是"请求头用哪个名字"，
          // 与端点是不是 OpenAI 形态无关。
          codex: { baseUrl: "https://api.openai.com/v1", api: "openai-responses", authField: "ANTHROPIC_API_KEY", apiKey: "sk-codex", providerId: "mimo" },
        },
        models: { main: { id: "mimo-7b" } },
      });
      await initialize(dir, "codex", "project", "project");
      await bindProject(dir, process.env, "mimo");

      const prepared = await prepareAgentLaunch(dir, "codex");
      assert.ok(prepared.definition.argumentsList.length > 0, "Codex 必须拿到 argv 注入");
      assert.ok(prepared.definition.argumentsList.includes("model_provider=mimo"), "argv 里应有 -c model_provider=mimo");
      assert.equal(prepared.definition.note, null);

      // 命令是给 shell 的一整行：含空格的取值必须整段引号化（与 core 的 runtime/process.mjs 同一规则：
      // 引号包住整个 `key=value`，而不是只包 value），否则 shell 会把它拆成两个参数。
      assert.ok(
        prepared.definition.command.includes('"model_providers.mimo.name=小米 MiMo"'),
        `带空格的 provider 名必须整段被引号化，实际命令：${prepared.definition.command}`,
      );
      // 只有这一处需要引号：引号数恰为 2 且成对——引号化一旦丢失，这条立刻变红
      assert.equal(
        (prepared.definition.command.match(/"/g) ?? []).length,
        2,
        `引号应恰好成对出现一次，实际命令：${prepared.definition.command}`,
      );
      // 无空格的取值不该被无谓地引号化（否则用户复制命令行时多一层噪音）
      assert.equal(prepared.definition.command.includes('"https://api.openai.com/v1"'), false);
      assert.ok(prepared.definition.command.includes("-m mimo-7b"), "主模型经 -m 注入");
      await prepared.finishRun();
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// spec §13：模型配置读取/注入失败绝不阻断启动，但也不能静默——必须留下可读原因。
test("a corrupt binding is reported and never blocks the launch", async () => {
  const { root, state, dir } = await fixture();
  try {
    await withStateRoot(state, async () => {
      await initialize(dir, "claude", "project", "project");
      await writeFile(path.join(dir, ".agents", "model.json"), "{ not json ");
      const prepared = await prepareAgentLaunch(dir, "claude");
      assert.equal(prepared.definition.command, "claude", "绑定损坏也必须照常启动");
      assert.deepEqual(prepared.definition.argumentsList, []);
      assert.match(prepared.definition.note ?? "", /Model configuration skipped: /);
      await prepared.finishRun();
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// dangling（绑定指向已删除的配置）：core 负责安全回滚（幂等），插件负责让用户看见原因。
test("a binding to a deleted profile rolls back safely and reports why", async () => {
  const { root, state, dir } = await fixture();
  try {
    await withStateRoot(state, async () => {
      await upsertProfile(process.env, {
        id: "gone",
        name: "待删除",
        endpoint: { baseUrl: "https://api.anthropic.com", api: "anthropic", authField: "ANTHROPIC_AUTH_TOKEN", apiKey: "sk-gone" },
      });
      await initialize(dir, "claude", "project", "project");
      await bindProject(dir, process.env, "gone");
      await removeProfile(process.env, "gone");

      const prepared = await prepareAgentLaunch(dir, "claude");
      assert.equal(prepared.definition.command, "claude");
      assert.deepEqual(prepared.definition.argumentsList, [], "配置已不存在 → 不注入");
      assert.ok(prepared.definition.note !== null, "dangling 必须留下可读提示，不能静默");
      await prepared.finishRun();
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
