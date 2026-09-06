import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { runtimePaths } from "../config.mjs";
import {
  PROJECT_ROOT_TOKEN,
  listFiles,
  mergeFiles,
  readFirstJsonLine,
  replaceDirectory,
  samePath,
  transformJsonLines,
} from "../sessions.mjs";

function locations(projectRoot, environment = process.env) {
  const codexHome = environment.CODEX_HOME || path.join(homedir(), ".codex");
  return {
    codexHome,
    nativeSessions: path.join(codexHome, "sessions"),
    portable: path.join(runtimePaths(projectRoot).sessionsRoot, "codex"),
  };
}

function rewriteCwd(content, projectRoot, restore) {
  return transformJsonLines(content.toString("utf8"), (record) => {
    const cwd = record.payload?.cwd;
    if (restore ? typeof cwd === "string" : samePath(cwd, projectRoot)) {
      record.payload.cwd = restore ? projectRoot : PROJECT_ROOT_TOKEN;
    }
    return record;
  });
}

async function matchingRollouts(root, projectRoot) {
  const matches = [];
  for (const relative of await listFiles(root)) {
    if (!relative.endsWith(".jsonl")) {
      continue;
    }
    try {
      const first = await readFirstJsonLine(path.join(root, relative));
      if (first.type === "session_meta" && samePath(first.payload?.cwd, projectRoot)) {
        matches.push({ relative, id: first.payload?.id ?? first.payload?.session_id });
      }
    } catch {}
  }
  return matches;
}

async function filteredIndex(codexHome, ids) {
  const indexFile = path.join(codexHome, "session_index.jsonl");
  if (!existsSync(indexFile)) {
    return "";
  }
  return (await readFile(indexFile, "utf8"))
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.trim()) return false;
      try {
        return ids.has(JSON.parse(line).id);
      } catch {
        return false;
      }
    })
    .join("\n");
}

export async function capture(projectRoot, options = {}) {
  const { codexHome, nativeSessions, portable } = locations(projectRoot, options.environment);
  const rollouts = await matchingRollouts(nativeSessions, projectRoot);
  if (rollouts.length === 0) {
    return { count: 0, changed: false };
  }
  const ids = new Set(rollouts.map(({ id }) => id).filter(Boolean));
  await replaceDirectory(portable, async (temporary) => {
    for (const { relative } of rollouts) {
      const target = path.join(temporary, "sessions", relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, rewriteCwd(await readFile(path.join(nativeSessions, relative)), projectRoot, false));
    }
    const index = await filteredIndex(codexHome, ids);
    if (index) {
      await writeFile(path.join(temporary, "session_index.jsonl"), `${index}\n`, "utf8");
    }
  });
  return { count: rollouts.length, changed: true };
}

async function restoreIndex(portable, codexHome) {
  const source = path.join(portable, "session_index.jsonl");
  if (!existsSync(source)) {
    return;
  }
  const destination = path.join(codexHome, "session_index.jsonl");
  const existing = existsSync(destination) ? await readFile(destination, "utf8") : "";
  const existingLines = new Set(existing.split(/\r?\n/).filter(Boolean));
  const additions = (await readFile(source, "utf8")).split(/\r?\n/).filter((line) => line && !existingLines.has(line));
  if (additions.length > 0) {
    await mkdir(codexHome, { recursive: true });
    await appendFile(destination, `${existing && !existing.endsWith("\n") ? "\n" : ""}${additions.join("\n")}\n`, "utf8");
  }
}

export async function restore(projectRoot, options = {}) {
  const { codexHome, nativeSessions, portable } = locations(projectRoot, options.environment);
  const sourceRoot = path.join(portable, "sessions");
  const files = await listFiles(sourceRoot);
  if (files.length === 0) {
    return { count: 0, added: 0, updated: 0, unchanged: 0 };
  }
  // Project portable sessions are the source of truth: on conflict they
  // overwrite the native copy (explicit `sessions writeback` semantics).
  const result = await mergeFiles(sourceRoot, files, nativeSessions, (content, relative) =>
    relative.endsWith(".jsonl") ? rewriteCwd(content, projectRoot, true) : content,
    { onConflict: "keep-source" },
  );
  await restoreIndex(portable, codexHome);
  return { count: files.length, ...result };
}

export async function status(projectRoot) {
  const { portable } = locations(projectRoot);
  return { count: (await listFiles(path.join(portable, "sessions"))).filter((file) => file.endsWith(".jsonl")).length };
}
