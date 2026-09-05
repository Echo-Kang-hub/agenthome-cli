import os from "node:os";
import path from "node:path";
import process from "node:process";

export const PROJECT_CONFIG_FILE = ".agent-skills.json";
export const PROJECT_LOCK_FILE = ".agent-skills.lock.json";
export const LEGACY_PROFILE_FILE = ".agent-skills-profile";
export const PROJECT_TARGETS = [
  { agents: ["claude-code"], label: "Claude Code", relativePath: [".claude", "skills"] },
  {
    agents: ["codex", "opencode", "universal"],
    label: "Codex / OpenCode / universal agents",
    relativePath: [".agents", "skills"],
  },
];

export function stateRoot(environment = process.env) {
  if (environment.AGENTHOME_STATE_DIR) {
    return environment.AGENTHOME_STATE_DIR;
  }
  return path.join(
    environment.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "agent-skills",
  );
}

export const GLOBAL_TARGETS = [
  {
    agents: ["claude-code"],
    label: "Claude Code",
    destination: path.join(os.homedir(), ".claude", "skills"),
  },
  {
    agents: ["codex", "opencode", "universal"],
    label: "Codex / OpenCode / universal agents",
    destination: path.join(os.homedir(), ".agents", "skills"),
  },
];

export function catalogCacheRoot(environment = process.env) {
  return path.join(stateRoot(environment), "catalog");
}

export function defaultCatalogFile(environment = process.env) {
  return path.join(stateRoot(environment), "catalog.json");
}

export function globalConfigFile(environment = process.env) {
  return path.join(stateRoot(environment), "config.json");
}

export function globalLockFile(environment = process.env) {
  return path.join(stateRoot(environment), "lock.json");
}
