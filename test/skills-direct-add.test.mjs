import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createInstallContext, readDirectState, removeExternalSkills } from "../packages/core/src/index.mjs";
import { writeJson } from "../packages/core/src/util/json.mjs";

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

function git(cwd, argumentsList) {
  const result = spawnSync("git", ["-C", cwd, ...argumentsList], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function withTemp(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function commitAll(root, message) {
  await git(root, ["init", "--quiet", "-b", "main"]);
  await git(root, ["add", "-A"]);
  await git(root, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", message]);
}

async function upstreamFixture(root, skillNames) {
  await mkdir(path.join(root, "skills"), { recursive: true });
  for (const name of skillNames) {
    await mkdir(path.join(root, "skills", name), { recursive: true });
    await writeFile(path.join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
  }
  await writeFile(path.join(root, "LICENSE"), "MIT\n");
  await commitAll(root, "upstream");
  return git(root, ["rev-parse", "HEAD"]);
}

async function catalogFixture(root) {
  await mkdir(path.join(root, "packs"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "fixture-catalog", version: "1.0.0", private: true, agentSkills: { packageSpec: "fixture#main" } }, null, 2)}\n`,
  );
  await writeFile(
    path.join(root, "sources.lock.json"),
    `${JSON.stringify({ schemaVersion: 1, sources: [{ id: "test-source", name: "Test Source", repository: "https://github.com/example/test.git", skillRoot: "skills", revision: "a".repeat(40) }] }, null, 2)}\n`,
  );
  const directory = path.join(root, "skills", "test-source", "alpha");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), "---\nname: alpha\n---\n");
  const common = { schemaVersion: 1, id: "common", name: "Common", sources: [{ source: "test-source", skills: ["alpha"] }] };
  await writeFile(path.join(root, "packs", "common.json"), `${JSON.stringify(common, null, 2)}\n`);
  await commitAll(root, "fixture catalog");
}

test("skills add installs direct public sources into project scope", async () => {
  await withTemp("direct-", async (root) => {
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    const upstream = path.join(root, "upstream");
    await mkdir(project);
    const revision = await upstreamFixture(upstream, ["direct-a", "direct-b"]);
    const environment = { AVENIC_STATE_DIR: state };
    const added = runAgent(project, ["skills", "add", upstream], environment);
    assert.equal(added.status, 0, added.stderr);
    for (const name of ["direct-a", "direct-b"]) {
      assert.equal(existsSync(path.join(project, ".agents", "skills", name, "SKILL.md")), true);
      assert.equal(existsSync(path.join(project, ".claude", "skills", name, "SKILL.md")), true);
    }
    const config = JSON.parse(await readFile(path.join(project, ".agent-skills.json"), "utf8"));
    assert.equal(config.schemaVersion, 3);
    assert.equal(config.direct[0].skills.length, 2);
    const lock = JSON.parse(await readFile(path.join(project, ".agent-skills.lock.json"), "utf8"));
    assert.equal(lock.schemaVersion, 3);
    assert.equal(lock.directSources[0].revision, revision);
    assert.equal(existsSync(path.join(project, ".agents", "licenses", lock.directSources[0].id, "LICENSE")), true);
    const repeated = runAgent(project, ["skills", "add", upstream], environment);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.match(repeated.stdout, /Already installed/);
  });
});

test("skills add supports single skill and remove clears direct state", async () => {
  await withTemp("direct-single-", async (root) => {
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    const upstream = path.join(root, "upstream");
    await mkdir(project);
    await upstreamFixture(upstream, ["direct-a", "direct-b"]);
    const environment = { AVENIC_STATE_DIR: state };
    const added = runAgent(project, ["skills", "add", upstream, "direct-a"], environment);
    assert.equal(added.status, 0, added.stderr);
    assert.equal(existsSync(path.join(project, ".agents", "skills", "direct-a")), true);
    assert.equal(existsSync(path.join(project, ".agents", "skills", "direct-b")), false);
    const removed = runAgent(project, ["skills", "remove", "direct-a"], environment);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(existsSync(path.join(project, ".agents", "skills", "direct-a")), false);
    const lock = JSON.parse(await readFile(path.join(project, ".agent-skills.lock.json"), "utf8"));
    assert.equal(lock.directSources.length, 0);
  });
});

test("skills add refuses skills managed by catalog Packs", async () => {
  await withTemp("direct-managed-", async (root) => {
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    const catalog = path.join(root, "catalog");
    const upstream = path.join(root, "upstream");
    await mkdir(project);
    await catalogFixture(catalog);
    await upstreamFixture(upstream, ["alpha", "direct-b"]);
    const environment = { AVENIC_CATALOG_SPEC: catalog, AVENIC_STATE_DIR: state };
    const installed = runAgent(project, ["skills", "common"], environment);
    assert.equal(installed.status, 0, installed.stderr);
    const refused = runAgent(project, ["skills", "add", upstream, "alpha"], environment);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Managed by configured Packs/);
  });
});

test("skills add rejects refs on direct sources instead of a git error", async () => {
  await withTemp("direct-ref-", async (root) => {
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    await mkdir(project);
    const refused = runAgent(project, ["skills", "add", "example/skills#main"], {
      AVENIC_STATE_DIR: state,
    });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Refs are not supported/);
  });
});

test("skills add fails clearly when upstream has no Skills", async () => {
  await withTemp("direct-empty-", async (root) => {
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    const upstream = path.join(root, "upstream");
    await mkdir(project);
    await mkdir(upstream);
    await writeFile(path.join(upstream, "README.md"), "empty upstream\n");
    await commitAll(upstream, "empty");
    const refused = runAgent(project, ["skills", "add", upstream], { AVENIC_STATE_DIR: state });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /No Skill/);
  });
});

test("removeExternalSkills refuses managed skills and removes direct ones", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remove-direct-"));
  try {
    const context = createInstallContext(false, { cwd: root, environment: process.env });
    await writeJson(context.lockFile, {
      schemaVersion: 3,
      sources: [{ id: "s-source", name: "S", repository: "https://github.com/example/s.git", revision: "a".repeat(40), skills: ["managed-skill"] }],
    });
    await assert.rejects(
      () => removeExternalSkills(context, ["managed-skill"], { io: { log() {} } }),
      /Managed by configured Packs/,
    );
    await writeJson(context.lockFile, {
      schemaVersion: 3,
      directSources: [{ id: "d-source", name: "D", repository: "https://github.com/example/d.git", revision: "a".repeat(40), skillRoot: "skills", skills: ["d-skill"] }],
    });
    const target = path.join(context.targets[0].destination, "d-skill");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), "---\nname: d-skill\n---\n");
    const result = await removeExternalSkills(context, ["d-skill"], { io: { log() {} } });
    assert.deepEqual(result.directRemoved, ["d-skill"]);
    assert.equal(existsSync(target), false);
    assert.deepEqual((await readDirectState(context)).directSources, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
