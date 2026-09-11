import {
  bindProject,
  clearProjectBinding,
  ensureModelGitignore,
  getProfile,
  listProfiles,
  normalizeProfile,
  parseConfigJson,
  parseConfigText,
  removeProfile,
  testConnection,
  upsertProfile,
  type ProcessEnvLike,
} from "@avenic/core";
import { buildModelPanelData } from "../model/state.ts";
import type { ProfileDraft } from "../model/protocol.ts";

type Env = ProcessEnvLike;
const environment = (env?: Env): Env => env ?? (process.env as Env);

export function panelData(projectRoot: string | null, env?: Env) {
  return buildModelPanelData({ projectRoot, environment: environment(env) as NodeJS.ProcessEnv });
}

export function profiles(env?: Env) {
  return listProfiles(environment(env));
}

// draft.apiKey === null → 保留库中现有密钥（面板只回显掩码，永远不把明文发回前端）
export async function saveProfile(draft: ProfileDraft, env?: Env) {
  const env2 = environment(env);
  const existing = await getProfile(env2, draft.id);
  const apiKey = draft.apiKey ?? existing?.endpoint.apiKey ?? "";
  const profile = normalizeProfile(
    {
      id: draft.id,
      name: draft.name,
      // 草稿不带 authField（面板不暴露它）；改绑保留库中既有值，新建走 core 的同一默认。
      endpoint: { baseUrl: draft.baseUrl, api: draft.api, authField: existing?.endpoint.authField ?? "ANTHROPIC_AUTH_TOKEN", apiKey },
      models: draft.mainModel ? { ...(existing?.models ?? {}), main: { id: draft.mainModel } } : existing?.models,
      toggles: existing?.toggles,
      env: existing?.env,
      claude: existing?.claude,
    },
    { existing },
  );
  await upsertProfile(env2, profile);
  return profile;
}

export function deleteProfile(id: string, env?: Env) {
  return removeProfile(environment(env), id);
}

export async function bind(projectRoot: string, id: string, env?: Env) {
  const env2 = environment(env);
  await ensureModelGitignore(projectRoot);
  return bindProject(projectRoot, env2, id);
}

export function clear(projectRoot: string, env?: Env) {
  return clearProjectBinding(projectRoot, environment(env));
}

export function probe(id: string, env?: Env) {
  return getProfile(environment(env), id).then((profile) => (profile ? testConnection(profile) : null));
}

export const parseJson = (text: string) => parseConfigJson(text);
export const parseText = (text: string) => parseConfigText(text);
