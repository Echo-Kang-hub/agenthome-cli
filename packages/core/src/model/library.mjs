import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { readJson } from "../util/json.mjs";
import { fail } from "../util/fail.mjs";
import { emptyLibrary, normalizeProfile } from "./schema.mjs";
import { LIBRARY_SCHEMA_VERSION, modelsFile, modelsTempRoot } from "./paths.mjs";
import { transact } from "./transaction.mjs";

// 库是唯一事实来源：读失败一律 fail（不自动修复、不覆盖用户文件），由调用方提示
// "配置损坏"并给出文件路径（spec §13）。
export async function readLibrary(environment = process.env) {
  const file = modelsFile(environment);
  if (!existsSync(file)) {
    return { ...emptyLibrary(), exists: false, file };
  }
  const raw = await readJson(file); // 解析失败 → fail("Cannot parse JSON file ...")
  if (typeof raw !== "object" || raw === null || typeof raw.profiles !== "object" || raw.profiles === null) {
    fail(`Model library is malformed: ${file}`);
  }
  return {
    schemaVersion: raw.schemaVersion ?? LIBRARY_SCHEMA_VERSION,
    revision: Number.isInteger(raw.revision) ? raw.revision : 0,
    profiles: raw.profiles,
    exists: true,
    file,
  };
}

export async function listProfiles(environment = process.env) {
  const library = await readLibrary(environment);
  return Object.values(library.profiles).sort((left, right) => left.name.localeCompare(right.name));
}

export async function getProfile(environment, id) {
  const library = await readLibrary(environment);
  return library.profiles[id] ?? null;
}

// 落盘：先写临时文件（同卷），事务负责备份 + 原子替换 + 失败回滚。
async function stageLibrary(environment, next, directory) {
  const staged = path.join(directory, "staged", "models.json");
  await mkdir(path.dirname(staged), { recursive: true });
  await writeFile(staged, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return [{ relativePath: "models.json", staged, target: modelsFile(environment) }];
}

async function mutateLibrary(environment, mutate, io = console) {
  let written = null;
  const result = await transact({
    tempRoot: modelsTempRoot(environment),
    read: async () => {
      const library = await readLibrary(environment);
      return { revision: library.revision, value: library };
    },
    build: (current) => {
      const next = mutate(current.value);
      if (next === null) return null;
      written = { ...next, schemaVersion: LIBRARY_SCHEMA_VERSION, revision: current.revision + 1 };
      return written;
    },
    stage: (next, directory) => stageLibrary(environment, next, directory),
  });
  if (result.changed) {
    await protectLibraryFile(modelsFile(environment), io);
  }
  return { ...result, value: result.changed ? written : result.value };
}

// POSIX 0600；Windows 依赖用户目录 ACL（chmod 在 win32 上是 no-op，不报错）。
async function protectLibraryFile(file, io) {
  try {
    await chmod(file, 0o600);
  } catch (error) {
    io.warn?.(`Warning: could not restrict permissions on ${file} (${error.code ?? error.message})`);
  }
}

export async function upsertProfile(environment, input, io = console) {
  return mutateLibrary(environment, (library) => {
    const existing = library.profiles[input.id] ?? null;
    const profile = normalizeProfile(input, { existing });
    return { ...library, profiles: { ...library.profiles, [profile.id]: profile } };
  }, io);
}

export async function removeProfile(environment, id, io = console) {
  return mutateLibrary(environment, (library) => {
    if (!library.profiles[id]) return null;
    const profiles = { ...library.profiles };
    delete profiles[id];
    return { ...library, profiles };
  }, io);
}
