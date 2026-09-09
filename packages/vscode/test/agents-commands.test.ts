import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { agentStatus, deinitialize, initialize, prepareAgentLaunch, setAuthMode, setSessionsMode } from "../src/services/agents.ts";

test("init → auth switch → sessions switch → deinit round-trip on real core", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    await initialize(dir, "claude", "global", "project");
    let status = await agentStatus(dir, "claude");
    assert.equal(status.effective?.auth, "global");
    assert.equal(status.effective?.sessions, "project");
    await setAuthMode(dir, "claude", "project");
    status = await agentStatus(dir, "claude");
    assert.equal(status.effective?.auth, "project");
    await setSessionsMode(dir, "claude", "global");
    status = await agentStatus(dir, "claude");
    assert.equal(status.effective?.sessions, "global");
    await deinitialize(dir, "claude");
    assert.equal((await agentStatus(dir, "claude")).effective, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("manifest registers the seven agent command ids", async () => {
  const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  const ids = manifest.contributes?.commands ?? [];
  for (const id of ["avenic.agents.init", "avenic.agents.launch", "avenic.agents.deinit", "avenic.agents.switchAuth", "avenic.agents.switchSessions", "avenic.agents.sessionsImport", "avenic.agents.sessionsWriteback"]) {
    assert.ok(ids.some((c: { command: string }) => c.command === id), id);
  }
});

// 启动准备复用 core 原语（与 `avenic claude` 同语义）：project auth → CLAUDE_CONFIG_DIR 指入
// 项目内 .agents/local/claude（原生存储随项目走=测试隔离在临时目录）；project sessions →
// 快照/恢复租赁；finishRun 收官回写并保证幂等。未初始化 → 拒绝启动。
test("prepareAgentLaunch returns avenic runtime environment and scoped sessions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-launch-"));
  try {
    await assert.rejects(() => prepareAgentLaunch(dir, "claude"), /尚未初始化/);
    await initialize(dir, "claude", "project", "project");
    const prepared = await prepareAgentLaunch(dir, "claude");
    assert.equal(prepared.definition.cwd, dir);
    assert.equal(prepared.definition.command, "claude");
    assert.ok(prepared.definition.name.includes("Claude Code"));
    const configDir = prepared.definition.environment.CLAUDE_CONFIG_DIR;
    assert.equal(!!configDir, true);
    assert.equal(path.resolve(configDir!), path.resolve(dir, ".agents", "local", "claude"), "项目域认证环境指向项目内目录");
    await prepared.finishRun();
    await prepared.finishRun(); // 幂等：第二次 no-op
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
