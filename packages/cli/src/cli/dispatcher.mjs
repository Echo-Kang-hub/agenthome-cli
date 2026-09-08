import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  AGENTS,
  acquireSessionLease,
  agentExecutableAvailable,
  clearLocalAuth,
  deinitializeAgent,
  effectiveAgentConfig,
  getAgent,
  getSessionAdapter,
  initializeAgent,
  loadRuntime,
  locateProjectRoot,
  projectAuthEnvironment,
  sessionLeasePath,
  sessionsGitIgnored,
  setLocalAuth,
  setSessionsGitIgnored,
  spawnExecutableSync,
  validateAuthMode,
  validateSessionsMode,
} from "#core";
import { dispatchCatalog, dispatchSkills } from "./skills-cli.mjs";
import { updateAvenic } from "./self-update.mjs";
import { spawnSessionWatchdog } from "./watchdog.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function launchExecutable(executable, argumentsList, options = {}) {
  const result = spawnExecutableSync(executable, argumentsList, {
    cwd: options.cwd,
    env: options.environment,
    stdio: options.capture ? "pipe" : "inherit",
    windowsHide: Boolean(options.capture),
  });
  if (result.error) {
    throw new Error(`Unable to launch ${executable}: ${result.error.message}`);
  }
  return result.status ?? 1;
}

function takeOption(argumentsList, option) {
  const index = argumentsList.indexOf(option);
  if (index === -1) {
    return undefined;
  }
  const value = argumentsList[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${option}`);
  }
  argumentsList.splice(index, 2);
  return value;
}

export function printHelp(io = console) {
  io.log(`Avenic

CLI: avenic (shorthand: ave)

Agent runtimes:
  avenic <claude|codex|opencode> init [--auth global|project] [--sessions global|project]
  avenic <claude|codex|opencode> deinit [--purge]
  avenic <claude|codex|opencode> auth [global|project|reset]
  avenic <claude|codex|opencode> status
  avenic <claude|codex|opencode> sessions [import|writeback|status]
  avenic <claude|codex|opencode> [official CLI arguments...]
  avenic sessions git [on|off|status]
  avenic status                       Show all three agents
  avenic doctor                       Check the environment

Skills:
  avenic skills install [pack...]     Install or sync Packs (default: common)
  avenic skills [pack...]             Shorthand for skills install
  avenic skills add <owner/repo> [skill...] [-g]    Install directly from a GitHub repo
  avenic skills adopt <skill...> [-g] Adopt existing on-disk Skills into management
  avenic skills remove <skill...>     Remove external, unmanaged Skills
  avenic skills uninstall <pack...>   Remove Packs and unneeded managed Skills
  avenic skills uninstall             Remove all managed Skills
  avenic skills tree [pack...]        Show source -> Skill tree
  avenic skills packs                 List available Packs
  avenic skills status [-g]           Show the installed tree
  -g, --global                        Use the global user scope

Catalog:
  avenic catalog add <spec>           Add a catalog source (owner/repo[#ref], URL, or local path) and preview its Packs
  avenic catalog select [name|spec]   Pick the current catalog from registered ones (↑/↓, Enter)
  avenic catalog list                 List registered catalogs
  avenic catalog sync                 Fetch or update the cached catalog
  avenic catalog default              Show the configured catalog spec
  Private repos use your local git credentials (gh auth login or SSH)
  avenic catalog doctor|update|skill-add|remove|pack-add|pack-remove|source-add
                                      (run inside your catalog Git clone)

Update Avenic:
  avenic self-update
`);
}

function printAgentStatus(agent, projectRoot, state) {
  const config = effectiveAgentConfig(state, agent.id);
  console.log(`${agent.displayName}\n`);
  console.log(`Project             ${projectRoot}`);
  console.log(`Initialized         ${config ? "Yes" : "No"}`);
  if (config) {
    console.log(`Configured auth     ${config.configuredAuth}`);
    console.log(`Local override      ${config.localAuth ?? "None"}`);
    console.log(`Effective auth      ${config.auth}`);
    console.log(`Sessions            ${config.sessions === "global" ? "Global (native)" : "Project (portable)"}`);
  }
  console.log(`Official CLI        ${agentExecutableAvailable(agent.id) ? "Available" : "Not found"}`);
}

async function dispatchAgent(agentId, argumentsList) {
  const agent = getAgent(agentId);
  const projectRoot = locateProjectRoot();
  const [command, ...remainingArguments] = argumentsList;

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }

  if (command === "init") {
    const initArguments = [...remainingArguments];
    const authOption = takeOption(initArguments, "--auth");
    const authMode = authOption ? validateAuthMode(authOption) : undefined;
    const sessionsOption = takeOption(initArguments, "--sessions");
    const sessionsMode = sessionsOption ? validateSessionsMode(sessionsOption) : undefined;
    if (initArguments.length > 0) {
      throw new Error(`Unknown option: ${initArguments[0]}`);
    }
    const result = await initializeAgent(projectRoot, agentId, authMode, sessionsMode);
    console.log("Avenic Runtime\n");
    console.log(`Agent           ${agent.displayName}`);
    console.log(`Project         ${projectRoot}`);
    console.log(`Authentication  ${result.authMode}`);
    console.log(`Sessions        ${result.sessionsMode === "global" ? "Global" : "Project"}`);
    console.log(`Session Git     ${(await sessionsGitIgnored(projectRoot)) ? "Off" : "On"}`);
    console.log(`Configuration   ${result.configChanged ? "Updated" : "Unchanged"}`);
    console.log(`Git ignore      ${result.gitignoreChanged ? "Updated" : "Unchanged"}`);
    console.log(`Structure       ${result.structureRepaired ? "Repaired" : "Intact"}`);
    const changedSomething = result.configChanged || result.gitignoreChanged || result.structureRepaired;
    console.log(changedSomething ? "\nChanged:" : "\nAlready up to date — nothing changed.");
    if (result.configChanged) {
      console.log("  .agents/runtime.json          Runtime config (agent, auth, sessions)");
    }
    if (result.gitignoreChanged) {
      console.log("  .gitignore                    Added ignore rules for .agents/ and .claude/skills/");
    }
    if (result.structureRepaired) {
      console.log(`  .agents/sessions/${agentId}/       Portable sessions (in Git by default)`);
      if (result.authMode === "project") {
        console.log(`  .agents/local/${agentId}/          Project credentials (gitignored)`);
      }
    }
    console.log(`\nUsage:
  avenic ${agentId}              Launch ${agent.displayName}
  avenic ${agentId} status       Show configuration
  avenic ${agentId} deinit       Undo init (--purge also deletes data)
  avenic ${agentId} auth         Switch global/project authentication\n`);
    console.log(
      "Project sessions may contain prompts, source code, command output, file paths, and secrets. Only commit sessions to repositories you trust.\n",
    );
    return 0;
  }

  if (command === "deinit") {
    const purge = remainingArguments.includes("--purge");
    const unknown = remainingArguments.find((argument) => argument !== "--purge");
    if (unknown) {
      throw new Error(`Unknown option: ${unknown}`);
    }
    const result = await deinitializeAgent(projectRoot, agentId, { purge });
    console.log(`${agent.displayName} deinitialization\n`);
    console.log(`Project   ${projectRoot}`);
    console.log(`Runtime   ${result.changed ? "Removed" : "Already absent"}`);
    console.log(`Data      ${result.purged ? "Purged" : "Preserved"}`);
    console.log(`Agents    ${result.remaining} remaining`);
    if (!purge) {
      console.log(`\nReinitialize later without losing portable sessions:\n  avenic ${agentId} init`);
    }
    return 0;
  }

  if (command === "auth") {
    if (remainingArguments.length === 0) {
      printAgentStatus(agent, projectRoot, await loadRuntime(projectRoot));
      return 0;
    }
    if (remainingArguments.length !== 1) {
      throw new Error(`Usage: avenic ${agentId} auth [global|project|reset]`);
    }
    const mode = remainingArguments[0];
    const config = mode === "reset"
      ? await clearLocalAuth(projectRoot, agentId)
      : await setLocalAuth(projectRoot, agentId, mode);
    console.log(`${agent.displayName} authentication\n`);
    console.log(`Configured default  ${config.configuredAuth}`);
    console.log(`Local override      ${config.localAuth ?? "None"}`);
    console.log(`Effective           ${config.auth}`);
    return 0;
  }

  if (command === "status") {
    printAgentStatus(agent, projectRoot, await loadRuntime(projectRoot));
    return 0;
  }

  if (command === "sessions") {
    const state = await loadRuntime(projectRoot);
    if (!effectiveAgentConfig(state, agentId)) {
      throw new Error(`${agent.displayName} is not initialized. Run: avenic ${agentId} init`);
    }
    const action = remainingArguments[0] ?? "status";
    if (remainingArguments.length > 1 || !["import", "writeback", "status"].includes(action)) {
      throw new Error(`Usage: avenic ${agentId} sessions [import|writeback|status]`);
    }
    const adapter = getSessionAdapter(agentId);
    if (action === "status") {
      const result = await adapter.status(projectRoot);
      console.log(`${agent.displayName} portable sessions\n\nProject  ${projectRoot}\nSessions ${result.count}`);
      return 0;
    }
    const result = action === "import" ? await adapter.capture(projectRoot) : await adapter.restore(projectRoot);
    console.log(`${agent.displayName} session ${action}\n`);
    console.log(`Project   ${projectRoot}`);
    console.log(`Sessions  ${result.count}`);
    console.log(action === "import" ? `Portable  ${result.changed ? "Updated" : "Unchanged"}` : `Written back  ${result.added + result.updated}`);
    if (result.conflicts > 0) {
      console.log(`Conflicts ${result.conflicts} (project sessions overwrote native storage)`);
    }
    return 0;
  }

  const state = await loadRuntime(projectRoot);
  const config = effectiveAgentConfig(state, agentId);
  if (!config) {
    throw new Error(`${agent.displayName} is not initialized. Run: avenic ${agentId} init`);
  }
  const environment = config.auth === "project"
    ? { ...process.env, ...projectAuthEnvironment(agentId, projectRoot) }
    : process.env;
  const adapter = getSessionAdapter(agentId);
  const portableSessions = config.sessions !== "global";
  // Sessions created during a run live only in the project: the first launch
  // of a project+agent group snapshots the native storage and the last exit
  // reverts it. Launches of the same project+agent may run concurrently.
  // opencode's storage is managed by the official CLI, so it captures without
  // snapshotting or reverting.
  const isolatesNative = typeof adapter.snapshotNative === "function"
    && typeof adapter.revertNative === "function";
  let leaveLaunchGroup = null;
  if (portableSessions && isolatesNative) {
    const snapshotRoot = path.join(sessionLeasePath(agentId, projectRoot), "snapshot");
    const lease = await acquireSessionLease(agentId, projectRoot, {
      onFirst: async (recovering) => {
        if (recovering) {
          // A previous launch group died without exiting: move its sessions
          // into the project and restore the pre-launch native state first.
          await adapter.capture(projectRoot, { environment });
          await adapter.revertNative(snapshotRoot, projectRoot, { environment });
        }
        await adapter.snapshotNative(projectRoot, snapshotRoot, { environment });
      },
      onLast: async () => {
        await adapter.revertNative(snapshotRoot, projectRoot, { environment });
      },
    });
    leaveLaunchGroup = lease.release;
    try {
      await spawnSessionWatchdog(agentId, projectRoot, lease.member, environment);
    } catch {}
  }
  if (portableSessions) {
    // Project session records take priority on launch: conflicting native
    // copies are overwritten silently. Native storage is never written to
    // proactively; only `avenic <agent> sessions writeback` writes
    // project records back to native storage.
    try {
      await adapter.restore(projectRoot, { environment });
    } catch (error) {
      if (leaveLaunchGroup) {
        // Leaving the group reverts native storage when this was the only
        // launch in it.
        try {
          await leaveLaunchGroup();
        } catch {}
      }
      throw error;
    }
  }
  let status;
  try {
    status = launchExecutable(agent.executable, argumentsList, { cwd: projectRoot, environment });
  } finally {
    if (portableSessions) {
      try {
        await adapter.capture(projectRoot, { environment });
      } finally {
        if (leaveLaunchGroup) {
          await leaveLaunchGroup();
        }
      }
    }
  }
  return status;
}

async function dispatchStatus() {
  const projectRoot = locateProjectRoot();
  const state = await loadRuntime(projectRoot);
  console.log("Avenic Status\n");
  console.log(`Project  ${projectRoot}\n`);
  for (const agentId of Object.keys(AGENTS)) {
    const agent = getAgent(agentId);
    const config = effectiveAgentConfig(state, agentId);
    console.log(`${agent.displayName.padEnd(12)} ${config ? `Initialized (${config.auth} auth)` : "Not initialized"}`);
  }
  return 0;
}

async function dispatchDoctor() {
  const projectRoot = locateProjectRoot();
  const state = await loadRuntime(projectRoot);
  console.log("Avenic Doctor\n");
  console.log(`Project root       OK  ${projectRoot}`);
  console.log(`Runtime config     ${state.runtime.agents ? "OK" : "ERROR"}`);
  for (const agentId of Object.keys(AGENTS)) {
    const agent = getAgent(agentId);
    console.log(`${agent.displayName.padEnd(18)} ${agentExecutableAvailable(agent.id) ? "OK" : "NOT FOUND"}`);
  }
  return 0;
}

function untrackSessions(projectRoot) {
  const tracked = spawnExecutableSync("git", ["ls-files", "--", ".agents/sessions"], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (tracked.status !== 0 || !tracked.stdout.trim()) return 0;
  const files = tracked.stdout.trim().split(/\r?\n/).filter(Boolean);
  const result = spawnExecutableSync(
    "git",
    ["rm", "-r", "--cached", "--force", "--ignore-unmatch", "--", ".agents/sessions"],
    { cwd: projectRoot, stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error("Unable to remove sessions from the Git index");
  return files.length;
}

async function dispatchSessions(argumentsList) {
  const [command, mode = "status", ...extra] = argumentsList;
  if (command !== "git" || extra.length > 0 || !["on", "off", "status"].includes(mode)) {
    throw new Error("Usage: avenic sessions git [on|off|status]");
  }
  const projectRoot = locateProjectRoot();
  if (mode === "off") {
    const changed = await setSessionsGitIgnored(projectRoot, true);
    const untracked = untrackSessions(projectRoot);
    console.log("Session Git sync\n");
    console.log(`Project    ${projectRoot}`);
    console.log("Status     Off");
    console.log(`Git ignore ${changed ? "Updated" : "Unchanged"}`);
    console.log(`Untracked  ${untracked}`);
    return 0;
  }
  if (mode === "on") {
    const changed = await setSessionsGitIgnored(projectRoot, false);
    console.log("Session Git sync\n");
    console.log(`Project    ${projectRoot}`);
    console.log("Status     On");
    console.log(`Git ignore ${changed ? "Updated" : "Unchanged"}`);
    return 0;
  }
  console.log(`Session Git sync: ${(await sessionsGitIgnored(projectRoot)) ? "Off" : "On"}`);
  return 0;
}

async function dispatchSkillsCommand(argumentsList) {
  return dispatchSkills(argumentsList, {
    io: console,
    cwd: process.cwd(),
    environment: process.env,
  });
}

export async function runCli(options = {}) {
  const argumentsList = options.argumentsList ?? process.argv.slice(2);
  const forcedAgent = options.forcedAgent;
  if (forcedAgent) {
    return dispatchAgent(forcedAgent, argumentsList);
  }
  const [command, ...remainingArguments] = argumentsList;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }
  if (Object.hasOwn(AGENTS, command)) {
    return dispatchAgent(command, remainingArguments);
  }
  if (command === "skills") {
    return dispatchSkillsCommand(remainingArguments);
  }
  if (command === "catalog") {
    return dispatchCatalog(remainingArguments, {
      io: console,
      cwd: process.cwd(),
      environment: process.env,
    });
  }
  if (command === "sessions") {
    return dispatchSessions(remainingArguments);
  }
  if (command === "update") {
    if (remainingArguments.length > 0) {
      throw new Error("Usage: avenic self-update");
    }
    await updateAvenic(packageRoot);
    return 0;
  }
  if (command === "status") {
    return dispatchStatus();
  }
  if (command === "doctor") {
    return dispatchDoctor();
  }
  // Anything left is either a legacy top-level command (add, self-update,
  // uninstall, packs, tree, ...) or a Pack id. Pack ids are user-defined, so
  // the catalog is the only source of truth for telling Packs from typos;
  // delegate to the skills dispatcher, which resolves known commands locally
  // before any catalog work.
  return dispatchSkills(argumentsList, {
    io: console,
    cwd: process.cwd(),
    environment: process.env,
  });
}
