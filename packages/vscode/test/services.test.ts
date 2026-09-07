import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentStatus, listAgents } from "../src/services/agents.ts";
import { defaultSpec, listKnown } from "../src/services/catalog.ts";
import { status as skillsStatus } from "../src/services/skills.ts";

test("agents service lists the three ecosystem agents", () => {
  assert.deepEqual(listAgents().map((a) => a.id).sort(), ["claude", "codex", "opencode"]);
});

test("agents service reports null effective config on fresh project", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    const status = await agentStatus(dir, "claude");
    assert.equal(status.effective, null); // 无 .avenic.json → null，可初始化
    assert.equal(typeof status.executableAvailable, "boolean");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("catalog service default spec is null on isolated state dir", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    const env: Record<string, string | undefined> = { ...process.env, AVENIC_STATE_DIR: dir };
    delete env.AVENIC_CATALOG_SPEC;
    delete env.AGENTHOME_CATALOG_SPEC;
    assert.equal(await defaultSpec(env), null);
    assert.ok(Array.isArray(await listKnown(env)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("catalog service default spec honors legacy AGENTHOME_CATALOG_SPEC", async (t) => {
  t.mock.method(console, "warn", () => {}); // core 对旧名打印 deprecation 警告，测试输出保持无噪声
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    const env: Record<string, string | undefined> = { ...process.env, AVENIC_STATE_DIR: dir };
    delete env.AVENIC_CATALOG_SPEC;
    delete env.AGENTHOME_CATALOG_SPEC;
    env.AGENTHOME_CATALOG_SPEC = "some/repo#main";
    assert.equal(await defaultSpec(env), "some/repo#main");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("skills service status is null on fresh project root", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    const env = { ...process.env, AVENIC_STATE_DIR: dir };
    assert.equal(await skillsStatus("project", dir, env), null);
    assert.equal(await skillsStatus("global", undefined, env), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
