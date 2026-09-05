// Public API of @agenthome/core.
// Skills modules are added in later tasks.

export { AGENTS, getAgent } from "./runtime/agents.mjs";
export {
  clearLocalAuth,
  deinitializeAgent,
  effectiveAgentConfig,
  initializeAgent,
  loadRuntime,
  runtimePaths,
  setLocalAuth,
  validateAuthMode,
} from "./runtime/config.mjs";
export {
  REQUIRED_RULES,
  SESSIONS_RULE,
  ensureRuntimeGitignore,
  removeRuntimeGitignore,
  sessionsGitIgnored,
  setSessionsGitIgnored,
} from "./runtime/gitignore.mjs";
export { locateProjectRoot } from "./runtime/project-root.mjs";
export { spawnExecutableSync } from "./runtime/process.mjs";
export {
  PROJECT_ROOT_TOKEN,
  hashContent,
  listFiles,
  mergeFiles,
  readFirstJsonLine,
  replaceDirectory,
  samePath,
  snapshotFiles,
  transformJsonLines,
} from "./runtime/sessions.mjs";
export { getSessionAdapter } from "./runtime/adapters/index.mjs";

export { fail } from "./util/fail.mjs";
export { isInside, removeEmptyDirectory } from "./util/fs.mjs";
export { readJson, writeJson } from "./util/json.mjs";
export {
  assertSafeId,
  assertSafeSkillName,
  assertSafeSkillPath,
  assertSafeSkillRoot,
  assertSafeRelativePath,
} from "./skills/ids.mjs";
export {
  GLOBAL_CONFIG_FILE,
  GLOBAL_LOCK_FILE,
  GLOBAL_STATE_DIRECTORY,
  GLOBAL_TARGETS,
  LEGACY_PROFILE_FILE,
  PROJECT_CONFIG_FILE,
  PROJECT_LOCK_FILE,
  PROJECT_TARGETS,
  catalogCacheRoot,
  defaultCatalogFile,
  globalConfigFile,
  globalLockFile,
  stateRoot,
} from "./skills/paths.mjs";
export {
  cloneHead,
  cloneRevision,
  currentRepositoryState,
  deriveSourceId,
  git,
  normalizeRepositoryInput,
  remoteHead,
  repositoryIdentity,
  run,
} from "./skills/git.mjs";
export {
  ensureCatalog,
  loadDefaultCatalogSpec,
  parseCatalogSpec,
  setDefaultCatalogSpec,
} from "./skills/catalog.mjs";
export {
  addDirectSkills,
  directLicensesRoot,
  directRoot,
  readDirectState,
  removeDirectSkills,
  writeDirectState,
} from "./skills/direct.mjs";
export { printTree } from "./skills/ui.mjs";
export {
  buildCatalog,
  detectSkillRoot,
  discoverSourceSkills,
  findSource,
  loadSources,
  parseFrontmatterName,
  readSkill,
  registerSource,
  saveSources,
  stageSource,
} from "./skills/sources.mjs";
export {
  addSkillsToPacks,
  catalogReferences,
  loadPacks,
  normalizePackIds,
  packContainsSkill,
  parsePackArguments,
  pruneCatalogSkills,
  resolvePack,
  resolvePacks,
  skillCoveredByPacks,
} from "./skills/packs.mjs";
export {
  createTempDirectory,
  removeTempDirectory,
  replaceStagedFiles,
} from "./skills/vendor.mjs";
export {
  createInstallContext,
  installCopies,
  installedPackIds,
  isCatalogDirectory,
  previousManagedState,
  removeAllManagedSkills,
  removeInstallationFiles,
  removeSkillDirectories,
  resolveInstallPacks,
  writeInstallMetadata,
} from "./skills/install.mjs";
