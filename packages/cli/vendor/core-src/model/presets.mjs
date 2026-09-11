// 内置预设：只预填端点与 API 类型。绝不预填模型 ID（服务商模型 ID 变动频繁，写死立刻过期）。
// 实现时按各家官方文档核对 baseUrl；磁贴下方必须提示"预设只是起点，请以服务商文档为准"。
export const PRESETS = [
  { id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com", api: "anthropic" },
  { id: "xiaomi-mimo", label: "小米 MiMo", baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic", api: "anthropic" },
  { id: "moonshot-kimi", label: "Moonshot Kimi", baseUrl: "https://api.moonshot.cn/anthropic", api: "anthropic" },
  { id: "zhipu", label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/anthropic", api: "anthropic" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", api: "openai-chat" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", api: "openai-responses" },
];

export function applyPreset(id) {
  const preset = PRESETS.find((entry) => entry.id === id);
  return preset ? { ...preset } : null;
}
