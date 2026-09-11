import {
  buildClaudeEntries,
  normalizeProfile,
  validateBaseUrl,
  validateEnvKey,
  validateModelId,
  validateProviderId,
} from "@avenic/core";
import type { EndpointInput, ModelProfile, ModelProfileInput, ModelRole, ModelRow } from "@avenic/core";
import type { DraftIssue, ProfileDraft } from "./protocol.ts";

// vscode-free：草稿 → core 入参的翻译，以及**定位到具体输入**的校验（§5.5「由 core 判定并在
// UI 定位显示」）。校验规则本身全部来自 core（validateBaseUrl/validateEnvKey/validateModelId/
// validateProviderId/buildClaudeEntries），这里只负责把 core 的判定结果映射回草稿里的字段路径。

/** 面板只改覆盖里的端点与 providerId；apiKey/authField 由 host 从库里带过来。 */
type OverrideInput = EndpointInput & { providerId?: string };

/** 面板只能改覆盖里的端点与 providerId：密钥与认证字段永远沿用库中值（它们不进 webview）。 */
function overrideFrom(
  draft: ProfileDraft,
  existing: ModelProfile | null,
  agentId: "codex" | "opencode",
): OverrideInput | undefined {
  const draftOverride = draft.overrides[agentId];
  const existingOverride = existing?.overrides?.[agentId];
  if (!draftOverride && !existingOverride) return undefined;
  return {
    // 草稿没提供就退回库中值：面板没渲染的字段不得因为一次保存而消失。
    baseUrl: draftOverride?.baseUrl || existingOverride?.baseUrl || draft.baseUrl,
    api: draftOverride?.api || existingOverride?.api || draft.api,
    authField: existingOverride?.authField ?? draft.authField,
    apiKey: existingOverride?.apiKey ?? (draft.apiKey ?? existing?.endpoint.apiKey ?? ""),
    providerId: draftOverride?.providerId || existingOverride?.providerId,
  };
}

/**
 * 草稿 → 交给 core.normalizeProfile 的入参。
 *
 * 两个 `as` 都是**边界适配**，落在已经判定过的地方：角色名与 api 在协议层被 isDraft 按 core
 * 导出的清单白名单化过，normalizeProfile 运行时还会再校验一遍——所以这里不掩盖错误，只把
 * 「来自 webview 的 string 已经很窄」这件事告诉类型系统。
 */
export function profileInputFromDraft(draft: ProfileDraft, existing: ModelProfile | null): ModelProfileInput {
  const models: Partial<Record<ModelRole, ModelRow>> = {};
  for (const [role, row] of Object.entries(draft.models)) {
    // 输入框被清空 = 删除该角色。空行留给 core 会撞 validateModelId，所以在这里剔除。
    if (row.id.trim() === "") continue;
    const entry: ModelRow = { id: row.id.trim() };
    if (row.display !== undefined && row.display.trim() !== "") entry.display = row.display.trim();
    // longContext 原样带过：界面只为部分角色提供勾选框，其余角色上 CLI 写入的值不得被抹掉。
    if (row.longContext === true) entry.longContext = true;
    models[role as ModelRole] = entry;
  }
  const env: Record<string, string> = {};
  for (const row of draft.env) {
    const key = row.key.trim();
    if (key === "") continue;
    env[key] = row.value;
  }
  const overrides: NonNullable<ModelProfileInput["overrides"]> = {};
  for (const agentId of ["codex", "opencode"] as const) {
    const override = overrideFrom(draft, existing, agentId);
    if (override) overrides[agentId] = override;
  }
  const input: ModelProfileInput = {
    id: draft.id,
    name: draft.name,
    endpoint: {
      baseUrl: draft.baseUrl,
      api: draft.api,
      authField: draft.authField,
      // null = 保留库中现有密钥（§7：面板只回显掩码，永远不把明文发回前端）。
      apiKey: draft.apiKey ?? existing?.endpoint.apiKey ?? "",
    },
    overrides,
    models,
    toggles: Object.fromEntries(draft.toggles.filter((id) => id !== "").map((id) => [id, true] as const)),
    env,
    claude: { settings: { ...(existing?.claude?.settings ?? {}), ...(draft.passthrough ?? {}) } },
    // 留空的 providerId / envKey / npmAdapter 直接**不传**：core 的 ?? 只认 null/undefined，
    // 传空串会撞 validateProviderId。不传 = 用 core 的默认值（新建配置走的就是这条）。
    codex: {
      ...(draft.codex.providerId.trim() !== "" ? { providerId: draft.codex.providerId } : {}),
      ...(draft.codex.envKey.trim() !== "" ? { envKey: draft.codex.envKey } : {}),
      reasoningEffort: draft.codex.reasoningEffort,
    },
    opencode: {
      ...(draft.opencode.providerId.trim() !== "" ? { providerId: draft.opencode.providerId } : {}),
      ...(draft.opencode.npmAdapter.trim() !== "" ? { npmAdapter: draft.opencode.npmAdapter } : {}),
    },
  };
  return input;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** core 认定的受管 env 键（端点/模型/开关写进去的那批），用来把「与受管 env 冲突」定位到行。 */
function managedEnvKeys(input: ModelProfileInput): Set<string> {
  // 去掉自定义 env 与透传键再投影一次：此时不可能冲突，能拿到"不含用户 env"的受管键集合。
  const profile = normalizeProfile({ ...input, env: {}, claude: { settings: {} } });
  const keys = new Set<string>();
  for (const entry of buildClaudeEntries(profile)) {
    if (entry.path.length === 2 && entry.path[0] === "env") keys.add(entry.path[1]);
  }
  return keys;
}

/**
 * 逐条校验草稿，返回**可定位**的问题（field 用草稿里的点分路径）。
 * 空数组 = 没有任何已知问题（不代表写盘一定成功：并发/IO 失败仍由 saveProfile 抛）。
 */
export function draftIssues(draft: ProfileDraft, existing: ModelProfile | null): DraftIssue[] {
  const issues: DraftIssue[] = [];

  // core 容忍空名称（它会退回 id），但卡片列表就是按名称认人的，所以空名字在这里拦下。
  if (draft.name.trim() === "") issues.push({ field: "name", message: "名称必填" });
  try {
    validateBaseUrl(draft.baseUrl);
  } catch (error) {
    issues.push({ field: "baseUrl", message: messageOf(error) });
  }
  for (const [role, row] of Object.entries(draft.models)) {
    if (row.id.trim() === "") continue;
    try {
      validateModelId(row.id);
    } catch (error) {
      issues.push({ field: `models.${role}.id`, message: messageOf(error) });
    }
  }
  for (const [field, value] of [["codex.providerId", draft.codex.providerId], ["opencode.providerId", draft.opencode.providerId]] as const) {
    try {
      validateProviderId(value);
    } catch (error) {
      issues.push({ field, message: messageOf(error) });
    }
  }
  for (const [agentId, override] of Object.entries(draft.overrides)) {
    if (override.baseUrl === undefined || override.baseUrl === "") continue;
    try {
      validateBaseUrl(override.baseUrl);
    } catch (error) {
      issues.push({ field: `overrides.${agentId}.baseUrl`, message: messageOf(error) });
    }
  }

  // 自定义 env：键名合法性与重复键都在 core 判定，问题挂在具体行上（§5.5）。
  const seen = new Map<string, number>();
  draft.env.forEach((row, index) => {
    const key = row.key.trim();
    if (key === "") return;
    try {
      validateEnvKey(key);
    } catch (error) {
      issues.push({ field: `env.${index}.key`, message: messageOf(error) });
    }
    const first = seen.get(key);
    if (first === undefined) seen.set(key, index);
    else issues.push({ field: `env.${index}.key`, message: `环境变量 ${key} 重复（第 ${first + 1} 行已经用过）` });
  });
  if (issues.length > 0) return issues; // 行级问题优先：带病的输入投影出来只会是噪声。

  const input = profileInputFromDraft(draft, existing);
  try {
    const managed = managedEnvKeys(input);
    draft.env.forEach((row, index) => {
      const key = row.key.trim();
      if (key !== "" && managed.has(key)) {
        issues.push({ field: `env.${index}.key`, message: `${key} 由 Avenic 管理（端点/模型/开关会写它），不能作为自定义环境变量` });
      }
    });
    if (issues.length > 0) return issues;
    // 最后让 core 真跑一遍投影：透传键与受管路径重叠之类的问题只有它看得出来。
    buildClaudeEntries(normalizeProfile(input));
  } catch (error) {
    issues.push({ field: "passthrough", message: messageOf(error) });
  }
  return issues;
}
