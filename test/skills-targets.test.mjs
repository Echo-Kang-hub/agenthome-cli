import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MANAGED_AGENT_ORDER,
  createInstallContext,
  managedSkillNames,
  readJson,
  writeInstallMetadata,
} from "../packages/core/src/index.mjs";

test("targets carry ids and the claude target shares from agents", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "avenic-targets-"));
  try {
    const context = createInstallContext(false, { cwd, environment: process.env });
    const ids = context.targets.map((target) => target.id);
    assert.deepEqual(ids, ["claude", "agents"]);
    assert.equal(new Set(ids).size, ids.length);
    const claude = context.targets.find((target) => target.id === "claude");
    assert.equal(claude.shareFrom, "agents");
    assert.equal(claude.shareDestination, path.join(cwd, ".agents", "skills"));
    const agents = context.targets.find((target) => target.id === "agents");
    assert.equal(agents.shareFrom, undefined);
    assert.equal(agents.shareDestination, undefined);
    assert.equal(claude.destination, path.join(cwd, ".claude", "skills"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("global context resolves the share destination under the home directory", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "avenic-targets-state-"));
  try {
    const context = createInstallContext(true, {
      environment: { ...process.env, AVENIC_STATE_DIR: stateDirectory },
    });
    const claude = context.targets.find((target) => target.id === "claude");
    assert.equal(claude.shareDestination, path.join(os.homedir(), ".agents", "skills"));
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("lock agents field uses the managed agent order, not table order", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "avenic-agents-"));
  try {
    const context = createInstallContext(false, { cwd, environment: process.env });
    await writeInstallMetadata(context, { packs: [], groups: [] });
    const lock = await readJson(context.lockFile);
    assert.deepEqual(lock.agents, [...MANAGED_AGENT_ORDER]);
    assert.deepEqual(lock.agents, ["claude-code", "codex", "opencode"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("managedSkillNames unions packs, adopted and direct records", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "avenic-managed-"));
  try {
    const context = createInstallContext(false, { cwd, environment: process.env });
    await mkdir(path.dirname(context.lockFile), { recursive: true });
    await writeFile(
      context.lockFile,
      `${JSON.stringify({
        schemaVersion: 3,
        sources: [{ id: "s", skills: ["alpha", "beta"] }],
        adopted: ["handmade"],
        directSources: [{ id: "d", skills: ["direct-one"] }],
      }, null, 2)}\n`,
    );
    const names = await managedSkillNames(context);
    assert.deepEqual([...names].sort(), ["alpha", "beta", "direct-one", "handmade"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("managedSkillNames is empty without a lock file", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "avenic-managed-empty-"));
  try {
    const context = createInstallContext(false, { cwd, environment: process.env });
    assert.equal((await managedSkillNames(context)).size, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
