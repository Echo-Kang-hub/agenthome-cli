import { validateBaseUrl } from "./schema.mjs";

// 最小真实请求（spec §11）：会向用户填写的地址发一次请求、消耗极少量额度。
// avenic 没有服务端；密钥只发往该地址。测试只打本地 mock server。

const DEFAULT_TIMEOUT_MS = 15_000;

function resolveUrl(baseUrl, path) {
  const base = validateBaseUrl(baseUrl).replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}${path}` : `${base}/v1${path}`;
}

// API 类型 → 请求路径。**只有这一张表**：requestFor 与对外的 probeUrl 共用它，
// 面板的「将请求：<地址>」预览因此不需要自己抄一份映射（设计 §9.3 / §9.7）。
const REQUEST_PATHS = {
  anthropic: "/messages",
  "openai-responses": "/responses",
  "openai-chat": "/chat/completions",
};

// 导出给面板做实时预览：给定端点的 Base URL 与 API 类型，返回测试连接真正请求的地址。
// 与 probe 走同一条校验路径（无效 Base URL 会抛），调用方负责转成界面提示。
export function probeUrl(baseUrl, api) {
  return resolveUrl(baseUrl, REQUEST_PATHS[api] ?? REQUEST_PATHS["openai-chat"]);
}

function requestFor(api, baseUrl, model, apiKey, authField) {
  if (api === "anthropic") {
    return {
      url: probeUrl(baseUrl, api),
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(authField === "ANTHROPIC_API_KEY" ? { "x-api-key": apiKey } : { authorization: `Bearer ${apiKey}` }),
      },
      body: { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
    };
  }
  if (api === "openai-responses") {
    return {
      url: probeUrl(baseUrl, api),
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: { model, input: "ping", max_output_tokens: 16 },
    };
  }
  return {
    url: probeUrl(baseUrl, api),
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
  };
}

function categoryFor(status) {
  if (status >= 200 && status < 300) return "2xx";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "server-error";
  return "server-error";
}

const MESSAGES = {
  auth: "密钥无效或没有权限（401/403）",
  "not-found": "路径不存在（404）——检查 Base URL 是否需要/需要去掉 /v1 段",
  "rate-limited": "被限流或配额用尽（429）",
  "server-error": "服务端错误",
  network: "网络 / DNS / TLS 不可达",
  timeout: "请求超时，未收到响应",
};

export async function testConnection(profile, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endpoint = options.endpoint ?? profile.endpoint;
  const model = profile.models?.main?.id ?? options.model;
  if (!model) {
    return { ok: false, category: "server-error", status: null, durationMs: 0, model: null, usage: null, message: "配置里没有主模型，无法测试（服务商模型 ID 需手工填写）", url: null };
  }
  const request = requestFor(endpoint.api, endpoint.baseUrl, model, endpoint.apiKey, endpoint.authField);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await (options.fetch ?? fetch)(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
    const durationMs = Date.now() - startedAt;
    const text = await response.text().catch(() => "");
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    const category = categoryFor(response.status);
    const ok = category === "2xx";
    const message = ok
      ? `连接成功（${durationMs} ms）`
      : `${MESSAGES[category]}（HTTP ${response.status}）—— 连接失败 ≠ 密钥无效，请对照状态码排查`;
    return {
      ok,
      category,
      status: response.status,
      durationMs,
      model: payload?.model ?? null,
      usage: payload?.usage ?? null,
      message,
      url: request.url,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const category = error?.name === "AbortError" ? "timeout" : "network";
    return {
      ok: false,
      category,
      status: null,
      durationMs,
      model: null,
      usage: null,
      message: `${MESSAGES[category]}—— 连接失败 ≠ 密钥无效`,
      url: request.url,
    };
  } finally {
    clearTimeout(timer);
  }
}
