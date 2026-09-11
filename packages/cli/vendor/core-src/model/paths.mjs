import path from "node:path";
import { stateRoot } from "../skills/paths.mjs";

export const PROJECT_MODEL_FILE = ".agents/model.json";
export const CLAUDE_SETTINGS_FILE = ".claude/settings.local.json";
export const PROJECT_TEMP_ROOT = ".agents/tmp";
export const LIBRARY_SCHEMA_VERSION = 1;
export const PROJECT_SCHEMA_VERSION = 1;

// 机器级库：复用既有 Avenic 状态根（AVENIC_STATE_DIR → XDG_CONFIG_HOME → ~/.config + avenic），
// 与 catalog.json / lock.json 同住；CLI 与插件读同一份。绝不新建第二个状态根。
export function modelsFile(environment = process.env) {
  return path.join(stateRoot(environment), "models.json");
}

export function modelsTempRoot(environment = process.env) {
  return path.join(stateRoot(environment), "tmp");
}

export function projectModelFile(projectRoot) {
  return path.join(projectRoot, ...PROJECT_MODEL_FILE.split("/"));
}

export function projectTempRoot(projectRoot) {
  return path.join(projectRoot, ...PROJECT_TEMP_ROOT.split("/"));
}

export function claudeSettingsFile(projectRoot) {
  return path.join(projectRoot, ...CLAUDE_SETTINGS_FILE.split("/"));
}
