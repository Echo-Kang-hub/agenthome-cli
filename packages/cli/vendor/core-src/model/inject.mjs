import { fail } from "../util/fail.mjs";

// 注入契约（spec §5.2/§5.3）：
//   Codex     → 启动 argv（-c 键值对 + -m），值一律不加引号
//   OpenCode  → OPENCODE_CONFIG_CONTENT（运行时覆盖，优先级高于项目 opencode.json）
//   Claude    → 环境变量兜底（settings 文件的 env 会覆盖同名 shell 变量，因此同时注入无副作用）
// 全部由 core 生成：CLI 与插件只把结果交给 spawn / terminal。

function endpointFor(profile, agentId) {
  return profile.overrides?.[agentId] ?? profile.endpoint;
}

export function agentCompatibility(profile) {
  const codexEndpoint = profile.overrides?.codex ?? null;
  const codexOk = Boolean(codexEndpoint);
  return {
    claude: { ok: true },
    codex: codexOk
      ? { ok: true }
      : { ok: false, reason: "Codex 需要 Responses API 端点（openai-responses）；该配置只有 Anthropic 端点" },
    opencode: { ok: true },
  };
}

function hasFlag(argumentsList, names) {
  return argumentsList.some((argument) => names.includes(argument) || names.some((name) => argument.startsWith(`${name}=`)));
}

export function codexInjection(profile, options = {}) {
  const argumentsList = [...(options.argumentsList ?? [])];
  const environment = { ...(options.environment ?? {}) };
  const skipped = [];
  if (!agentCompatibility(profile).codex.ok) {
    fail(`Codex does not support this profile: ${profile.name}`);
  }
  environment[profile.codex.envKey] = profile.endpoint.apiKey;
  const endpoint = endpointFor(profile, "codex");
  const providerId = profile.overrides?.codex?.providerId ?? profile.codex.providerId;
  const pairs = [];
  // 用户自带 model_provider= 时 provider 单元整体让位：只跳过 model_provider 而照旧注入
  // model_providers.<id>.* 定义，会让用户指定的 provider 配上 Avenic 的模型（错配）。
  // -m/--model 仍单独判定：用户没传 -m 时主模型照旧注入。
  const hasProvider = argumentsList.some((argument) => argument === "model_provider" || argument.startsWith("model_provider="));
  if (hasProvider) {
    skipped.push("model_provider");
  } else {
    pairs.push(["model_provider", providerId]);
    pairs.push(["model_providers.%ID%.name".replace("%ID%", providerId), profile.name]);
    pairs.push(["model_providers.%ID%.base_url".replace("%ID%", providerId), endpoint.baseUrl]);
    pairs.push(["model_providers.%ID%.env_key".replace("%ID%", providerId), profile.codex.envKey]);
    pairs.push(["model_providers.%ID%.wire_api".replace("%ID%", providerId), "responses"]);
  }
  const injection = pairs.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
  if (hasFlag(argumentsList, ["-m", "--model"])) {
    skipped.push("model");
  } else if (profile.models?.main) {
    injection.push("-m", profile.models.main.id);
  }
  // argv 里不允许出现引号：Windows 上引号会变成字面量、POSIX 上有类型含义（spec §3.1）
  for (const argument of injection) {
    if (argument.includes('"')) fail(`Refusing to inject a quoted Codex argument: ${argument}`);
  }
  argumentsList.unshift(...injection);
  return { argumentsList, environment, skipped };
}

export function opencodeInjection(profile, environment = {}) {
  const endpoint = endpointFor(profile, "opencode");
  const mainModel = profile.models?.main?.id ?? null;
  const smallModel = profile.models?.haiku?.id ?? null;
  const merged = { ...environment };
  if (endpoint.api === "anthropic") {
    // 官方支持覆盖内置 anthropic provider 的 options.baseURL / options.apiKey（spec §3.1）
    const providerId = "anthropic";
    const config = {
      model: mainModel ? `${providerId}/${mainModel}` : undefined,
      small_model: smallModel ? `${providerId}/${smallModel}` : undefined,
      provider: {
        [providerId]: {
          options: { baseURL: endpoint.baseUrl, apiKey: endpoint.apiKey },
        },
      },
    };
    merged.OPENCODE_CONFIG_CONTENT = JSON.stringify(stripUndefined(config));
    return { environment: merged, providerId, mode: "builtin-override" };
  }
  const providerId = profile.opencode.providerId;
  const models = {};
  for (const id of new Set([mainModel, smallModel].filter(Boolean))) {
    models[id] = {};
  }
  const config = {
    model: mainModel ? `${providerId}/${mainModel}` : undefined,
    small_model: smallModel ? `${providerId}/${smallModel}` : undefined,
    provider: {
      [providerId]: {
        npm: profile.opencode.npmAdapter,
        name: profile.name,
        options: { baseURL: endpoint.baseUrl, apiKey: endpoint.apiKey },
        models,
      },
    },
  };
  merged.OPENCODE_CONFIG_CONTENT = JSON.stringify(stripUndefined(config));
  return { environment: merged, providerId, mode: "custom-provider" };
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, stripUndefined(item)]),
    );
  }
  return value;
}

// Claude 的环境变量兜底：settings.local.json 的 env 会覆盖同名 shell 变量（§3.1），
// 因此文件存在时这条注入不改变行为；project 认证下 Claude 若不读项目 settings（§3.3 实测项 2），
// 这条注入就是唯一生效路径。
export function claudeEnvironment(profile) {
  const values = {
    ANTHROPIC_BASE_URL: profile.endpoint.baseUrl,
    [profile.endpoint.authField]: profile.endpoint.apiKey,
    ANTHROPIC_MODEL: profile.models?.main?.id,
  };
  const roles = { opus: "OPUS", sonnet: "SONNET", haiku: "HAIKU", fable: "FABLE" };
  for (const [role, suffix] of Object.entries(roles)) {
    const row = profile.models?.[role];
    if (!row) continue;
    values[`ANTHROPIC_DEFAULT_${suffix}_MODEL`] = row.longContext ? `${row.id}[1m]` : row.id;
    if (row.display) values[`ANTHROPIC_DEFAULT_${suffix}_MODEL_NAME`] = row.display;
  }
  if (profile.models?.subagent) values.CLAUDE_CODE_SUBAGENT_MODEL = profile.models.subagent.id;
  return stripUndefined(values);
}

export function buildLaunchInjection({ agentId, profile, argumentsList = [], environment = {} }) {
  if (!profile) {
    return { argumentsList, environment, note: null };
  }
  const compatibility = agentCompatibility(profile);
  if (agentId === "claude") {
    return { argumentsList, environment: { ...environment, ...claudeEnvironment(profile) }, note: null };
  }
  if (agentId === "opencode") {
    const injected = opencodeInjection(profile, environment);
    return { argumentsList, environment: injected.environment, note: null };
  }
  if (agentId === "codex") {
    if (!compatibility.codex.ok) {
      return {
        argumentsList,
        environment,
        note: `Codex does not support this profile (${compatibility.codex.reason}) — using its global configuration.`,
      };
    }
    const injected = codexInjection(profile, { argumentsList, environment });
    return { argumentsList: injected.argumentsList, environment: injected.environment, note: null };
  }
  return { argumentsList, environment, note: null };
}
