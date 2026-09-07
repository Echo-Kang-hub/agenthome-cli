import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { agentStatus, deinitialize, initialize, setAuthMode, setSessionsMode } from "../src/services/agents.ts";

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

test("manifest registers the six agent command ids", async () => {
  const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  const ids = manifest.contributes?.commands ?? [];
  for (const id of ["avenic.agents.init", "avenic.agents.deinit", "avenic.agents.switchAuth", "avenic.agents.switchSessions", "avenic.agents.sessionsImport", "avenic.agents.sessionsWriteback"]) {
    assert.ok(ids.some((c: { command: string }) => c.command === id), id);
  }
});
