import {
  addDirectSkills,
  createInstallContext,
  installPacks as coreInstallPacks,
  installedPackIds as coreInstalledPackIds,
  loadPacks,
  readDirectState,
  removeExternalSkills,
  resolveInstallSource,
  skillsInstallationStatus,
  uninstallPacks as coreUninstallPacks,
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
