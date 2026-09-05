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
