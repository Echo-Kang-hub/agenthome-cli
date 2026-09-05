import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  AGENTS,
  clearLocalAuth,
  deinitializeAgent,
  effectiveAgentConfig,
  getAgent,
  getSessionAdapter,
  initializeAgent,
  loadRuntime,
  locateProjectRoot,
  sessionsGitIgnored,
  setLocalAuth,
  setSessionsGitIgnored,
  spawnExecutableSync,
  validateAuthMode,
} from "#core";
import { dispatchCatalog } from "./skills-cli.mjs";
import { updateAgentHome } from "./self-update.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function launchExecutable(executable, argumentsList, options = {}) {
  const result = spawnExecutableSync(executable, argumentsList, {
    cwd: options.cwd,
    stdio: options.capture ? "pipe" : "inherit",
    windowsHide: Boolean(options.capture),
  });
  if (result.error) {
    throw new Error(`Unable to launch ${executable}: ${result.error.message}`);
  }
  return result.status ?? 1;
}

function executableAvailable(executable) {
  try {
    return launchExecutable(executable, ["--version"], { capture: true }) === 0;
  } catch {
    return false;
  }
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

function printHelp() {
  console.log(`AgentHome

Usage:
  agent <claude|codex|opencode> init [--auth global|project]
  agent <claude|codex|opencode> deinit [--purge]
  agent <claude|codex|opencode> auth [global|project|reset]
  agent <claude|codex|opencode> status
  agent <claude|codex|opencode> sessions [import|restore|status]
  agent <claude|codex|opencode> [official CLI arguments...]
  agent skills [pack...]
  agent skills add <owner/repo> [skill...] [-g]
  agent catalog <sync|use|default|doctor|update|add|remove|pack-add|pack-remove|source-add>
  agent sessions git [on|off|status]
  agent update
  agent status
  agent doctor

Aliases:
  ac    agent claude
  ax    agent codex
  ao    agent opencode
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
    console.log(`Sessions            ${config.sessions ?? "project"}`);
  }
  console.log(`Official CLI        ${executableAvailable(agent.executable) ? "Available" : "Not found"}`);
}

async function dispatchAgent(agentId, argumentsList) {
  const agent = getAgent(agentId);
  const projectRoot = locateProjectRoot();
  const [command, ...remainingArguments] = argumentsList;

  if (command === "init") {
    const initArguments = [...remainingArguments];
    const authOption = takeOption(initArguments, "--auth");
    const authMode = authOption ? validateAuthMode(authOption) : undefined;
    if (initArguments.length > 0) {
      throw new Error(`Unknown option: ${initArguments[0]}`);
    }
    const result = await initializeAgent(projectRoot, agentId, authMode);
    console.log("AgentHome Runtime\n");
    console.log(`Agent           ${agent.displayName}`);
    console.log(`Project         ${projectRoot}`);
    console.log(`Authentication  ${result.authMode}`);
    console.log("Sessions        Project");
    console.log(`Session Git     ${(await sessionsGitIgnored(projectRoot)) ? "Off" : "On"}`);
    console.log(`Configuration   ${result.configChanged ? "Updated" : "Unchanged"}`);
    console.log(`Git ignore      ${result.gitignoreChanged ? "Updated" : "Unchanged"}`);
    console.log("\nInitialized successfully.\n");
    console.log(
      "Project sessions may contain prompts, source code, command output, file paths, and secrets. Only commit sessions to repositories you trust.\n",
    );
    console.log(`Run:\n  ${agentId === "claude" ? "ac" : agentId === "codex" ? "ax" : "ao"}`);
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
      console.log(`\nReinitialize later without losing portable sessions:\n  agent ${agentId} init`);
    }
    return 0;
  }

  if (command === "auth") {
    if (remainingArguments.length === 0) {
      printAgentStatus(agent, projectRoot, await loadRuntime(projectRoot));
      return 0;
    }
    if (remainingArguments.length !== 1) {
      throw new Error(`Usage: agent ${agentId} auth [global|project|reset]`);
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
      throw new Error(`${agent.displayName} is not initialized. Run: agent ${agentId} init`);
    }
    const action = remainingArguments[0] ?? "status";
    if (remainingArguments.length > 1 || !["import", "restore", "status"].includes(action)) {
      throw new Error(`Usage: agent ${agentId} sessions [import|restore|status]`);
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
    console.log(action === "import" ? `Portable  ${result.changed ? "Updated" : "Unchanged"}` : `Restored  ${result.added + result.updated}`);
    if (result.conflicts > 0) {
      console.log(`Conflicts ${result.conflicts} (kept local ${agent.displayName} data)`);
    }
    return 0;
  }

  const state = await loadRuntime(projectRoot);
  const config = effectiveAgentConfig(state, agentId);
  if (!config) {
    throw new Error(`${agent.displayName} is not initialized. Run: agent ${agentId} init`);
  }
  if (config.auth === "project") {
    throw new Error(`${agent.displayName} project authentication adapter is not implemented yet`);
  }
  const adapter = getSessionAdapter(agentId);
  const restored = await adapter.restore(projectRoot);
  if (restored.conflicts > 0) {
    console.warn(`Portable session conflicts skipped: ${restored.conflicts} (kept local ${agent.displayName} data)`);
  }
  const status = launchExecutable(agent.executable, argumentsList, { cwd: projectRoot });
  await adapter.capture(projectRoot);
  return status;
}

async function dispatchStatus() {
  const projectRoot = locateProjectRoot();
  const state = await loadRuntime(projectRoot);
  console.log("AgentHome Status\n");
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
  console.log("AgentHome Doctor\n");
  console.log(`Project root       OK  ${projectRoot}`);
  console.log(`Runtime config     ${state.runtime.agents ? "OK" : "ERROR"}`);
  for (const agentId of Object.keys(AGENTS)) {
    const agent = getAgent(agentId);
    console.log(`${agent.displayName.padEnd(18)} ${executableAvailable(agent.executable) ? "OK" : "NOT FOUND"}`);
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
    throw new Error("Usage: agent sessions git [on|off|status]");
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

function dispatchSkills(argumentsList) {
  return launchExecutable(process.execPath, [path.join(packageRoot, "scripts", "skills.mjs"), ...argumentsList], {
    cwd: process.cwd(),
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
    return dispatchSkills(remainingArguments);
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
      throw new Error("Usage: agent update");
    }
    await updateAgentHome(packageRoot);
    return 0;
  }
  if (command === "status") {
    return dispatchStatus();
  }
  if (command === "doctor") {
    return dispatchDoctor();
  }
  throw new Error(`Unknown command: ${command}`);
}
