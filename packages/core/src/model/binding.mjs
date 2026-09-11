import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readJson } from "../util/json.mjs";
import { fail } from "../util/fail.mjs";
import { transact } from "./transaction.mjs";
import { getProfile } from "./library.mjs";
import { LOCK_TIMEOUT_CODE, withProjectLock } from "./lock.mjs";
import { ensureModelGitignore } from "./gitignore.mjs";
import { restrictPermissions } from "./permissions.mjs";
import { libraryFingerprint } from "./schema.mjs";
import {
  CLAUDE_SETTINGS_FILE,
  PROJECT_SCHEMA_VERSION,
  claudeSettingsFile,
  projectModelFile,
  projectTempRoot,
} from "./paths.mjs";
import {
  buildClaudeEntries,
  isPlainObject,
  jsonTypeName,
  mergeClaudeSettings,
  rollbackClaudeSettings,
} from "./project-claude.mjs";

export function danglingMessage(profileId) {
  return `Profile "${profileId}" no longer exists; Avenic configuration disabled for this project.`;
}

function emptyBinding() {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    revision: 0,
    activeProfileId: null,
    overrides: {},
    projection: {},
  };
}

function malformedBinding(file, reason) {
  fail(`Project model binding is malformed: ${file} — ${reason}`);
}

// 逐字段形状校验（WARN-1）：合法 JSON 但字段类型错位不能被静默归一化——账本会被改写，
// 精确回滚随之失真（entries 非数组时 clear 曾抛裸 TypeError: pathArray is not iterable）。
// 任何不符 → 带文件路径与原因响亮失败，且绝不改写用户文件（spec §13）。
function assertBindingShape(raw, file) {
  if (!isPlainObject(raw)) {
    malformedBinding(file, `expected a JSON object, got ${jsonTypeName(raw)}`);
  }
  if (raw.activeProfileId !== undefined && raw.activeProfileId !== null && typeof raw.activeProfileId !== "string") {
    malformedBinding(file, `activeProfileId must be a string or null, got ${jsonTypeName(raw.activeProfileId)}`);
  }
  if (raw.overrides !== undefined) {
    if (!isPlainObject(raw.overrides)) {
      malformedBinding(file, `overrides must be an object, got ${jsonTypeName(raw.overrides)}`);
    }
    // spec §4.2 的"项目字段级覆盖"在 v1 既无写入方也无消费方（合并规则属发明，风险高于收益）。
    // 静默忽略会造成"用户手改 overrides 以为换了模型、实际没换"的静默失效——与数组中间件
    // 导致投影静默失效同类。非空即响亮失败并给出替代做法；{} 与缺省是默认形状，不得误报。
    if (Object.keys(raw.overrides).length > 0) {
      fail(`Project overrides are not supported in this version: ${file} (edit the profile in the model library instead)`);
    }
  }
  if (raw.projection !== undefined && !isPlainObject(raw.projection)) {
    malformedBinding(file, `projection must be an object, got ${jsonTypeName(raw.projection)}`);
  }
  const claude = raw.projection?.claude;
  if (claude === undefined) return;
  if (!isPlainObject(claude)) {
    malformedBinding(file, `projection.claude must be an object, got ${jsonTypeName(claude)}`);
  }
  if (claude.entries === undefined) return;
  if (!Array.isArray(claude.entries)) {
    malformedBinding(file, `projection.claude.entries must be an array, got ${jsonTypeName(claude.entries)}`);
  }
  claude.entries.forEach((entry, index) => {
    const at = `projection.claude.entries[${index}]`;
    if (!isPlainObject(entry)) malformedBinding(file, `${at} must be an object, got ${jsonTypeName(entry)}`);
    if (!Array.isArray(entry.path) || entry.path.some((segment) => typeof segment !== "string")) {
      malformedBinding(file, `${at}.path must be an array of strings`);
    }
    if (!isPlainObject(entry.before) || typeof entry.before.exists !== "boolean") {
      malformedBinding(file, `${at}.before must be an object with a boolean exists`);
    }
  });
}

export async function readBinding(projectRoot) {
  const file = projectModelFile(projectRoot);
  if (!existsSync(file)) {
    return { value: emptyBinding(), exists: false, file };
  }
  const raw = await readJson(file);
  assertBindingShape(raw, file);
  return {
    value: {
      schemaVersion: raw.schemaVersion ?? PROJECT_SCHEMA_VERSION,
      revision: Number.isInteger(raw.revision) ? raw.revision : 0,
      activeProfileId: raw.activeProfileId ?? null,
      overrides: raw.overrides ?? {},
      projection: raw.projection ?? {},
    },
    exists: true,
    file,
  };
}

async function readClaudeSettings(projectRoot) {
  const file = claudeSettingsFile(projectRoot);
  if (!existsSync(file)) return null; // 文件不存在 → 「无既有设置」（created === true），不是错误
  const parsed = await readJson(file); // 解析失败 → fail（不自动修复、不覆盖：spec §13）
  // 根节点不是普通对象（数组/标量/null）同样属于配置损坏：读的时候就失败，
  // 且必须早于任何写盘，否则投影会被挂到数组上并在落盘时静默消失。
  if (!isPlainObject(parsed)) {
    fail(`Claude settings are malformed (expected a JSON object, got ${jsonTypeName(parsed)}): ${file}`);
  }
  return parsed;
}

// spec §6 收尾：只有本功能创建的文件才允许删除；"无残留"= 除了我们自己写空的壳以外没有任何内容。
// 叶子（字符串/数字/布尔/null/数组）一律视作内容；空数组算内容，空对象不算。
function isResidualEmpty(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).every((key) => isResidualEmpty(value[key]));
}

// 项目事务：库文件不在同一个卷上，因此项目写入（绑定 + 投影）永远是独立事务。
// staged 必须落在事务自己的目录里（transact 的第二个参数），不能全项目共享固定路径。
async function stageProjectFiles(projectRoot, next, directory) {
  const replacements = [];
  replacements.push({
    relativePath: "model.json",
    staged: await stageFile(directory, "model.json", next.binding),
    target: projectModelFile(projectRoot),
  });
  if (next.settings === null) {
    replacements.push({ relativePath: "settings.local.json", remove: true, target: claudeSettingsFile(projectRoot) });
  } else {
    replacements.push({
      relativePath: "settings.local.json",
      staged: await stageFile(directory, "settings.local.json", next.settings),
      target: claudeSettingsFile(projectRoot),
    });
  }
  return replacements;
}

async function stageFile(directory, name, value) {
  const staged = path.join(directory, "staged", name);
  await mkdir(path.dirname(staged), { recursive: true });
  await writeFile(staged, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return staged;
}

// 项目侧替换：settings 为 null 表示"删除该文件"（仅当 created === true 且回滚后为空）。
// 其余与 replaceStagedFiles 同语义：先备份 → 再 rename → 任一步失败则整体回滚。
// 导出仅为测试注入点（index.mjs 不公开它）：WARN-5 的项目回滚用例需要把"第二个文件替换失败"
// 确定性注入到这条路径里。
export async function commitProject(replacements, directory) {
  const { mkdir, rename, rm } = await import("node:fs/promises");
  const completed = [];
  try {
    for (const replacement of replacements) {
      const backup = path.join(directory, "backup", replacement.relativePath);
      await mkdir(path.dirname(backup), { recursive: true });
      let hasBackup = false;
      if (existsSync(replacement.target)) {
        await rename(replacement.target, backup);
        hasBackup = true;
      }
      if (replacement.remove) {
        completed.push({ ...replacement, backup, hasBackup, removed: true });
        continue;
      }
      await mkdir(path.dirname(replacement.target), { recursive: true });
      try {
        await rename(replacement.staged, replacement.target);
      } catch (error) {
        if (hasBackup) await rename(backup, replacement.target);
        throw error;
      }
      completed.push({ ...replacement, backup, hasBackup });
    }
  } catch (error) {
    for (const replacement of completed.reverse()) {
      await rm(replacement.target, { recursive: true, force: true });
      if (replacement.hasBackup && existsSync(replacement.backup)) {
        await rename(replacement.backup, replacement.target);
      }
    }
    throw error;
  }
}

// 项目事务成功后重申 0600：staged 文件是 writeFile 默认权限（0644），rename 会把它带上目标，
// 所以每次写盘后都必须重新收紧。含 no-op 路径（修复旧版本遗留的 644，幂等；chmod 不改 mtime）。
async function protectProjectFiles(projectRoot, io) {
  for (const file of [projectModelFile(projectRoot), claudeSettingsFile(projectRoot)]) {
    if (existsSync(file)) await restrictPermissions(file, io);
  }
}

// 通用项目事务：read 同时读回绑定与投影文件，build 生成两份新内容（或 null = 不改）。
async function transactProject(projectRoot, build, io = console) {
  return transact({
    tempRoot: projectTempRoot(projectRoot),
    read: async () => {
      const binding = await readBinding(projectRoot);
      const settings = await readClaudeSettings(projectRoot);
      return { revision: binding.value.revision, value: { binding: binding.value, settings } };
    },
    build: (current) => build(current.value),
    stage: (next, directory) => stageProjectFiles(projectRoot, next, directory),
    commit: commitProject,
  }, io);
}

// 绑定 + 投影是一次事务：要么两份文件都更新，要么都不动。
export async function bindProject(projectRoot, environment, profileId, io = console) {
  const profile = await getProfile(environment, profileId);
  if (!profile) fail(`Unknown profile: ${profileId}`);
  // spec §12 第 3 条：绑定会写出 .agents/model.json（含用户原值/密钥指纹）与
  // .claude/settings.local.json（明文 API key），落盘前必须先保证项目 .gitignore 覆盖它们。
  // 失败必须响亮：写不进 .gitignore 就整个绑定失败，绝不把密钥写进一个未被 ignore 的路径。
  // 幂等由 ensureModelGitignore 保证（规则已在时零写入，不污染 mtime）。
  // 这里不能吞错（无 try/catch）；clearProjectBinding 也不得撤销这些规则——移除是 deinit 的职责（spec §12 第 4 条）。
  await ensureModelGitignore(projectRoot);
  const fingerprint = libraryFingerprint(profile);
  const entries = buildClaudeEntries(profile);
  let changed = false;
  // 写锁覆盖整个"读-改-写"：绑定与投影各自是两个文件，只有锁能挡住两条写路径的交错
  // （否则两个写者都能通过 revision 复查，最终留下绑定=A / 投影=B 的半写对）。
  const result = await withProjectLock(projectRoot, async () => {
    const result = await transactProject(projectRoot, (current) => {
      const projection = current.binding.projection?.claude ?? null;
      if (current.binding.activeProfileId === profileId && projection?.fingerprint === fingerprint) {
        return null; // 指纹一致 → 零写入（不刷新文件时间戳）
      }
      // 换绑：先把上一份投影安全回滚，再按新 profile 投影（避免残留上一个 profile 的键）
      const rolled = rollbackClaudeSettings(current.settings, projection?.entries ?? []);
      const merged = mergeClaudeSettings(rolled.content, entries);
      // 计划的 merged.created 不可用：rollbackClaudeSettings(null) 返回 {}（不是 null），
      // mergeClaudeSettings 因此把"功能新建的文件"误判为 created === false，
      // spec §6 的"created === true 才允许删除"将永远无法触发。created 必须看投影前的快照。
      const created = projection?.created ?? current.settings === null;
      changed = true;
      return {
        binding: {
          ...current.binding,
          revision: current.binding.revision + 1,
          activeProfileId: profileId,
          projection: {
            ...current.binding.projection,
            claude: {
              file: CLAUDE_SETTINGS_FILE,
              fingerprint,
              created,
              entries: merged.ledger,
            },
          },
        },
        settings: merged.content,
      };
    }, io);
    await protectProjectFiles(projectRoot, io);
    return result;
  }, { timeoutMs: 5000, io }); // 显式用户动作：超时响亮失败（模型绑定含明文 token，不能等太久）
  return {
    changed: result.changed && changed,
    binding: result.value.binding,
    projection: {
      file: CLAUDE_SETTINGS_FILE,
      fingerprint,
      keys: entries.length,
    },
  };
}

// 取消绑定：按账本安全回滚（用户改过的键不动），清空 entries，activeProfileId 置 null。
// 必须在项目写锁内执行：readBinding → transactProject.read 之间不允许别的写者插入。
// 本函数是**未加锁的内部实现**：withProjectLock 不可重入（同进程 per-project 串行队列，
// 嵌套调用会排队等自己），锁内的嵌套写路径只能调这里，不得再进 withProjectLock。
async function clearBindingLocked(projectRoot, environment, io) {
  const current = await readBinding(projectRoot);
  const projection = current.value.projection?.claude ?? null;
  if (!current.exists || (current.value.activeProfileId === null && !projection?.entries?.length)) {
    return { changed: false, conflicts: [], binding: current.value };
  }
  let conflicts = [];
  const result = await transactProject(projectRoot, (value) => {
    const settings = value.settings;
    const rolled = rollbackClaudeSettings(settings, projection?.entries ?? []);
    conflicts = rolled.conflicts;
    // created === true 且回滚后无残留 → 删除该文件（spec §6 收尾）。
    // 不能用 Object.keys(...).length === 0：deletePath 只删叶子、保留空父壳，
    // 回滚结果必然是 {env:{}} 这类形状，空对象判定永远为假。
    const shouldRemove = projection?.created === true && isResidualEmpty(rolled.content);
    return {
      binding: {
        ...value.binding,
        revision: value.binding.revision + 1,
        activeProfileId: null,
        projection: {
          ...value.binding.projection,
          claude: projection ? { file: projection.file, created: projection.created, entries: [] } : undefined,
        },
      },
      settings: shouldRemove ? null : rolled.content,
    };
  }, io);
  return { changed: result.changed, conflicts, binding: result.value.binding };
}

export async function clearProjectBinding(projectRoot, environment, io = console) {
  // 纯只读预检：项目没有绑定文件时无需取锁（也不得因此创建 .agents/）。
  const pre = await readBinding(projectRoot);
  if (!pre.exists) {
    return { changed: false, conflicts: [], binding: pre.value };
  }
  const result = await withProjectLock(
    projectRoot,
    () => clearBindingLocked(projectRoot, environment, io),
    { timeoutMs: 5000, io }, // 显式用户动作：拿不到锁响亮失败，交还用户重试
  );
  await protectProjectFiles(projectRoot, io);
  return result;
}

export async function projectModelStatus(projectRoot, environment) {
  const binding = (await readBinding(projectRoot)).value;
  const id = binding.activeProfileId;
  if (id === null) {
    return { projectRoot, binding, profile: null, dangling: false, projection: null, message: null };
  }
  const profile = await getProfile(environment, id);
  if (!profile) {
    return { projectRoot, binding, profile: null, dangling: true, projection: null, message: danglingMessage(id) };
  }
  const projection = binding.projection?.claude ?? null;
  return {
    projectRoot,
    binding,
    profile,
    dangling: false,
    projection: projection
      ? {
          file: projection.file,
          keys: projection.entries?.length ?? 0,
          fingerprint: projection.fingerprint ?? null,
          fingerprintMatches: projection.fingerprint === libraryFingerprint(profile),
        }
      : null,
    message: null,
  };
}

// 启动前调用：dangling 时安全回滚 + 置 null（幂等，第二次返回 cleaned:false / message:null）。
export async function resolveProjectProfile(projectRoot, environment, io = console) {
  const status = await projectModelStatus(projectRoot, environment);
  if (!status.dangling) {
    return { profile: status.profile, binding: status.binding, cleaned: false, conflicts: [], message: null };
  }
  let cleared;
  try {
    // 启动路径的顺带清理：timeoutMs 0 = 只试一次锁，拿不到就跳过本次清理。
    // 清理是幂等的（下次启动再清），启动绝不能因为另一个进程在写而失败或空等。
    cleared = await withProjectLock(
      projectRoot,
      () => clearBindingLocked(projectRoot, environment, io),
      { timeoutMs: 0, io },
    );
  } catch (error) {
    if (error?.code !== LOCK_TIMEOUT_CODE) throw error;
    // 本次未清理：投影仍然指向已删除的 profile，dangling 警告必须照常上报。
    return {
      profile: null,
      binding: status.binding,
      cleaned: false,
      conflicts: [],
      message: status.message,
    };
  }
  await protectProjectFiles(projectRoot, io);
  const suffix = cleared.conflicts.length > 0
    ? `\nConflicting keys left untouched: ${cleared.conflicts.map((entry) => entry.path.join(".")).join(", ")}`
    : "";
  return {
    profile: null,
    binding: cleared.binding,
    cleaned: true,
    conflicts: cleared.conflicts,
    message: `${status.message}${suffix}`,
  };
}
