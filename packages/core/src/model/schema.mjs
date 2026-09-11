import { fail } from "../util/fail.mjs";
import { hashContent } from "../runtime/sessions.mjs";
import { LIBRARY_SCHEMA_VERSION } from "./paths.mjs";

export const MODEL_ROLES = ["main", "opus", "sonnet", "haiku", "fable", "subagent"];
export const API_TYPES = ["anthropic", "openai-chat", "openai-responses"];
export const AUTH_FIELDS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];
const TOGGLE_KEYS = ["teams", "toolSearch", "maxEffort", "noNonessentialTraffic", "noAutoUpdate", "hideAttribution"];

// cmd.exe 无法转义这些字符（引号内也会展开 %VAR%），且 .cmd 链路上 & | ^ < > ( ) 会被二次解析。
const FORBIDDEN_IN_VALUE = /[%"'`$&|^<>()!]/;
const BASE_URL = /^https?:\/\/[A-Za-z0-9._~:/?#\[\]@+,;=\-]+$/;

export function validateBaseUrl(value) {
  const text = String(value ?? "").trim();
  if (!/^https?:\/\//i.test(text)) fail(`Base URL must start with http:// or https://: ${text}`);
  if (FORBIDDEN_IN_VALUE.test(text)) {
    fail("Base URL must not contain % \" ' ` $ or the characters & | ^ < > ( ) !");
  }
  if (!BASE_URL.test(text)) fail(`Base URL is not a valid URL: ${text}`);
  return text;
}

export function validateProviderId(value) {
  const text = String(value ?? "").trim();
  if (!/^[a-z0-9_]{1,32}$/.test(text)) fail(`Invalid provider id (expected ^[a-z0-9_]{1,32}$): ${text}`);
  return text;
}

export function validateEnvKey(value) {
  const text = String(value ?? "").trim();
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(text)) fail(`Invalid environment variable name: ${text}`);
  return text;
}

export function validateModelId(value) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._:\-/]{1,128}$/.test(text)) fail(`Invalid model id: ${text}`);
  return text;
}

export function assertSafeId(value) {
  return validateProviderId(value); // profile id 与 provider id 同规则
}

// 掩码：前 3 后 4；过短一律全掩。所有对外输出（CLI/通知/日志/面板）都必须先过这里。
export function maskSecret(value) {
  const text = typeof value === "string" ? value : "";
  if (text.length === 0) return "";
  if (text.length <= 8) return "••••";
  return `${text.slice(0, 3)}…${text.slice(-4)}`;
}

// 递归键排序的稳定序列化：指纹与比较用。
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function normalizeModelRow(input) {
  if (input === null || input === undefined) return null;
  const id = validateModelId(input.id);
  const row = { id };
  if (typeof input.display === "string" && input.display.trim().length > 0) row.display = input.display.trim();
  if (input.longContext === true) row.longContext = true;
  return row;
}

function normalizeEndpoint(input, defaults = {}) {
  const source = input ?? {};
  const baseUrl = validateBaseUrl(source.baseUrl ?? defaults.baseUrl ?? fail("Base URL is required"));
  const api = source.api ?? defaults.api ?? "anthropic";
  if (!API_TYPES.includes(api)) fail(`Unknown API type: ${api}`);
  const authField = source.authField ?? defaults.authField ?? "ANTHROPIC_AUTH_TOKEN";
  if (!AUTH_FIELDS.includes(authField)) fail(`Unknown auth field: ${authField}`);
  return { baseUrl, api, authField, apiKey: String(source.apiKey ?? defaults.apiKey ?? "") };
}

// 归一化 = 白名单化：只保留设计里定义的字段，其余一律丢弃（粘贴/CLI/面板共用同一条路径）。
export function normalizeProfile(input, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const existing = options.existing ?? null;
  const id = assertSafeId(input.id ?? fail("Profile id is required"));
  const endpoint = normalizeEndpoint(input.endpoint);
  const overrides = {};
  for (const agentId of ["codex", "opencode"]) {
    const override = input.overrides?.[agentId];
    if (override) {
      overrides[agentId] = {
        ...normalizeEndpoint(override, { baseUrl: endpoint.baseUrl, api: endpoint.api, authField: endpoint.authField, apiKey: endpoint.apiKey }),
        providerId: override.providerId ? validateProviderId(override.providerId) : undefined,
      };
    }
  }
  const models = {};
  for (const role of MODEL_ROLES) {
    const row = normalizeModelRow(input.models?.[role]);
    if (row) models[role] = row;
  }
  const toggles = {};
  for (const key of TOGGLE_KEYS) {
    if (input.toggles?.[key] === true) toggles[key] = true;
  }
  const env = {};
  for (const [key, value] of Object.entries(input.env ?? {})) {
    env[validateEnvKey(key)] = String(value);
  }
  const claudeSettings = {};
  for (const [key, value] of Object.entries(input.claude?.settings ?? {})) {
    claudeSettings[key] = value;
  }
  return {
    id,
    name: String(input.name ?? existing?.name ?? id),
    endpoint,
    overrides,
    models,
    toggles,
    env,
    claude: { settings: claudeSettings },
    codex: {
      providerId: validateProviderId(input.codex?.providerId ?? `avenic_${id}`),
      envKey: validateEnvKey(input.codex?.envKey ?? "AVENIC_MODEL_KEY"),
      reasoningEffort: ["minimal", "low", "medium", "high"].includes(input.codex?.reasoningEffort)
        ? input.codex.reasoningEffort
        : "medium",
    },
    opencode: {
      providerId: validateProviderId(input.opencode?.providerId ?? id),
      npmAdapter: String(input.opencode?.npmAdapter ?? "@ai-sdk/openai-compatible"),
    },
    createdAt: existing?.createdAt ?? input.createdAt ?? now,
    updatedAt: now,
  };
}

export function emptyLibrary() {
  return { schemaVersion: LIBRARY_SCHEMA_VERSION, revision: 0, profiles: {} };
}

// 指纹覆盖全部会进入 Claude 投影的字段（端点/模型/开关/自定义 env/透传 settings），
// 与时间戳无关——库改了但投影相关字段没改时不应重写项目文件。
export function libraryFingerprint(profile) {
  const payload = {
    endpoint: profile.endpoint,
    models: profile.models,
    toggles: profile.toggles,
    env: profile.env,
    claude: profile.claude,
  };
  return `sha256:${hashContent(canonicalJson(payload))}`;
}
