import {
  API_TYPES,
  AUTH_FIELDS,
  CODEX_EFFORTS,
  MODEL_ROLES,
  PRESETS,
  TOGGLE_ENTRIES,
  TOGGLE_KEYS,
  agentCompatibility,
  buildClaudeEntries,
  maskSecret,
  modelsFile,
  normalizeProfile,
  probeUrl,
  projectModelStatus,
  readLibrary,
} from "@avenic/core";
import type { ModelProfile } from "@avenic/core";
import type { DraftPreview, ModelCardData, ModelPanelData, PanelOptions, ProfileDraft } from "./protocol.ts";
import { draftIssues, profileInputFromDraft } from "./draft.ts";

// vscode-free：面板数据组装在纯模块里（插件测试没有 vscode stub），
// 且只输出掩码——完整密钥永不进入 webview。

// 中文标签只存在于扩展侧。**成员与顺序一律来自 core**（MODEL_ROLES / TOGGLE_KEYS /
// TOGGLE_ENTRIES / API_TYPES / AUTH_FIELDS / CODEX_EFFORTS / PRESETS）：core 加了新角色或
// 新开关，面板会照样渲染出来（标签缺失时回退成 id），不会静默漏掉一行。
const ROLE_LABELS: Record<string, string> = {
  main: "主模型",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  fable: "Fable",
  subagent: "Subagent",
};

const TOGGLE_LABELS: Record<string, string> = {
  teams: "Teams",
  toolSearch: "Tool Search",
  maxEffort: "Max Effort",
  noNonessentialTraffic: "禁用非必要流量",
  noAutoUpdate: "禁用自动更新",
  hideAttribution: "隐藏 AI 署名",
};

const AGENT_LABELS: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode" };

// 1M 上下文勾选框只在 Opus / Sonnet 上提供（设计 §9.3）。**故意不放进 core**：core 的
// normalizeModelRow 接受任意角色的 longContext，这是为了兼容 CLI 写过的库——把它改成
// "只准这两个角色"会把既有的库判成非法。所以这里只是"显示哪些勾选框"，不是校验规则；
// 没显示勾选框的角色仍会原样透传库里已有的 longContext（见 profileToDraft）。
const LONG_CONTEXT_ROLES = ["opus", "sonnet"];

export function panelOptions(): PanelOptions {
  return {
    apis: [...API_TYPES],
    authFields: [...AUTH_FIELDS],
    roles: MODEL_ROLES.map((id) => ({ id, label: ROLE_LABELS[id] ?? id })),
    toggles: TOGGLE_ENTRIES.map(([id, path]) => ({ id, label: TOGGLE_LABELS[id] ?? id, writes: path.join(".") })),
    presets: PRESETS.map((preset) => ({ id: preset.id, label: preset.label, baseUrl: preset.baseUrl, api: preset.api })),
    longContextRoles: [...LONG_CONTEXT_ROLES],
    agents: Object.keys(AGENT_LABELS).map((id) => ({ id, label: AGENT_LABELS[id] })),
    codexEffort: [...CODEX_EFFORTS],
  };
}

// 库里存着的 longContext 原样带进草稿：面板不为部分角色提供勾选框，但保存会整份重写，
// 不带上就等于用界面抹掉 CLI 写进去的值。开关同理：TOGGLE_KEYS 是唯一清单。
export function profileToDraft(profile: ModelProfile): ProfileDraft {
  const models: ProfileDraft["models"] = {};
  for (const role of MODEL_ROLES) {
    const row = profile.models?.[role];
    models[role] = {
      id: row?.id ?? "",
      ...(row?.display !== undefined ? { display: row.display } : {}),
      ...(row?.longContext === true ? { longContext: true } : {}),
    };
  }
  const overrides: ProfileDraft["overrides"] = {};
  for (const agentId of ["codex", "opencode"] as const) {
    const override = profile.overrides?.[agentId];
    if (!override) continue;
    overrides[agentId] = { baseUrl: override.baseUrl, api: override.api, ...(override.providerId !== undefined ? { providerId: override.providerId } : {}) };
  }
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.endpoint.baseUrl,
    api: profile.endpoint.api,
    authField: profile.endpoint.authField,
    // 打开编辑区永远是"不修改密钥"：界面只拿到掩码，明文留在 host 侧（§7）。
    apiKey: null,
    models,
    toggles: TOGGLE_KEYS.filter((key) => profile.toggles?.[key] === true),
    env: Object.entries(profile.env ?? {}).map(([key, value]) => ({ key, value: String(value) })),
    overrides,
    codex: { ...profile.codex },
    opencode: { ...profile.opencode },
  };
}

/**
 * 草稿的投影预览 + 测试请求地址 + 可定位问题。
 *
 * 面板**不自己拼 JSON**：投影由 core 的 buildClaudeEntries 产出（§9.7 投影属于业务逻辑），
 * 面板只负责把 path.join(".") 与值排成 JSON 文本。密钥在这里就被换成掩码——明文不出 host。
 */
export function buildDraftPreview(draft: ProfileDraft, existing: ModelProfile | null): DraftPreview {
  const issues = draftIssues(draft, existing);
  if (issues.length > 0) return { entries: [], requestUrl: null, error: null, issues };
  let profile: ModelProfile;
  try {
    profile = normalizeProfile(profileInputFromDraft(draft, existing), { existing });
  } catch (error) {
    return { entries: [], requestUrl: null, error: error instanceof Error ? error.message : String(error), issues: [] };
  }
  let entries: DraftPreview["entries"];
  try {
    entries = buildClaudeEntries(profile).map((entry) => {
      // 认证字段那一行承载密钥：换成掩码后才是可以出 host 的形态。
      const carriesSecret = entry.path.length === 2 && entry.path[0] === "env" && entry.path[1] === profile.endpoint.authField;
      return carriesSecret ? { path: entry.path, value: maskSecret(profile.endpoint.apiKey), secret: true } : { path: entry.path, value: entry.value };
    });
  } catch (error) {
    return { entries: [], requestUrl: null, error: error instanceof Error ? error.message : String(error), issues: [] };
  }
  let requestUrl: string | null = null;
  try {
    requestUrl = probeUrl(profile.endpoint.baseUrl, profile.endpoint.api);
  } catch {
    // 非法 Base URL 已经在 draftIssues 里报成 baseUrl 问题；这里保持"无地址"即可。
  }
  return { entries, requestUrl, error: null, issues: [] };
}

export async function buildModelPanelData(input: { projectRoot: string | null; environment: NodeJS.ProcessEnv }): Promise<ModelPanelData> {
  const { projectRoot, environment } = input;
  const libraryPath = modelsFile(environment);
  const base: ModelPanelData = {
    libraryPath,
    libraryExists: false,
    libraryBroken: null,
    projectRoot,
    cards: [],
    binding: null,
    projection: null,
    options: panelOptions(),
    notes: [],
    message: null,
  };
  try {
    const library = await readLibrary(environment);
    base.libraryExists = library.exists;
    const status = projectRoot === null ? null : await projectModelStatus(projectRoot, environment);
    base.message = status?.message ?? null;
    base.cards = Object.values(library.profiles)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((profile): ModelCardData => ({
        id: profile.id,
        name: profile.name,
        baseUrl: profile.endpoint.baseUrl,
        api: profile.endpoint.api,
        apiKeyMasked: maskSecret(profile.endpoint.apiKey),
        hasStoredApiKey: profile.endpoint.apiKey !== "",
        mainModel: profile.models?.main?.id ?? "",
        current: status?.binding.activeProfileId === profile.id,
        compatibility: agentCompatibility(profile),
        profile: profileToDraft(profile),
      }));
    if (status?.profile) {
      base.binding = { profileId: status.profile.id, name: status.profile.name };
      base.projection = status.projection;
      base.notes.push("Codex：启动时注入 -c model_provider / -m（不写项目文件）");
      base.notes.push("OpenCode：启动时注入 OPENCODE_CONFIG_CONTENT（不写项目文件）");
      if (status.projection && !status.projection.fingerprintMatches) {
        base.notes.push("投影指纹不一致：下次启动会重新生成");
      }
    }
  } catch (error) {
    base.libraryBroken = error instanceof Error ? error.message : String(error);
  }
  if (projectRoot === null) {
    base.notes.push("未打开项目文件夹：「用于当前项目」不可用");
  }
  return base;
}
