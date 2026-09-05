import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fail } from "../util/fail.mjs";
import { isInside, removeEmptyDirectory } from "../util/fs.mjs";
import { readJson, writeJson } from "../util/json.mjs";
import { assertSafeSkillName } from "./ids.mjs";
import { normalizePackIds, parsePackArguments } from "./packs.mjs";
import {
  GLOBAL_TARGETS,
  LEGACY_PROFILE_FILE,
  PROJECT_CONFIG_FILE,
  PROJECT_LOCK_FILE,
  PROJECT_TARGETS,
  globalConfigFile,
  globalLockFile,
} from "./paths.mjs";

export function isCatalogDirectory(directory) {
  return (
    existsSync(path.join(directory, "sources.lock.json")) &&
    existsSync(path.join(directory, "skills")) &&
    existsSync(path.join(directory, "packs"))
  );
}

export function createInstallContext(global, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const environment = options.environment ?? process.env;
  if (global) {
    return {
      configFile: globalConfigFile(environment),
      label: "Global",
      lockFile: globalLockFile(environment),
      root: environment.USERPROFILE || environment.HOME || os.homedir(),
      targets: GLOBAL_TARGETS,
    };
  }
  return {
    configFile: path.join(cwd, PROJECT_CONFIG_FILE),
    label: "Project",
    legacyProfileFile: path.join(cwd, LEGACY_PROFILE_FILE),
    lockFile: path.join(cwd, PROJECT_LOCK_FILE),
    root: cwd,
    targets: PROJECT_TARGETS.map((target) => ({
      ...target,
      destination: path.join(cwd, ...target.relativePath),
    })),
  };
}

export async function resolveInstallPacks(context, explicitPacks) {
  const requested = parsePackArguments(explicitPacks);
  if (requested.length > 0) {
    return normalizePackIds(requested);
  }
  if (existsSync(context.configFile)) {
    const config = await readJson(context.configFile);
    return normalizePackIds(config.packs ?? (config.pack ? [config.pack] : []));
  }
  if (context.legacyProfileFile && existsSync(context.legacyProfileFile)) {
    return normalizePackIds(
      parsePackArguments([(await readFile(context.legacyProfileFile, "utf8")).trim()]),
    );
  }
  return ["common"];
}

export async function previousManagedState(context) {
  if (!existsSync(context.lockFile)) {
    return new Map();
  }
  const manifest = await readJson(context.lockFile);
  const managed = new Map();
  for (const source of manifest.sources ?? []) {
    for (const skillName of source.skills ?? []) {
      managed.set(skillName, { sourceId: source.id, revision: source.revision });
    }
  }
  return managed;
}

export async function installedPackIds(context) {
  if (existsSync(context.configFile)) {
    const config = await readJson(context.configFile);
    return normalizePackIds(config.packs ?? (config.pack ? [config.pack] : []));
  }
  if (existsSync(context.lockFile)) {
    const lock = await readJson(context.lockFile);
    return normalizePackIds(
      (lock.packs ?? (lock.pack ? [lock.pack] : [])).map((pack) => pack.id ?? pack),
    );
  }
  return null;
}

export async function writeInstallMetadata(context, resolvedPacks, catalogInfo = {}) {
  const packageMetadata = catalogInfo.packageMetadata ?? null;
  const packageSpec = catalogInfo.spec ?? packageMetadata?.agentSkills?.packageSpec ?? packageMetadata?.repository?.url;
  const previousConfig = existsSync(context.configFile) ? await readJson(context.configFile) : {};
  const previousLock = existsSync(context.lockFile) ? await readJson(context.lockFile) : {};
  const config = {
    schemaVersion: 3,
    catalog: packageSpec,
    packs: resolvedPacks.packs.map((pack) => pack.id),
    ...(previousConfig.direct ? { direct: previousConfig.direct } : {}),
  };
  const lock = {
    schemaVersion: 3,
    packs: resolvedPacks.packs.map((pack) => ({
      id: pack.id,
      name: pack.name,
      description: pack.description ?? "",
    })),
    catalog: {
      spec: packageSpec,
      repository: catalogInfo.repository ?? null,
      revision: catalogInfo.revision ?? null,
    },
    ...(previousLock.directSources ? { directSources: previousLock.directSources } : {}),
    agents: context.targets.flatMap((target) => target.agents).filter((agent) => agent !== "universal"),
    sources: resolvedPacks.groups.map((group) => ({
      id: group.source.id,
      name: group.source.name,
      repository: group.source.repository,
      revision: group.source.revision,
      skills: group.skills.map((skill) => skill.name),
    })),
  };
  await mkdir(path.dirname(context.configFile), { recursive: true });
  await writeJson(context.configFile, config);
  await writeJson(context.lockFile, lock);
  if (context.legacyProfileFile && existsSync(context.legacyProfileFile)) {
    await rm(context.legacyProfileFile);
  }
}

export async function installCopies(context, resolvedPacks, io = console) {
  const selectedSkills = resolvedPacks.groups.flatMap((group) => group.skills);
  const selectedNames = new Set(selectedSkills.map((skill) => skill.name));
  const previousState = await previousManagedState(context);
  const staleNames = [...previousState.keys()].filter((name) => !selectedNames.has(name));
  for (const targetConfig of context.targets) {
    const destination = targetConfig.destination;
    await mkdir(destination, { recursive: true });
    const result = { added: 0, updated: 0, unchanged: 0, removed: 0 };
    for (const skill of selectedSkills) {
      const target = path.join(destination, skill.name);
      if (!isInside(destination, target)) {
        fail(`Install path escaped its target: ${target}`);
      }
      const previous = previousState.get(skill.name);
      if (
        existsSync(path.join(target, "SKILL.md")) &&
        previous?.sourceId === skill.source.id &&
        previous?.revision === skill.source.revision
      ) {
        result.unchanged += 1;
        continue;
      }
      const existed = existsSync(target);
      await rm(target, { recursive: true, force: true });
      await cp(skill.directory, target, { recursive: true });
      result[existed ? "updated" : "added"] += 1;
    }
    for (const staleName of staleNames) {
      assertSafeSkillName(staleName);
      const target = path.join(destination, staleName);
      if (!isInside(destination, target)) {
        fail(`Cleanup path escaped its target: ${target}`);
      }
      await rm(target, { recursive: true, force: true });
      result.removed += 1;
    }
    io.log(`✓ ${targetConfig.label}`);
    io.log(`  Path: ${destination}`);
    io.log(
      `  Added ${result.added} · Updated ${result.updated} · Unchanged ${result.unchanged} · Removed ${result.removed}`,
    );
  }
}

export async function removeAllManagedSkills(context, managed, io = console) {
  let total = 0;
  for (const targetConfig of context.targets) {
    let removed = 0;
    for (const skillName of managed.keys()) {
      assertSafeSkillName(skillName);
      const target = path.join(targetConfig.destination, skillName);
      if (!isInside(targetConfig.destination, target)) {
        fail(`Uninstall path escaped its target: ${target}`);
      }
      if (existsSync(target)) {
        await rm(target, { recursive: true, force: true });
        removed += 1;
      }
    }
    await removeEmptyDirectory(targetConfig.destination);
    total += removed;
    io.log(`${targetConfig.label}: Removed ${removed}`);
  }
  return total;
}

export async function removeSkillDirectories(context, skillNames, io = console) {
  let total = 0;
  for (const targetConfig of context.targets) {
    let removed = 0;
    for (const skillName of skillNames) {
      const target = path.join(targetConfig.destination, skillName);
      if (!isInside(targetConfig.destination, target)) {
        fail(`Uninstall path escaped its target: ${target}`);
      }
      if (existsSync(target)) {
        await rm(target, { recursive: true, force: true });
        removed += 1;
      }
    }
    total += removed;
    io.log(`${targetConfig.label}: ${removed > 0 ? `Removed ${removed}` : "Unchanged"}`);
  }
  return total;
}

export async function removeInstallationFiles(context) {
  await rm(context.configFile, { force: true });
  await rm(context.lockFile, { force: true });
  if (context.legacyProfileFile) {
    await rm(context.legacyProfileFile, { force: true });
  }
}
