// Public API of @avenic/core.

export { AGENTS, agentExecutableAvailable, getAgent } from "./runtime/agents.mjs";
export {
  clearLocalAuth,
  deinitializeAgent,
  effectiveAgentConfig,
  initializeAgent,
  loadRuntime,
  projectAuthEnvironment,
  runtimePaths,
  setLocalAuth,
  validateAuthMode,
  validateSessionsMode,
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
  acquireSessionLease,
  hashContent,
  listFiles,
  mergeFiles,
  processAlive,
  readFirstJsonLine,
  releaseSessionLease,
  replaceDirectory,
  revertFrom,
  samePath,
  sessionLeasePath,
  snapshotFiles,
  snapshotInto,
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
  GLOBAL_TARGETS,
  LEGACY_PROFILE_FILE,
  PROJECT_CONFIG_FILE,
  PROJECT_LOCK_FILE,
  PROJECT_TARGETS,
  catalogCacheRoot,
  defaultCatalogFile,
  globalConfigFile,
  globalLockFile,
  knownCatalogsFile,
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
  catalogDisplayName,
  ensureCatalog,
  loadDefaultCatalogSpec,
  loadKnownCatalogs,
  parseCatalogSpec,
  registerCatalog,
  registerKnownCatalog,
  setDefaultCatalogSpec,
} from "./skills/catalog.mjs";
export {
  addDirectSkills,
  directLicensesRoot,
  directRoot,
  readDirectState,
  removeDirectSkills,
  removeExternalSkills,
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
  adoptSkills,
  createInstallContext,
  detectedSkillNames,
  installCopies,
  installPacks,
  installedPackIds,
  isCatalogDirectory,
  previousManagedState,
  removeAllManagedSkills,
  removeInstallationFiles,
  removeSkillDirectories,
  resolveInstallPacks,
  resolveInstallSource,
  skillsInstallationStatus,
  uninstallPacks,
  writeInstallMetadata,
} from "./skills/install.mjs";
