import { isDeepStrictEqual } from "node:util";
import { fail } from "../util/fail.mjs";

// Claude Code 走"项目内物化投影"：把库里的 profile 合并写进 .claude/settings.local.json，
// 并逐条记账（before/written）以便精确回滚（spec §5.1/§6）。
// 所有值转字符串：Claude Code 的 settings.env 只接受字符串。

// 只有普通对象可以下钻：数组/标量都不能承载投影键（数组上的非索引键会被 JSON.stringify 丢弃）。
export const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

export function jsonTypeName(value) {
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  return `a ${typeof value}`;
}

// 账本（merge/rollback）与精确回滚都假设路径唯一：重复路径或前缀包含路径必须响亮失败，
// 不能静默去重——否则解绑回滚会留下投影值（含密钥）或覆盖用户对象（spec §6/§12）。
function assertNoConflictingPaths(entries, source) {
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const left = entries[i].path;
      const right = entries[j].path;
      const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
      if (!shorter.every((segment, index) => longer[index] === segment)) continue;
      if (left.length === right.length) fail(`${source}: ${left.join(".")} is written twice`);
      fail(`${source}: ${shorter.join(".")} and ${longer.join(".")} overlap (one path contains the other)`);
    }
  }
}

// 有 `ANTHROPIC_DEFAULT_<SUFFIX>_MODEL` 别名的角色（main 写 ANTHROPIC_MODEL，subagent 写
// CLAUDE_CODE_SUBAGENT_MODEL，两者都没有别名）。**导出是给面板用的**：设计 §9.3 的「display
// name（where applicable）」的分界线就是这张表——只有这里列出的角色，display 才会被投影成
// `ANTHROPIC_DEFAULT_<SUFFIX>_MODEL_NAME`。面板若自己维护一份「哪几行有显示名输入框」，
// core 往表里加一个角色时界面会静默漏掉它（§9.7 禁止插件侧第二份业务逻辑）。
export const ROLE_KEYS = { opus: "OPUS", sonnet: "SONNET", haiku: "HAIKU", fable: "FABLE" };

// 开关 → 它实际写入的路径与值。**导出是给面板用的**：设计 §9.3 要求每个开关显示「实际写入的
// 键名」，而 §9.7 禁止插件维护第二份业务逻辑——所以这张表必须是唯一事实来源，由 core 导出，
// 面板只做 `path.join(".")`。表与 schema 的 TOGGLE_KEYS 一一对应，由 model-projection.test.mjs
// 逐行真跑投影钉住（不是靠人眼比对）。
export const TOGGLE_ENTRIES = [
  ["teams", ["env", "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"], "1"],
  ["toolSearch", ["env", "ENABLE_TOOL_SEARCH"], "true"],
  ["maxEffort", ["env", "CLAUDE_CODE_EFFORT_LEVEL"], "max"],
  ["noNonessentialTraffic", ["env", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"], "1"],
  ["noAutoUpdate", ["env", "DISABLE_AUTOUPDATER"], "1"],
  // hideAttribution 写的是顶层对象而非 env 键，所以它以前是循环外的特例。并入表内后行为不变
  // （它本来就是最后一个被 push 的），换来的是「6 个开关」在面板与实现眼里是同一张表。
  ["hideAttribution", ["attribution"], { commit: "", pr: "" }],
];

// 表里的值可能被多处共享（hideAttribution 是对象），而消费方会把它写进 content 或账本——
// 共享同一个对象实例迟早会被原地改掉，所以非标量一律先克隆再交出去。
const cloneValue = (value) => (value !== null && typeof value === "object" ? structuredClone(value) : value);

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
    if (profile.toggles?.[toggle] === true) push(path, cloneValue(value));
  }

  for (const [key, value] of Object.entries(profile.env ?? {})) env(key, String(value));
  for (const [key, value] of Object.entries(profile.claude?.settings ?? {})) push([key], value);
  // 同一路径写两次（如 env.ANTHROPIC_MODEL 撞 models.main），或 claude.settings 的顶层键
  // 恰好是受管子路径的前缀（如 env 包含整棵 env 投影）时，用户意图不可判定，且账本会失真
  // → 在任何写盘之前响亮失败，把选择权交还用户（spec §6 精确回滚 / §12 密钥策略）。
  assertNoConflictingPaths(entries, `Profile "${profile.id}" sets conflicting Claude settings`);
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
    if (!isPlainObject(cursor[key])) cursor[key] = {};
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
  if (!created && !isPlainObject(existing)) {
    fail(`Claude settings must be a JSON object, got ${jsonTypeName(existing)}`);
  }
  // 该 API 的隐含契约是路径唯一（账本按路径判定回滚），在函数自己身上兜底。
  assertNoConflictingPaths(entries, "Claude settings entries conflict");
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
