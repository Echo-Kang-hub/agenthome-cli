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
//
// ProfileDraft 只承载面板能编辑的字段（id/name/baseUrl/api/apiKey/mainModel）。core 的
// normalizeProfile 是「白名单化」：没传的字段不留原值、而是取默认值——所以凡是草稿里没有的
// 字段都必须逐项从 existing 带过来，否则在面板里改一次名字就会永久抹掉该配置的
// Codex/OpenCode 端点覆盖与 provider 设置（不可撤销）。
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
      // 以下全部是面板管不到的字段：原样带过，语义为「不修改」。
      overrides: existing?.overrides,
      models: draft.mainModel ? { ...(existing?.models ?? {}), main: { id: draft.mainModel } } : existing?.models,
      toggles: existing?.toggles,
      env: existing?.env,
      claude: existing?.claude,
      codex: existing?.codex,
      opencode: existing?.opencode,
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
