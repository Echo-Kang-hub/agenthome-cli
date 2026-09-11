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
import { buildDraftPreview, buildModelPanelData } from "../model/state.ts";
import { profileInputFromDraft } from "../model/draft.ts";
import type { ProfileDraft } from "../model/protocol.ts";

type Env = ProcessEnvLike;
const environment = (env?: Env): Env => env ?? (process.env as Env);

export function panelData(projectRoot: string | null, env?: Env) {
  return buildModelPanelData({ projectRoot, environment: environment(env) as NodeJS.ProcessEnv });
}

export function profiles(env?: Env) {
  return listProfiles(environment(env));
}

// 草稿 → core 入参的翻译与「定位到输入」的校验都在 model/draft.ts（vscode-free、可测）。
// draft.apiKey === null → 保留库中现有密钥：面板只回显掩码，明文从不发回前端（§7）。
export async function saveProfile(draft: ProfileDraft, env?: Env) {
  const env2 = environment(env);
  const existing = await getProfile(env2, draft.id);
  const profile = normalizeProfile(profileInputFromDraft(draft, existing), { existing });
  await upsertProfile(env2, profile);
  return profile;
}

/** 面板编辑区的实时预览：投影条目 + 测试请求地址 + 可定位问题（全部由 core 判定）。 */
export async function preview(draft: ProfileDraft, env?: Env) {
  const env2 = environment(env);
  return buildDraftPreview(draft, await getProfile(env2, draft.id));
}

export function deleteProfile(id: string, env?: Env) {
  return removeProfile(environment(env), id);
}

// §9.2 的 [复制]：整份复制（含端点/模型/开关/env/覆盖），只换 id 与名称。
// id 必须满足 core 的 assertSafeId（^[a-z0-9_]{1,32}$），所以按 _copy / _copy2 … 顺序找空位。
function copyId(sourceId: string, taken: Set<string>): string {
  const base = `${sourceId}_copy`.slice(0, 32);
  if (!taken.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const suffix = String(index);
    const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

export async function duplicateProfile(id: string, env?: Env) {
  const env2 = environment(env);
  const source = await getProfile(env2, id);
  if (!source) return null;
  const taken = new Set((await listProfiles(env2)).map((profile) => profile.id));
  // 副本是**新**配置：不继承原配置的时间戳（normalizeProfile 会因此取当前时间）。
  const { createdAt, updatedAt, ...rest } = source;
  const copy = normalizeProfile({ ...rest, id: copyId(id, taken), name: `${source.name} 副本` });
  await upsertProfile(env2, copy);
  return copy;
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
