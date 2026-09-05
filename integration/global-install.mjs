import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(path.join(os.tmpdir(), "agenthome-global-install-"));
const prefix = path.join(root, "prefix");
const home = path.join(root, "home");
const stateDirectory = path.join(root, "state");
const projectRoot = path.join(root, "project");
const npmCli = process.env.npm_execpath;

function git(cwd, argumentsList) {
  const result = spawnSync("git", ["-C", cwd, ...argumentsList], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function runLauncher(launcher, argumentsList, cwd, environment) {
  const windows = process.platform === "win32";
  const result = spawnSync(
    windows ? `"${launcher}" ${argumentsList.join(" ")}` : launcher,
    windows ? [] : argumentsList,
    { cwd, encoding: "utf8", env: environment, shell: windows, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function pack(directory, environment) {
  const result = spawnSync(
    process.execPath,
    [npmCli, "pack", directory, "--pack-destination", root, "--json"],
    { encoding: "utf8", env: environment, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return path.join(root, JSON.parse(result.stdout)[0].filename);
}

async function verifyInstall(archive, environment) {
  const installed = spawnSync(
    process.execPath,
    [npmCli, "install", "--global", archive, "--prefix", prefix],
    { encoding: "utf8", env: environment, windowsHide: true },
  );
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const binDirectory = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  const launcher = path.join(binDirectory, process.platform === "win32" ? "ax.cmd" : "ax");
  assert.equal(existsSync(launcher), true, `Missing global launcher: ${launcher}`);
  await mkdir(projectRoot, { recursive: true });
  const launched = runLauncher(launcher, ["init", "--auth", "global"], projectRoot, environment);
  assert.match(launched.stdout, /Initialized successfully/);
  assert.equal(existsSync(path.join(projectRoot, ".agents", "runtime.json")), true);
  const deinitialized = runLauncher(launcher, ["deinit", "--purge"], projectRoot, environment);
  assert.match(deinitialized.stdout, /Runtime   Removed/);
  assert.match(deinitialized.stdout, /Data      Purged/);
  assert.equal(existsSync(path.join(projectRoot, ".agents", "runtime.json")), false);
}

async function uninstall(packageName, environment) {
  const result = spawnSync(
    process.execPath,
    [npmCli, "uninstall", "--global", packageName, "--prefix", prefix],
    { encoding: "utf8", env: environment, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const binDirectory = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  const launcher = path.join(binDirectory, process.platform === "win32" ? "ax.cmd" : "ax");
  assert.equal(existsSync(launcher), false, `Global launcher still exists after uninstall: ${launcher}`);
}

async function createCatalogFixture() {
  const catalogRoot = path.join(root, "catalog");
  const skillDirectory = path.join(catalogRoot, "skills", "test-source", "alpha");
  await mkdir(skillDirectory, { recursive: true });
  await mkdir(path.join(catalogRoot, "packs"), { recursive: true });
  await writeFile(path.join(skillDirectory, "SKILL.md"), "---\nname: alpha\n---\n");
  await writeFile(
    path.join(catalogRoot, "sources.lock.json"),
    `${JSON.stringify({ schemaVersion: 1, sources: [{ id: "test-source", name: "Test Source", repository: "https://github.com/example/test.git", skillRoot: "skills", revision: "a".repeat(40) }] }, null, 2)}\n`,
  );
  await writeFile(
    path.join(catalogRoot, "packs", "common.json"),
    `${JSON.stringify({ schemaVersion: 1, id: "common", name: "Common", sources: [{ source: "test-source", skills: ["alpha"] }] }, null, 2)}\n`,
  );
  await writeFile(
    path.join(catalogRoot, "package.json"),
    `${JSON.stringify({ name: "fixture-catalog", version: "1.0.0", private: true, agentSkills: { packageSpec: "fixture#main" } }, null, 2)}\n`,
  );
  git(catalogRoot, ["init", "--quiet", "-b", "main"]);
  git(catalogRoot, ["add", "-A"]);
  git(catalogRoot, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "--quiet", "-m", "fixture"]);
  return { catalogRoot, revision: git(catalogRoot, ["rev-parse", "HEAD"]) };
}

async function verifySkills(environment) {
  const { catalogRoot, revision } = await createCatalogFixture();
  const skillsEnvironment = {
    ...environment,
    AGENTHOME_CATALOG_SPEC: catalogRoot,
    AGENTHOME_STATE_DIR: stateDirectory,
  };
  const binDirectory = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  const agentLauncher = path.join(binDirectory, process.platform === "win32" ? "agent.cmd" : "agent");
  const installed = runLauncher(agentLauncher, ["skills", "common"], projectRoot, skillsEnvironment);
  assert.match(installed.stdout, /Installation complete/);
  assert.equal(existsSync(path.join(projectRoot, ".claude", "skills", "alpha", "SKILL.md")), true);
  assert.equal(existsSync(path.join(projectRoot, ".agents", "skills", "alpha", "SKILL.md")), true);
  const lock = JSON.parse(await readFile(path.join(projectRoot, ".agent-skills.lock.json"), "utf8"));
  assert.equal(lock.catalog.revision, revision);
}

try {
  assert.ok(npmCli, "npm_execpath is required; run with npm run test:install");
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  };

  // Mode 1: registry equivalent — the published packages/cli tarball.
  const cliArchive = pack(path.join(packageRoot, "packages", "cli"), environment);
  await verifyInstall(cliArchive, environment);
  await uninstall("agenthome-cli", environment);

  // Mode 2: GitHub equivalent — the monorepo root tarball with synced vendor core.
  const rootArchive = pack(packageRoot, environment);
  await verifyInstall(rootArchive, environment);
  await verifySkills(environment);
  await uninstall("agenthome-cli-monorepo", environment);

  console.log("Dual-mode global install, agent runtime, and skills tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
