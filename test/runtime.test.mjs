import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  clearLocalAuth,
  deinitializeAgent,
  effectiveAgentConfig,
  initializeAgent,
  loadRuntime,
  projectAuthEnvironment,
  setLocalAuth,
} from "../packages/core/src/runtime/config.mjs";
import {
  REQUIRED_RULES,
  SESSIONS_RULE,
  ensureRuntimeGitignore,
  sessionsGitIgnored,
} from "../packages/core/src/runtime/gitignore.mjs";
import { locateProjectRoot } from "../packages/core/src/runtime/project-root.mjs";
import * as claudeSessions from "../packages/core/src/runtime/adapters/claude.mjs";
import * as codexSessions from "../packages/core/src/runtime/adapters/codex.mjs";
import * as opencodeSessions from "../packages/core/src/runtime/adapters/opencode.mjs";
import { agentHomePackageSpec, updateAgentHome } from "../packages/cli/src/cli/self-update.mjs";
import { PROJECT_ROOT_TOKEN, listFiles } from "../packages/core/src/runtime/sessions.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPackageRoot = path.join(packageRoot, "packages", "cli");

function runCli(projectRoot, entry, argumentsList, environment) {
  return spawnSync(process.execPath, [path.join(packageRoot, "packages", "cli", entry === "agenthome.mjs" ? "scripts" : "bin", entry === "agenthome.mjs" ? "skills.mjs" : entry), ...argumentsList], {
    cwd: projectRoot,
    encoding: "utf8",
    env: environment ?? process.env,
    windowsHide: true,
  });
}

async function fakeAgentBinary(projectRoot, agentId) {
  const binDirectory = path.join(projectRoot, "bin");
  await mkdir(binDirectory, { recursive: true });
  const windows = process.platform === "win32";
  // On Windows the runtime resolves executables through PowerShell for .ps1
  // shims; spawnSync cannot launch .cmd files directly (EINVAL).
  const script = windows
    ? "@\"\nCLAUDE_CONFIG_DIR=$env:CLAUDE_CONFIG_DIR\nCODEX_HOME=$env:CODEX_HOME\nXDG_CONFIG_HOME=$env:XDG_CONFIG_HOME\n\"@ | Set-Content -Path $env:OUT_FILE\n"
    : `#!/bin/sh\n{\n  echo "CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR"\n  echo "CODEX_HOME=$CODEX_HOME"\n  echo "XDG_CONFIG_HOME=$XDG_CONFIG_HOME"\n} > "$OUT_FILE"\nexit 0\n`;
  const executable = path.join(binDirectory, windows ? `${agentId}.ps1` : agentId);
  await writeFile(executable, script);
  if (!windows) {
    const { chmod } = await import("node:fs/promises");
    await chmod(executable, 0o755);
  }
  return binDirectory;
}

async function withTempProject(run) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-test-"));
  try {
    await run(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

test("initialization is incremental and idempotent", async () => {
  await withTempProject(async (projectRoot) => {
    await initializeAgent(projectRoot, "claude", "project");
    await initializeAgent(projectRoot, "codex", "global");
    const repeated = await initializeAgent(projectRoot, "claude");
    const state = await loadRuntime(projectRoot);

    assert.equal(repeated.configChanged, false);
    assert.equal(state.runtime.agents.claude.auth, "project");
    assert.equal(state.runtime.agents.codex.auth, "global");
    assert.equal(state.runtime.agents.claude.sessions, "project");
    assert.equal(existsSync(path.join(projectRoot, ".agents", "local", "claude")), true);
    assert.equal(existsSync(path.join(projectRoot, ".agents", "local", "codex")), false);
  });
});

test("local authentication overrides project defaults", async () => {
  await withTempProject(async (projectRoot) => {
    await initializeAgent(projectRoot, "claude", "global");
    await setLocalAuth(projectRoot, "claude", "project");
    const state = await loadRuntime(projectRoot);
    const effective = effectiveAgentConfig(state, "claude");

    assert.equal(effective.configuredAuth, "global");
    assert.equal(effective.localAuth, "project");
    assert.equal(effective.auth, "project");

    const reset = await clearLocalAuth(projectRoot, "claude");
    assert.equal(reset.localAuth, null);
    assert.equal(reset.auth, "global");
  });
});

test("global initialization does not create a credential directory", async () => {
  await withTempProject(async (projectRoot) => {
    await initializeAgent(projectRoot, "codex", "global");
    assert.equal(existsSync(path.join(projectRoot, ".agents", "local")), false);
    assert.equal(existsSync(path.join(projectRoot, ".agents", "sessions", "codex")), true);
  });
});

test("deinitialization is reversible and purge is explicit", async () => {
  await withTempProject(async (projectRoot) => {
    await initializeAgent(projectRoot, "codex", "project");
    const sessionFile = path.join(projectRoot, ".agents", "sessions", "codex", "session.jsonl");
    const credentialFile = path.join(projectRoot, ".agents", "local", "codex", "auth.json");
    await writeFile(sessionFile, "session\n");
    await writeFile(credentialFile, "credential\n");

    const removed = await deinitializeAgent(projectRoot, "codex");
    assert.equal(removed.changed, true);
    assert.equal(existsSync(sessionFile), true);
    assert.equal(existsSync(credentialFile), true);
    assert.equal(effectiveAgentConfig(await loadRuntime(projectRoot), "codex"), null);

    await initializeAgent(projectRoot, "codex", "project");
    const purged = await deinitializeAgent(projectRoot, "codex", { purge: true });
    assert.equal(purged.purged, true);
    assert.equal(existsSync(path.dirname(sessionFile)), false);
    assert.equal(existsSync(path.dirname(credentialFile)), false);
    const gitignore = await readFile(path.join(projectRoot, ".gitignore"), "utf8");
    assert.doesNotMatch(gitignore, /\.agents\/local\//);
    assert.doesNotMatch(gitignore, /\.agents\/tmp\//);

    const repeated = await deinitializeAgent(projectRoot, "codex", { purge: true });
    assert.equal(repeated.changed, false);
  });
});

test("gitignore rules are added once", async () => {
  await withTempProject(async (projectRoot) => {
    assert.equal(await ensureRuntimeGitignore(projectRoot), true);
    assert.equal(await ensureRuntimeGitignore(projectRoot), false);
    const content = await readFile(path.join(projectRoot, ".gitignore"), "utf8");
    for (const rule of REQUIRED_RULES) {
      assert.equal(content.split(rule).length - 1, 1);
    }
  });
});

test("session Git sync can be disabled without deleting sessions", async () => {
  await withTempProject(async (projectRoot) => {
    spawnSync("git", ["init", "--quiet"], { cwd: projectRoot });
    await initializeAgent(projectRoot, "codex", "global");
    const sessionFile = path.join(projectRoot, ".agents", "sessions", "codex", "session.jsonl");
    await writeFile(sessionFile, "session\n");
    spawnSync("git", ["add", "--force", ".agents/sessions"], { cwd: projectRoot });

    const disabled = runCli(projectRoot, "agenthome.mjs", ["sessions", "git", "off"]);
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.equal(await sessionsGitIgnored(projectRoot), true);
    assert.equal(existsSync(sessionFile), true);
    const tracked = spawnSync("git", ["ls-files", "--", ".agents/sessions"], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    assert.equal(tracked.stdout.trim(), "");
    assert.match(await readFile(path.join(projectRoot, ".gitignore"), "utf8"), new RegExp(SESSIONS_RULE.replaceAll("/", "\\/")));

    const repeated = runCli(projectRoot, "agenthome.mjs", ["sessions", "git", "off"]);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.match(repeated.stdout, /Git ignore Unchanged/);
  });
});

test("project root falls back to runtime markers", async () => {
  await withTempProject(async (projectRoot) => {
    await mkdir(path.join(projectRoot, "src", "nested"), { recursive: true });
    await initializeAgent(projectRoot, "opencode", "global");
    assert.equal(locateProjectRoot(path.join(projectRoot, "src", "nested")), projectRoot);
  });
});

test("full and short commands share one runtime configuration", async () => {
  await withTempProject(async (projectRoot) => {
    const full = runCli(projectRoot, "agenthome.mjs", ["claude", "init", "--auth", "global"]);
    const short = runCli(projectRoot, "agenthome.mjs", ["codex", "init", "--auth", "project"]);
    const status = runCli(projectRoot, "agenthome.mjs", ["claude", "status"]);

    assert.equal(full.status, 0, full.stderr);
    assert.equal(short.status, 0, short.stderr);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Claude Code/);
    const state = await loadRuntime(projectRoot);
    assert.equal(state.runtime.agents.claude.auth, "global");
    assert.equal(state.runtime.agents.codex.auth, "project");
  });
});

test("repeated init is a no-op when the project structure is intact", async () => {
  await withTempProject(async (projectRoot) => {
    const first = runCli(projectRoot, "agenthome.mjs", ["claude", "init", "--auth", "project"]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Configuration   Updated/);

    const runtimeFile = path.join(projectRoot, ".agents", "runtime.json");
    const gitignoreFile = path.join(projectRoot, ".gitignore");
    const runtimeBefore = await readFile(runtimeFile, "utf8");
    const gitignoreBefore = await readFile(gitignoreFile, "utf8");

    const second = runCli(projectRoot, "agenthome.mjs", ["claude", "init"]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Configuration   Unchanged/);
    assert.match(second.stdout, /Git ignore      Unchanged/);
    assert.match(second.stdout, /Structure       Intact/);
    assert.match(second.stdout, /Already up to date/);
    assert.equal(await readFile(runtimeFile, "utf8"), runtimeBefore);
    assert.equal(await readFile(gitignoreFile, "utf8"), gitignoreBefore);
    assert.match(second.stdout, /Authentication  project/);
    assert.match(second.stdout, /Sessions        Project/);
  });
});

test("init incrementally repairs missing directories without touching existing state", async () => {
  await withTempProject(async (projectRoot) => {
    const first = runCli(projectRoot, "agenthome.mjs", ["claude", "init", "--auth", "project"]);
    assert.equal(first.status, 0, first.stderr);

    const sessionsDir = path.join(projectRoot, ".agents", "sessions", "claude");
    const localDir = path.join(projectRoot, ".agents", "local", "claude");
    await rm(sessionsDir, { recursive: true, force: true });
    await rm(localDir, { recursive: true, force: true });
    assert.equal(existsSync(sessionsDir), false);
    assert.equal(existsSync(localDir), false);

    const runtimeFile = path.join(projectRoot, ".agents", "runtime.json");
    const gitignoreFile = path.join(projectRoot, ".gitignore");
    const runtimeBefore = await readFile(runtimeFile, "utf8");
    const gitignoreBefore = await readFile(gitignoreFile, "utf8");

    const repaired = runCli(projectRoot, "agenthome.mjs", ["claude", "init"]);
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.equal(existsSync(sessionsDir), true);
    assert.equal(existsSync(localDir), true);
    assert.equal(await readFile(runtimeFile, "utf8"), runtimeBefore);
    assert.equal(await readFile(gitignoreFile, "utf8"), gitignoreBefore);
    assert.match(repaired.stdout, /Configuration   Unchanged/);
    assert.match(repaired.stdout, /Git ignore      Unchanged/);
    assert.match(repaired.stdout, /Structure       Repaired/);
    assert.doesNotMatch(repaired.stdout, /Already up to date/);
  });
});

test("init reports the created structure and how to use it", async () => {
  await withTempProject(async (projectRoot) => {
    const first = runCli(projectRoot, "agenthome.mjs", ["claude", "init", "--auth", "project"]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Changed:/);
    assert.match(first.stdout, /\.agents\/runtime\.json/);
    assert.match(first.stdout, /\.gitignore/);
    assert.match(first.stdout, /\.agents\/sessions\/claude/);
    assert.match(first.stdout, /\.agents\/local\/claude/);
    assert.match(first.stdout, /agenthome claude deinit/);
    assert.doesNotMatch(first.stdout, /Already up to date/);
  });
});

test("init is fully decoupled from the catalog and network", async () => {
  await withTempProject(async (projectRoot) => {
    // Point PATH/Path at an empty directory: if init ever invoked git (or any
    // other tool) the call would fail with ENOENT, and a catalog fetch would
    // raise an SSL/authentication error. Init must never touch either.
    const emptyBin = path.join(projectRoot, "empty-bin");
    await mkdir(emptyBin);
    const environment = { ...process.env, PATH: emptyBin, Path: emptyBin };
    const init = runCli(projectRoot, "agenthome.mjs", ["claude", "init", "--auth", "project"], environment);
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /Changed:/);
    assert.doesNotMatch(`${init.stdout}${init.stderr}`, /catalog|Unable to fetch|git failed/i);
  });
});

test("help works from the main and agent positions", async () => {
  await withTempProject(async (projectRoot) => {
    const main = runCli(projectRoot, "agenthome.mjs", ["--help"]);
    assert.equal(main.status, 0, main.stderr);
    assert.match(main.stdout, /agenthome <claude\|codex\|opencode> init/);
    assert.match(main.stdout, /shorthand: ah/);
    assert.match(main.stdout, /self-update/);
    const agent = runCli(projectRoot, "agenthome.mjs", ["claude", "--help"]);
    assert.equal(agent.status, 0, agent.stderr);
    assert.match(agent.stdout, /Agent runtimes/);
  });
});

test("Claude sessions import and restore across project paths", async () => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-source-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-target-"));
  const claudeHome = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-claude-"));
  try {
    await initializeAgent(sourceRoot, "claude", "global");
    const sourceNative = path.join(claudeHome, "projects", claudeSessions.claudeProjectKey(sourceRoot));
    await mkdir(sourceNative, { recursive: true });
    await writeFile(
      path.join(sourceNative, "session.jsonl"),
      `${JSON.stringify({ type: "user", cwd: sourceRoot, sessionId: "session" })}\n`,
    );
    const imported = await claudeSessions.capture(sourceRoot, { environment: { CLAUDE_CONFIG_DIR: claudeHome } });
    assert.equal(imported.count, 1);

    await mkdir(path.join(targetRoot, ".agents", "sessions"), { recursive: true });
    await cp(
      path.join(sourceRoot, ".agents", "sessions", "claude"),
      path.join(targetRoot, ".agents", "sessions", "claude"),
      { recursive: true },
    );
    const restored = await claudeSessions.restore(targetRoot, { environment: { CLAUDE_CONFIG_DIR: claudeHome } });
    assert.equal(restored.added, 1);
    const restoredFile = path.join(claudeHome, "projects", claudeSessions.claudeProjectKey(targetRoot), "session.jsonl");
    assert.equal(JSON.parse((await readFile(restoredFile, "utf8")).trim()).cwd, targetRoot);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
    await rm(claudeHome, { recursive: true, force: true });
  }
});

test("Codex sessions only import the current project", async () => {
  await withTempProject(async (projectRoot) => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-codex-"));
    try {
      await initializeAgent(projectRoot, "codex", "global");
      const sessionRoot = path.join(codexHome, "sessions", "2026", "09", "05");
      await mkdir(sessionRoot, { recursive: true });
      await writeFile(
        path.join(sessionRoot, "matching.jsonl"),
        `${JSON.stringify({ type: "session_meta", payload: { id: "matching", cwd: projectRoot } })}\n`,
      );
      await writeFile(
        path.join(sessionRoot, "other.jsonl"),
        `${JSON.stringify({ type: "session_meta", payload: { id: "other", cwd: path.dirname(projectRoot) } })}\n`,
      );
      await writeFile(
        path.join(codexHome, "session_index.jsonl"),
        `${JSON.stringify({ id: "matching", thread_name: "Matching" })}\n${JSON.stringify({ id: "other", thread_name: "Other" })}\n`,
      );
      const result = await codexSessions.capture(projectRoot, { environment: { CODEX_HOME: codexHome } });
      assert.equal(result.count, 1);
      assert.equal((await codexSessions.status(projectRoot)).count, 1);
      const portableIndex = await readFile(path.join(projectRoot, ".agents", "sessions", "codex", "session_index.jsonl"), "utf8");
      assert.match(portableIndex, /matching/);
      assert.doesNotMatch(portableIndex, /other/);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});

test("Codex sessions restore into a new project path", async () => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-source-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-target-"));
  const sourceHome = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-codex-source-"));
  const targetHome = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-codex-target-"));
  try {
    const sourceSession = path.join(sourceHome, "sessions", "2026", "09", "05");
    await mkdir(sourceSession, { recursive: true });
    await writeFile(
      path.join(sourceSession, "session.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { id: "portable", cwd: sourceRoot } })}\n`,
    );
    await codexSessions.capture(sourceRoot, { environment: { CODEX_HOME: sourceHome } });
    await mkdir(path.join(targetRoot, ".agents", "sessions"), { recursive: true });
    await cp(
      path.join(sourceRoot, ".agents", "sessions", "codex"),
      path.join(targetRoot, ".agents", "sessions", "codex"),
      { recursive: true },
    );
    const restored = await codexSessions.restore(targetRoot, { environment: { CODEX_HOME: targetHome } });
    assert.equal(restored.added, 1);
    const file = path.join(targetHome, "sessions", "2026", "09", "05", "session.jsonl");
    assert.equal(JSON.parse((await readFile(file, "utf8")).trim()).payload.cwd, targetRoot);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
    await rm(sourceHome, { recursive: true, force: true });
    await rm(targetHome, { recursive: true, force: true });
  }
});

test("Codex restore keeps divergent local sessions", async () => {
  await withTempProject(async (projectRoot) => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-codex-conflict-"));
    try {
      const relative = path.join("2026", "09", "05", "session.jsonl");
      const nativeFile = path.join(codexHome, "sessions", relative);
      const portableFile = path.join(projectRoot, ".agents", "sessions", "codex", "sessions", relative);
      await mkdir(path.dirname(nativeFile), { recursive: true });
      await mkdir(path.dirname(portableFile), { recursive: true });
      await writeFile(
        nativeFile,
        `${JSON.stringify({ type: "session_meta", payload: { id: "same", cwd: projectRoot } })}\nlocal\n`,
      );
      await writeFile(
        portableFile,
        `${JSON.stringify({ type: "session_meta", payload: { id: "same", cwd: PROJECT_ROOT_TOKEN } })}\nportable\n`,
      );

      const result = await codexSessions.restore(projectRoot, { environment: { CODEX_HOME: codexHome } });
      assert.equal(result.conflicts, 1);
      assert.match(await readFile(nativeFile, "utf8"), /local/);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});

test("OpenCode uses native export and imports each portable version once", async () => {
  await withTempProject(async (projectRoot) => {
    const calls = [];
    const spawn = (_command, argumentsList) => {
      calls.push(argumentsList);
      if (argumentsList[0] === "session") {
        return { status: 0, stdout: JSON.stringify([{ id: "session", directory: projectRoot }]), stderr: "" };
      }
      if (argumentsList[0] === "export") {
        return { status: 0, stdout: JSON.stringify({ info: { id: "session" }, messages: [] }), stderr: "" };
      }
      return { status: 0, stdout: "Imported session: session\n", stderr: "" };
    };
    await opencodeSessions.capture(projectRoot, { spawn });
    const first = await opencodeSessions.restore(projectRoot, { spawn });
    const second = await opencodeSessions.restore(projectRoot, { spawn });
    assert.equal(first.added, 1);
    assert.equal(second.unchanged, 1);
    assert.equal(calls.filter((argumentsList) => argumentsList[0] === "import").length, 1);
  });
});

test("sessions location is selectable per agent", async () => {
  await withTempProject(async (projectRoot) => {
    await initializeAgent(projectRoot, "codex", "global", "global");
    assert.equal((await loadRuntime(projectRoot)).runtime.agents.codex.sessions, "global");
    await initializeAgent(projectRoot, "codex", undefined, "project");
    assert.equal((await loadRuntime(projectRoot)).runtime.agents.codex.sessions, "project");
    await assert.rejects(
      initializeAgent(projectRoot, "codex", undefined, "machine"),
      /Sessions must be global or project/,
    );
  });
});

test("project auth maps each agent to a project-local config home", async () => {
  await withTempProject(async (projectRoot) => {
    const local = path.join(projectRoot, ".agents", "local");
    assert.deepEqual(projectAuthEnvironment("claude", projectRoot), { CLAUDE_CONFIG_DIR: path.join(local, "claude") });
    assert.deepEqual(projectAuthEnvironment("codex", projectRoot), { CODEX_HOME: path.join(local, "codex") });
    assert.deepEqual(projectAuthEnvironment("opencode", projectRoot), { XDG_CONFIG_HOME: path.join(local, "opencode") });
  });
});

test("project auth launches the agent with a project-scoped config home", async () => {
  await withTempProject(async (projectRoot) => {
    const binDirectory = await fakeAgentBinary(projectRoot, "claude");
    const outFile = path.join(projectRoot, "launch.txt");
    const environment = {
      ...process.env,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH}`,
      OUT_FILE: outFile,
    };
    const initialized = runCli(projectRoot, "agenthome.mjs", ["claude", "init", "--auth", "project"], environment);
    assert.equal(initialized.status, 0, initialized.stderr);
    const launched = runCli(projectRoot, "agenthome.mjs", ["claude", "-p", "hello"], environment);
    assert.equal(launched.status, 0, launched.stderr);
    const output = await readFile(outFile, "utf8");
    const expected = path.join(projectRoot, ".agents", "local", "claude");
    assert.match(output, new RegExp(`CLAUDE_CONFIG_DIR=${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });
});

test("global sessions leave native storage untouched on launch", async () => {
  await withTempProject(async (projectRoot) => {
    const binDirectory = await fakeAgentBinary(projectRoot, "codex");
    const codexHome = path.join(projectRoot, "codex-home");
    const sessionDirectory = path.join(codexHome, "sessions", "2026", "09", "06");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(
      path.join(sessionDirectory, "rollout-1.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { id: "sess-1", cwd: projectRoot } })}\n`,
    );
    const environment = {
      ...process.env,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH}`,
      CODEX_HOME: codexHome,
      OUT_FILE: path.join(projectRoot, "launch.txt"),
    };
    const initialized = runCli(projectRoot, "agenthome.mjs", ["codex", "init", "--sessions", "global"], environment);
    assert.equal(initialized.status, 0, initialized.stderr);
    const launched = runCli(projectRoot, "agenthome.mjs", ["codex", "exec"], environment);
    assert.equal(launched.status, 0, launched.stderr);
    const portable = path.join(projectRoot, ".agents", "sessions", "codex");
    assert.equal((await listFiles(portable)).length, 0, "global sessions must not create portable copies");

    // Switching back to project sessions restores the portable sync on launch.
    runCli(projectRoot, "agenthome.mjs", ["codex", "init", "--sessions", "project"], environment);
    runCli(projectRoot, "agenthome.mjs", ["codex", "exec"], environment);
    assert.ok((await listFiles(portable)).length > 0, "project sessions must capture native sessions");
  });
});

test("self update reinstalls the published npm package globally", async () => {
  const calls = [];
  const packageSpec = await agentHomePackageSpec(cliPackageRoot);
  const result = await updateAgentHome(cliPackageRoot, {
    spawn(executable, argumentsList) {
      calls.push({ executable, argumentsList });
      return { status: 0 };
    },
  });

  assert.equal(result, "agenthome-cli@latest");
  assert.equal(packageSpec, result);
  assert.deepEqual(calls, [
    {
      executable: "npm",
      argumentsList: ["install", "--global", "agenthome-cli@latest"],
    },
  ]);
});
