// 粘贴识别：纯函数、无 IO，供 CLI（--json）、插件与测试共用（spec §10）。
// 原则：多候选全部列出、绝不静默取第一个；识别不出模型名就留空并提示。

const BASE_URL_KEY = /^(ANTHROPIC_BASE_URL|BASE_URL|API_BASE|base_?url|api_?base)$/i;
const API_KEY_KEY = /^(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|API_?KEY|AUTH_?TOKEN|TOKEN)$/i;
const MODEL_KEY = /(^|_)(MODEL|MODEL_NAME)$/i;
const ROLE_PREFIX = [
  ["opus", /(^|_)(OPUS)(_|$)/i],
  ["sonnet", /(^|_)(SONNET)(_|$)/i],
  ["haiku", /(^|_)(HAIKU)(_|$)/i],
  ["fable", /(^|_)(FABLE)(_|$)/i],
  ["subagent", /(^|_)(SUBAGENT)(_|$)/i],
];
const FREE_KEY = /sk-[A-Za-z0-9_-]{8,}/;
const FREE_URL = /https?:\/\/[^\s"'`<>]+/;
// 掩码形态：core 的 maskSecret 是「前 3 + … + 后 4」（过短是 ••••），另外用户还会从别处
// 粘来 `sk-***abcd` 这种。真实密钥只会是 [A-Za-z0-9._-]，命中这里的一定不是密钥。
// 把它当密钥存下来 = 从此每次请求都拿掩码当凭据（spec §7「不要把掩码当成表单值」）。
const MASKED_VALUE = /[…•]|\*{3}/;

function roleFor(key) {
  for (const [role, pattern] of ROLE_PREFIX) {
    if (pattern.test(key)) return role;
  }
  return "main";
}

export function recognizeEnvMap(env) {
  const candidates = { baseUrl: [], apiKey: [] };
  const models = {};
  const warnings = [];
  for (const [key, raw] of Object.entries(env)) {
    const value = String(raw).trim().replace(/^["']|["']$/g, "");
    if (!value) continue;
    if (BASE_URL_KEY.test(key)) {
      candidates.baseUrl.push(value);
      continue;
    }
    if (API_KEY_KEY.test(key)) {
      // 掩码不是密钥：剔除并说明，别让用户以为"识别到了但没生效"。
      if (MASKED_VALUE.test(value)) {
        warnings.push(`${key} 的值看起来是掩码（${value}），不是完整密钥：已忽略，请粘贴完整密钥或留空后手工填写`);
        continue;
      }
      candidates.apiKey.push(value);
      continue;
    }
    if (MODEL_KEY.test(key)) {
      const role = roleFor(key);
      (models[role] ??= []).push(value);
    }
  }
  const recognized = [];
  if (candidates.baseUrl.length > 0) recognized.push({ field: "baseUrl", value: candidates.baseUrl[0] });
  if (candidates.apiKey.length > 0) recognized.push({ field: "apiKey", value: candidates.apiKey[0] });
  for (const [role, values] of Object.entries(models)) {
    recognized.push({ field: `${role}Model`, value: values[0] });
  }
  return { recognized, candidates: { ...candidates, ...models }, warnings };
}

function flatLookup(source) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

export function parseConfigJson(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot parse JSON: ${error.message}`);
  }
  let recognized = [];
  let candidates = {};
  let warnings = [];
  let passthrough = {};
  let form = "unknown";
  const settings = raw?.env && typeof raw.env === "object" ? raw : raw?.settingsConfig?.env ? raw.settingsConfig : null;
  if (settings) {
    form = raw === settings ? "claude-settings" : "cc-switch";
    ({ recognized, candidates, warnings } = recognizeEnvMap(settings.env));
    passthrough = Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "env"));
    return { form, recognized, passthrough, candidates, warnings };
  }
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    form = "flat";
    ({ recognized, candidates, warnings } = recognizeEnvMap(flatLookup(raw)));
    return { form, recognized, passthrough, candidates, warnings };
  }
  return { form, recognized, passthrough, candidates, warnings };
}

export function parseConfigText(text) {
  const source = String(text ?? "");
  const lines = source.split(/\r?\n/);
  const env = {};
  for (const line of lines) {
    const assignment = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.+?)\s*$/);
    if (assignment) {
      env[assignment[1]] = assignment[2].replace(/^["']|["']$/g, "");
      continue;
    }
    // 自由文本：`地址 https://…` / `密钥 sk-…` / `主模型 kimi-k2`
    const model = line.match(/(?:model|模型)\s*[:：=]?\s*([A-Za-z0-9._:\-/]{2,128})/i);
    if (model) env[`${roleFor(line)}_MODEL`] ??= model[1];
  }
  // 整段兜底：用能被锚定正则命中的真实键名；已有匹配键时不重复添加候选。
  if (!Object.keys(env).some((key) => BASE_URL_KEY.test(key))) {
    const url = source.match(FREE_URL);
    if (url) env.BASE_URL = url[0];
  }
  if (!Object.keys(env).some((key) => API_KEY_KEY.test(key))) {
    const key = source.match(FREE_KEY);
    if (key) env.API_KEY = key[0];
  }
  const { recognized, candidates, warnings } = recognizeEnvMap(env);
  if (!recognized.some((entry) => entry.field.endsWith("Model"))) {
    warnings.push("未识别到模型名（model），请在表单中手工填写");
  }
  for (const entry of recognized) {
    entry.source = "pasted";
  }
  return { recognized, candidates, warnings };
}
