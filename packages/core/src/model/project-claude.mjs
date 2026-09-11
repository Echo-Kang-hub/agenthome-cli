import { isDeepStrictEqual } from "node:util";

// Claude Code 走"项目内物化投影"：把库里的 profile 合并写进 .claude/settings.local.json，
// 并逐条记账（before/written）以便精确回滚（spec §5.1/§6）。
// 所有值转字符串：Claude Code 的 settings.env 只接受字符串。

const ROLE_KEYS = { opus: "OPUS", sonnet: "SONNET", haiku: "HAIKU", fable: "FABLE" };
const TOGGLE_ENTRIES = [
  ["teams", ["env", "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"], "1"],
  ["toolSearch", ["env", "ENABLE_TOOL_SEARCH"], "true"],
  ["maxEffort", ["env", "CLAUDE_CODE_EFFORT_LEVEL"], "max"],
  ["noNonessentialTraffic", ["env", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"], "1"],
  ["noAutoUpdate", ["env", "DISABLE_AUTOUPDATER"], "1"],
];

export function buildClaudeEntries(profile) {
  const entries = [];
  const push = (path, value) => entries.push({ path, value });
  const env = (key, value) => push(["env", key], value);

  env("ANTHROPIC_BASE_URL", profile.endpoint.baseUrl);
  if (profile.endpoint.apiKey) env(profile.endpoint.authField, profile.endpoint.apiKey);

  const models = profile.models ?? {};
  if (models.main) env("ANTHROPIC_MODEL", models.main.id);
  for (const [role, suffix] of Object.entries(ROLE_KEYS)) {
    const row = models[role];
    if (!row) continue;
    const id = row.longContext ? `${row.id}[1m]` : row.id;
    env(`ANTHROPIC_DEFAULT_${suffix}_MODEL`, id);
    if (row.display) env(`ANTHROPIC_DEFAULT_${suffix}_MODEL_NAME`, row.display);
  }
  if (models.subagent) env("CLAUDE_CODE_SUBAGENT_MODEL", models.subagent.id);

  for (const [toggle, path, value] of TOGGLE_ENTRIES) {
    if (profile.toggles?.[toggle] === true) push(path, value);
  }
  if (profile.toggles?.hideAttribution === true) push(["attribution"], { commit: "", pr: "" });

  for (const [key, value] of Object.entries(profile.env ?? {})) env(key, String(value));
  for (const [key, value] of Object.entries(profile.claude?.settings ?? {})) push([key], value);
  return entries;
}

export function readPath(object, pathArray) {
  let cursor = object;
  for (const key of pathArray) {
    if (cursor === null || typeof cursor !== "object" || !Object.hasOwn(cursor, key)) {
      return { exists: false };
    }
    cursor = cursor[key];
  }
  return { exists: true, value: cursor };
}

export function writePath(object, pathArray, value) {
  let cursor = object;
  for (const key of pathArray.slice(0, -1)) {
    if (cursor[key] === null || typeof cursor[key] !== "object") cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[pathArray.at(-1)] = value;
}

export function deletePath(object, pathArray) {
  let cursor = object;
  for (const key of pathArray.slice(0, -1)) {
    if (cursor?.[key] === null || typeof cursor?.[key] !== "object") return;
    cursor = cursor[key];
  }
  delete cursor[pathArray.at(-1)];
}

// 合并写：只动本次受管的键，其余（permissions/hooks/statusLine/未知键）原样保留。
export function mergeClaudeSettings(existing, entries) {
  const created = existing === null || existing === undefined;
  const content = created ? {} : structuredClone(existing);
  const ledger = [];
  for (const entry of entries) {
    const before = readPath(content, entry.path);
    writePath(content, entry.path, entry.value);
    ledger.push({
      path: entry.path,
      before: before.exists ? { exists: true, value: structuredClone(before.value) } : { exists: false },
      written: structuredClone(entry.value),
    });
  }
  return { content, ledger, created };
}

// 逐条判定：当前值 === written → 还原 before（或删键）；否则记为 conflict 一律不动（spec §6）。
export function rollbackClaudeSettings(existing, ledger) {
  const content = existing === null || existing === undefined ? {} : structuredClone(existing);
  const conflicts = [];
  for (const entry of ledger ?? []) {
    const current = readPath(content, entry.path);
    const matches = current.exists === true && isDeepStrictEqual(current.value, entry.written);
    if (!matches) {
      conflicts.push({ path: entry.path, current: current.exists ? current.value : undefined });
      continue;
    }
    if (entry.before.exists) {
      writePath(content, entry.path, structuredClone(entry.before.value));
    } else {
      deletePath(content, entry.path);
    }
  }
  return { content, conflicts };
}
