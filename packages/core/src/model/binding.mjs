import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readJson } from "../util/json.mjs";
import { fail } from "../util/fail.mjs";
import { transact } from "./transaction.mjs";
import { getProfile } from "./library.mjs";
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

export async function readBinding(projectRoot) {
  const file = projectModelFile(projectRoot);
  if (!existsSync(file)) {
    return { value: emptyBinding(), exists: false, file };
  }
  const raw = await readJson(file);
  if (typeof raw !== "object" || raw === null) {
    fail(`Project model binding is malformed: ${file}`);
  }
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
async function commitProject(replacements, directory) {
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
  const fingerprint = libraryFingerprint(profile);
  const entries = buildClaudeEntries(profile);
  let changed = false;
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
export async function clearProjectBinding(projectRoot, environment, io = console) {
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
  const cleared = await clearProjectBinding(projectRoot, environment, io);
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
