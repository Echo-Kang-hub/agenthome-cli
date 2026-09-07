import { existsSync, renameSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const PROJECT_CONFIG_FILE = ".avenic.json";
export const PROJECT_LOCK_FILE = ".avenic.lock.json";
export const LEGACY_PROJECT_CONFIG_FILE = ".agent-skills.json";
export const LEGACY_PROJECT_LOCK_FILE = ".agent-skills.lock.json";
export const LEGACY_PROFILE_FILE = ".agent-skills-profile"; // 保持旧名：仅历史读取

export function migrateLegacyProjectFiles(cwd) {
  for (const [legacy, current] of [
    [LEGACY_PROJECT_CONFIG_FILE, PROJECT_CONFIG_FILE],
    [LEGACY_PROJECT_LOCK_FILE, PROJECT_LOCK_FILE],
  ]) {
    const from = path.join(cwd, legacy);
    const to = path.join(cwd, current);
    if (!existsSync(to) && existsSync(from)) renameSync(from, to); // 同目录原子 rename
  }
}

export const PROJECT_TARGETS = [
  { agents: ["claude-code"], label: "Claude Code", relativePath: [".claude", "skills"] },
  {
    agents: ["codex", "opencode", "universal"],
    label: "Codex / OpenCode / universal agents",
    relativePath: [".agents", "skills"],
  },
];

// Read an environment variable under its current name, falling back to a
// deprecated legacy name with a deprecation warning on stderr.
export function deprecatedEnvironmentValue(environment, primary, legacy) {
  if (environment[primary]) return environment[primary];
  if (environment[legacy]) {
    console.warn(`Environment variable ${legacy} is deprecated; use ${primary}`);
    return environment[legacy];
  }
  return undefined;
}

export function stateRoot(environment = process.env) {
  const override = deprecatedEnvironmentValue(environment, "AVENIC_STATE_DIR", "AGENTHOME_STATE_DIR");
  if (override) return override;
  const root = environment.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const current = path.join(root, "avenic");
  const legacy = path.join(root, "agent-skills");
  if (existsSync(legacy)) {
    let currentIsDir;
    try {
      currentIsDir = statSync(current, { throwIfNoEntry: false })?.isDirectory();
    } catch {
      return legacy; // 任何 statSync 失败（如符号链接循环 ELOOP）都降级继续用旧目录
    }
    if (!currentIsDir) {
      // 新路径被同名非目录占用：不能迁移进去，也绝不覆盖删除，降级继续用旧目录
      if (existsSync(current)) return legacy;
      try {
        renameSync(legacy, current); // 同父目录原子 rename，一次性迁移
      } catch {
        return legacy; // 迁移失败降级：继续用旧目录，不丢数据
      }
    }
  }
  return current;
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

export function knownCatalogsFile(environment = process.env) {
  return path.join(stateRoot(environment), "catalogs.json");
}

export function globalConfigFile(environment = process.env) {
  return path.join(stateRoot(environment), "config.json");
}

export function globalLockFile(environment = process.env) {
  return path.join(stateRoot(environment), "lock.json");
}
