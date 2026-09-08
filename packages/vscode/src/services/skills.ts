import {
  addDirectSkills,
  adoptPackedSkills as coreAdoptPackedSkills,
  adoptSkills as coreAdoptSkills,
  createInstallContext,
  detectedSkillNames as coreDetectedSkillNames,
  installPacks as coreInstallPacks,
  installedPackIds as coreInstalledPackIds,
  loadPacks,
  planAdoptSkills,
  readDirectState,
  removeExternalSkills,
  resolveInstallSource,
  skillsInstallationStatus,
  uninstallPacks as coreUninstallPacks,
  type AdoptPackCandidate,
  type InstallContext,
  type InstallStatus,
  type Pack,
  type ProcessEnvLike,
} from "@avenic/core";

export type Scope = "project" | "global";
type Env = ProcessEnvLike;

function context(scope: Scope, cwd: string | undefined, environment: Env): InstallContext {
  return createInstallContext(scope === "global", { cwd, environment });
}

export function status(scope: Scope, cwd?: string, environment: Env = process.env): Promise<InstallStatus | null> {
  return skillsInstallationStatus(context(scope, cwd, environment));
}

export function installedPackIds(scope: Scope, cwd?: string, environment: Env = process.env): Promise<string[] | null> {
  return coreInstalledPackIds(context(scope, cwd, environment));
}

export function detected(scope: Scope, cwd?: string, environment: Env = process.env): Promise<string[]> {
  return coreDetectedSkillNames(context(scope, cwd, environment));
}

export function adopt(scope: Scope, names: string[], cwd?: string, environment: Env = process.env) {
  return coreAdoptSkills(context(scope, cwd, environment), names);
}

// Pack 识别计划（只读）：core 对磁盘 Skill 的覆盖度核算；Catalog 错误 → 空计划，调用方回退普通托管。
export function planAdopt(scope: Scope, names: string[], cwd?: string, environment: Env = process.env): Promise<{ candidates: AdoptPackCandidate[]; best: AdoptPackCandidate | null }> {
  return planAdoptSkills(context(scope, cwd, environment), names);
}

// 识别为指定 Pack 接管：补全缺失 Skill + 写入完整 Pack 元数据（保留先前托管记录）。
export function adoptPacked(scope: Scope, names: string[], packId: string, cwd?: string, environment: Env = process.env) {
  return coreAdoptPackedSkills(context(scope, cwd, environment), names, packId);
}

// 已托管但未关联任何 Pack 记录的 Skill 名（旧版包残留 → adopt 进 lock.adopted 的场景）：
// status.names 去掉 source 分组覆盖的部分。驱动「识别为 Pack」行级键位。
export async function adoptedOnlyNames(scope: Scope, cwd?: string, environment: Env = process.env): Promise<string[]> {
  const current = await skillsInstallationStatus(context(scope, cwd, environment));
  if (current === null) return [];
  const covered = new Set(current.groups.flatMap((group) => group.skills.map((skill) => skill.name)));
  return current.names.filter((name) => !covered.has(name));
}

export async function availablePacks(scope: Scope, cwd?: string, environment: Env = process.env): Promise<Map<string, Pack>> {
  const info = await resolveInstallSource({ global: scope === "global", cwd, environment });
  return loadPacks(info.catalogRoot);
}

export function installPacks(scope: Scope, packIds: string[], cwd?: string, environment: Env = process.env) {
  return coreInstallPacks(context(scope, cwd, environment), packIds);
}

export function uninstallPacks(scope: Scope, packIds: string[], cwd?: string, environment: Env = process.env) {
  return coreUninstallPacks(context(scope, cwd, environment), packIds);
}

export function directSkills(scope: Scope, cwd?: string, environment: Env = process.env) {
  return readDirectState(context(scope, cwd, environment));
}

export function addDirect(scope: Scope, repo: string, skillNames: string[], cwd?: string, environment: Env = process.env) {
  return addDirectSkills(context(scope, cwd, environment), repo, skillNames);
}

export function removeDirect(scope: Scope, names: string[], cwd?: string, environment: Env = process.env): Promise<string[]> {
  return removeExternalSkills(context(scope, cwd, environment), names).then((r) => r.directRemoved);
}
