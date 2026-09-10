// Type declarations for @avenic/core.
// Hand-maintained next to src/index.mjs; update both in the same change.

export interface ProcessEnvLike {
  [key: string]: string | undefined;
}

export interface Agent {
  id: string;
  displayName: string;
  executable: string;
}

export interface Io {
  log(message?: string): void;
}

// ---- runtime: agents ----

export const AGENTS: Record<string, Agent>;
export function getAgent(agentId: string): Agent;
export function agentExecutableAvailable(agentId: string, environment?: ProcessEnvLike): boolean;

// ---- runtime: config ----

export interface AgentRuntimeConfig {
  enabled?: boolean;
  auth?: "global" | "project";
  sessions?: "global" | "project";
  [key: string]: unknown;
}

export interface EffectiveAgentConfig {
  enabled?: boolean;
  auth: "global" | "project";
  sessions: "global" | "project";
  configuredAuth: "global" | "project";
  localAuth: "global" | "project" | null;
}

export interface RuntimePaths {
  localRoot: string;
  runtimeFile: string;
  localRuntimeFile: string;
  sessionsRoot: string;
}

export interface RuntimeState {
  paths: RuntimePaths;
  runtime: { schemaVersion?: number; agents?: Record<string, AgentRuntimeConfig> };
  local: { schemaVersion?: number; agents?: Record<string, { auth?: "global" | "project" }> };
}

export function validateAuthMode(authMode: unknown): "global" | "project";
export function validateSessionsMode(sessionsMode: unknown): "global" | "project";
export function runtimePaths(projectRoot: string): RuntimePaths;
export function loadRuntime(projectRoot: string): Promise<RuntimeState>;
export function initializeAgent(
  projectRoot: string,
  agentId: string,
  authMode?: "global" | "project",
  sessionsMode?: "global" | "project",
): Promise<RuntimeState & { authMode: string; sessionsMode: string; configChanged: boolean; gitignoreChanged: boolean; structureRepaired: boolean }>;
export function projectAuthEnvironment(agentId: string, projectRoot: string): Record<string, string>;
export function deinitializeAgent(
  projectRoot: string,
  agentId: string,
  options?: { purge?: boolean },
): Promise<{ agent: Agent; changed: boolean; purged: boolean; remaining: number }>;
export function setLocalAuth(projectRoot: string, agentId: string, authMode: "global" | "project"): Promise<EffectiveAgentConfig>;
export function clearLocalAuth(projectRoot: string, agentId: string): Promise<EffectiveAgentConfig>;
export function effectiveAgentConfig(state: RuntimeState, agentId: string): EffectiveAgentConfig | null;

// ---- runtime: gitignore / project-root / process / sessions / adapters ----

export const REQUIRED_RULES: readonly string[];
export const SESSIONS_RULE: string;
export function ensureRuntimeGitignore(projectRoot: string): Promise<boolean>;
export function removeRuntimeGitignore(projectRoot: string, options?: { sessions?: boolean }): Promise<unknown>;
export function sessionsGitIgnored(projectRoot: string): Promise<boolean>;
export function setSessionsGitIgnored(projectRoot: string, ignored: boolean): Promise<boolean>;

export function locateProjectRoot(startDirectory?: string): string;
export function spawnExecutableSync(
  executable: string,
  argumentsList: string[],
  options?: {
    cwd?: string;
    env?: ProcessEnvLike;
    stdio?: "pipe" | "inherit" | "ignore";
    encoding?: string;
    windowsHide?: boolean;
    capture?: boolean;
    spawn?: (executable: string, argumentsList: string[], options: unknown) => unknown;
  },
): { status: number | null; stdout?: string; stderr?: string; error?: Error };

export const PROJECT_ROOT_TOKEN: string;
export interface SessionLease {
  member: string;
  stateDir: string;
  release: () => Promise<unknown>;
}
export interface SessionLeaseCallbacks {
  onFirst?: (recovering: boolean) => Promise<void>;
  onLast?: () => Promise<void>;
}
export function acquireSessionLease(agentId: string, projectRoot: string, callbacks?: SessionLeaseCallbacks): Promise<SessionLease>;
export function releaseSessionLease(agentId: string, projectRoot: string, member: string, callbacks?: SessionLeaseCallbacks): Promise<unknown>;
export function sessionLeasePath(agentId: string, projectRoot: string): string;
export function processAlive(pid: number): boolean;
export function samePath(left: string, right: string): boolean;
export function hashContent(content: string): string;
export function readFirstJsonLine(file: string): Promise<unknown | null>;
export function listFiles(sourcePath: string): Promise<string[]>;
export function snapshotFiles(sourceRoot: string, relativeFiles: string[], destination: string, transform?: (content: string) => string): Promise<unknown>;
export function snapshotInto(source: string, destination: string): Promise<unknown>;
export function revertFrom(snapshot: string, source: string): Promise<unknown>;
export function replaceDirectory(destination: string, build: (destination: string) => Promise<unknown>): Promise<unknown>;
export function mergeFiles(sourceRoot: string, relativeFiles: string[], destinationRoot: string, transform?: (content: string) => string, options?: { filter?: (relativePath: string) => boolean }): Promise<unknown>;
export function transformJsonLines(content: string, transform: (value: unknown) => unknown): string;

export interface SessionAdapterResult {
  count: number;
  changed?: boolean;
  added?: number;
  updated?: number;
  conflicts?: number;
}
export interface SessionAdapter {
  capture(projectRoot: string, options?: { environment?: ProcessEnvLike }): Promise<SessionAdapterResult>;
  restore(projectRoot: string, options?: { environment?: ProcessEnvLike }): Promise<SessionAdapterResult>;
  status(projectRoot: string, options?: { environment?: ProcessEnvLike }): Promise<{ count: number }>;
  snapshotNative?: (projectRoot: string, snapshotRoot: string, options?: { environment?: ProcessEnvLike }) => Promise<void>;
  revertNative?: (snapshotRoot: string, projectRoot: string, options?: { environment?: ProcessEnvLike }) => Promise<void>;
}
export function getSessionAdapter(agentId: string): SessionAdapter;

// ---- util ----

export function fail(message: string): never;
export function isInside(directory: string, target: string): boolean;
export function removeEmptyDirectory(directory: string): Promise<unknown>;
export function readJson(file: string): Promise<any>;
export function writeJson(file: string, value: unknown): Promise<unknown>;

// ---- skills: ids ----

export function assertSafeId(value: string, label?: string): string;
export function assertSafeSkillName(value: string): string;
export function assertSafeSkillPath(value: string): string;
export function assertSafeSkillRoot(value: string): string;
export function assertSafeRelativePath(value: string): string;

// ---- skills: paths ----

export const PROJECT_CONFIG_FILE: string;
export const PROJECT_LOCK_FILE: string;
export const LEGACY_PROFILE_FILE: string;
export interface InstallTarget {
  id: string;
  agents: string[];
  label: string;
  destination: string;
  relativePath?: string[];
  shareFrom?: string;
  shareDestination?: string;
}
export const MANAGED_AGENT_ORDER: string[];
export const PROJECT_TARGETS: Array<{ id: string; agents: string[]; label: string; relativePath: string[]; shareFrom?: string }>;
export const GLOBAL_TARGETS: InstallTarget[];
export function stateRoot(environment?: ProcessEnvLike): string;
export function catalogCacheRoot(environment?: ProcessEnvLike): string;
export function defaultCatalogFile(environment?: ProcessEnvLike): string;
export function knownCatalogsFile(environment?: ProcessEnvLike): string;
export function globalConfigFile(environment?: ProcessEnvLike): string;
export function globalLockFile(environment?: ProcessEnvLike): string;

// ---- skills: git / catalog / sources / packs ----

export function git(argumentsList: string[], options?: { cwd?: string; capture?: boolean; environment?: ProcessEnvLike }): string;
export function run(command: string, argumentsList: string[], options?: unknown): string;
export function normalizeRepositoryInput(reference: string): string;
export function deriveSourceId(repository: string): string;
export function repositoryIdentity(repository: string): string;
export function remoteHead(source: Source): string;
export function cloneHead(source: { repository: string }, directory: string): Promise<string>;
export function cloneRevision(source: Source, directory: string): Promise<string>;
export function currentRepositoryState(catalogRoot: string): { repository: string | null; revision: string | null; dirty: boolean | null };

export interface KnownCatalogEntry {
  name: string;
  spec: string;
}
export function parseCatalogSpec(spec: string): { repository: string; ref: string };
export function catalogDisplayName(spec: string): string;
export function loadDefaultCatalogSpec(environment?: ProcessEnvLike): Promise<string>;
export function setDefaultCatalogSpec(environment: ProcessEnvLike | undefined, spec: string): Promise<unknown>;
export function loadKnownCatalogs(environment?: ProcessEnvLike): Promise<KnownCatalogEntry[]>;
export function registerKnownCatalog(environment: ProcessEnvLike | undefined, spec: string): Promise<unknown>;
export interface CatalogInfo {
  catalogRoot: string;
  repository: string;
  ref: string;
  revision: string;
  spec: string;
}
export function ensureCatalog(spec: string, options?: { environment?: ProcessEnvLike; io?: Io }): Promise<CatalogInfo>;
export function registerCatalog(spec: string, options?: { environment?: ProcessEnvLike; io?: Io }): Promise<{
  spec: string;
  catalogInfo?: CatalogInfo;
  packs: Pack[];
  previewFailed: boolean;
  error?: Error;
}>;

export interface Source {
  id: string;
  name: string;
  repository: string;
  revision: string;
  skillRoot?: string;
  licenseFile?: string;
  skillPaths?: Record<string, string>;
}
export interface SourcesConfig {
  schemaVersion?: number;
  sources: Source[];
}
export function loadSources(catalogRoot: string): Promise<SourcesConfig>;
export function saveSources(catalogRoot: string, sourceConfig: SourcesConfig): Promise<unknown>;
export function registerSource(catalogRoot: string, sourceConfig: SourcesConfig, input: Partial<Source>, io?: Io): Promise<Source>;
export function findSource(sourceConfig: SourcesConfig, reference: string): Source | null;
export function detectSkillRoot(cloneDirectory: string): Promise<string>;
export function discoverSourceSkills(source: Source, cloneDirectory: string, options?: unknown): Promise<{ names: string[]; mappingsChanged: boolean }>;
export function readSkill(skillDirectory: string, requireMatchingFolder?: boolean): Promise<{ name: string; directory: string }>;
export function parseFrontmatterName(content: string, file: string): string;
export function stageSource(source: Source, cloneDirectory: string, stageDirectory: string, skillNames: string[]): Promise<unknown>;
export interface CatalogSkill {
  name: string;
  directory: string;
  source: Source;
}
export interface Catalog {
  groups: SkillGroup[];
  byName: Map<string, CatalogSkill>;
}
export function buildCatalog(sourceConfig: SourcesConfig, skillsRoot: string): Promise<Catalog>;
export function printTree(groups: SkillGroup[], title: string, header: string[], io?: Io): void;

export interface PackSelection {
  source: string;
  skills: string[];
}
export interface Pack {
  schemaVersion?: number;
  id: string;
  name: string;
  description?: string;
  sources: PackSelection[];
}
export interface SkillGroup {
  source: Source;
  skills: CatalogSkill[];
}
export interface ResolvedPacks {
  groups: SkillGroup[];
  names: string[];
  packs: Pack[];
  duplicateSelections: number;
}
export function loadPacks(catalogRoot: string): Promise<Map<string, Pack>>;
export function parsePackArguments(argumentsList: string[]): string[];
export function normalizePackIds(packIds: string[]): string[];
export function resolvePack(catalog: Catalog, sourceConfig: SourcesConfig, pack: Pack): { groups: SkillGroup[]; names: string[]; pack: Pack };
export function resolvePacks(catalog: Catalog, sourceConfig: SourcesConfig, packs: Map<string, Pack>, requestedPackIds: string[]): ResolvedPacks;
export function packContainsSkill(pack: Pack, sourceId: string, skillName: string): boolean;
export function skillCoveredByPacks(packs: Map<string, Pack>, packIds: string[], sourceId: string, skillName: string): boolean;
export function catalogReferences(packs: Map<string, Pack>): Set<string>;
export function addSkillsToPacks(catalogRoot: string, packIds: string[], sourceId: string, skillNames: string[]): Promise<{ added: Array<{ packId: string; skillName: string }>; inherited: string[] }>;
export function pruneCatalogSkills(catalogRoot: string, sourceConfig: SourcesConfig, packs: Map<string, Pack>, candidates: Array<{ sourceId: string; skillName: string }>): Promise<{ removed: Array<{ sourceId: string; skillName: string }>; removedSources: string[] }>;

// ---- skills: vendor / install / direct ----

export function createTempDirectory(catalogRoot: string): Promise<string>;
export function removeTempDirectory(directory: string, io?: Io): Promise<unknown>;
export function replaceStagedFiles(replacements: Array<{ relativePath: string; staged: string; target: string }>, tempDirectory: string): Promise<unknown>;

export interface InstallContext {
  configFile: string;
  environment: ProcessEnvLike;
  global: boolean;
  label: string;
  legacyProfileFile?: string;
  lockFile: string;
  root: string;
  targets: InstallTarget[];
}
export function isCatalogDirectory(directory: string): boolean;
export function createInstallContext(global: boolean, options?: { cwd?: string; environment?: ProcessEnvLike }): InstallContext;
export function resolveInstallPacks(context: InstallContext, explicitPacks: string[]): Promise<string[]>;
export function previousManagedState(context: InstallContext): Promise<Map<string, { sourceId: string; revision: string }>>;
export function installedPackIds(context: InstallContext): Promise<string[] | null>;
export function installCopies(context: InstallContext, resolvedPacks: ResolvedPacks, io?: Io): Promise<unknown>;
export function writeInstallMetadata(context: InstallContext, resolvedPacks: ResolvedPacks, catalogInfo?: Partial<CatalogInfo> & { packageMetadata?: unknown }): Promise<unknown>;
export function removeAllManagedSkills(context: InstallContext, managed: Map<string, unknown>, io?: Io): Promise<number>;
export function removeSkillDirectories(context: InstallContext, skillNames: string[], io?: Io): Promise<number>;
export function removeInstallationFiles(context: InstallContext): Promise<unknown>;
export function resolveInstallSource(options: { global?: boolean; cwd?: string; environment?: ProcessEnvLike; io?: Io }, opts?: { refresh?: boolean }): Promise<CatalogInfo & { packageMetadata: unknown }>;
export function installPacks(context: InstallContext, explicitPacks?: string[], options?: { io?: Io; onPlan?: (resolvedPacks: ResolvedPacks) => void }): Promise<{ catalogInfo: CatalogInfo; packIds: string[]; resolvedPacks: ResolvedPacks }>;
export function uninstallPacks(context: InstallContext, packArguments?: string[], options?: { io?: Io; onPlan?: (resolvedPacks: ResolvedPacks, removed: string[]) => void }): Promise<{ changed: boolean; removed: string[]; absent: string[]; skippedCommon: boolean; current: string[] | null; resolvedPacks?: ResolvedPacks }>;
export interface InstallStatus {
  groups: SkillGroup[];
  packs: Array<{ id?: string; name?: string } | string>;
  names: string[];
  targets: Array<InstallTarget & { present: number; total: number; complete: boolean }>;
}
export function skillsInstallationStatus(context: InstallContext): Promise<InstallStatus | null>;
export function detectedSkillNames(context: InstallContext): Promise<string[]>;
export function adoptSkills(context: InstallContext, skillNames: string[]): Promise<{ adopted: string[]; placed: number }>;

export interface AdoptPackCandidate {
  packId: string;
  packName: string;
  coverage: number;
  matched: string[];
  missing: number;
}
export function planAdoptSkills(
  context: InstallContext,
  skillNames: string[],
): Promise<{ candidates: AdoptPackCandidate[]; best: AdoptPackCandidate | null }>;
export function adoptPackedSkills(
  context: InstallContext,
  skillNames: string[],
  packId: string,
): Promise<{ packId: string; names: string[]; matched: string[] }>;

export interface DirectSourceState {
  directSources: Array<Source & { skills: string[] }>;
}
export function directRoot(context: InstallContext): string;
export function directLicensesRoot(context: InstallContext): string;
export function readDirectState(context: InstallContext): Promise<DirectSourceState>;
export function writeDirectState(context: InstallContext, state: DirectSourceState): Promise<unknown>;
export function addDirectSkills(context: InstallContext, sourceReference: string, skillNames: string[], options?: { io?: Io }): Promise<{ names: string[]; sourceId: string; revision: string; alreadyInstalled?: boolean }>;
export function removeDirectSkills(context: InstallContext, skillNames: string[]): Promise<string[]>;
export function removeExternalSkills(context: InstallContext, skillNames: string[], options?: { io?: Io }): Promise<{ directRemoved: string[]; removedDirectories: number }>;
