import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { runtimePaths } from "../config.mjs";
import {
  PROJECT_ROOT_TOKEN,
  listFiles,
  mergeFiles,
  revertPath,
  samePath,
  snapshotFiles,
  snapshotPath,
  transformJsonLines,
} from "../sessions.mjs";

export function claudeProjectKey(projectRoot) {
  return path.resolve(projectRoot).replace(/[^a-zA-Z0-9]/g, "-");
}

function locations(projectRoot, environment = process.env) {
  const claudeHome = environment.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
  return {
    native: path.join(claudeHome, "projects", claudeProjectKey(projectRoot)),
    portable: path.join(runtimePaths(projectRoot).sessionsRoot, "claude"),
  };
}

function rewriteCwd(content, projectRoot, restore) {
  return transformJsonLines(content.toString("utf8"), (record) => {
    if (restore ? typeof record.cwd === "string" : samePath(record.cwd, projectRoot)) {
      record.cwd = restore ? projectRoot : PROJECT_ROOT_TOKEN;
    }
    return record;
  });
}

export async function capture(projectRoot, options = {}) {
  const { native, portable } = locations(projectRoot, options.environment);
  const files = await listFiles(native);
  if (files.length === 0) {
    return { count: 0, changed: false };
  }
  await snapshotFiles(native, files, portable, (content, relative) =>
    relative.endsWith(".jsonl") ? rewriteCwd(content, projectRoot, false) : content,
  );
  return { count: files.filter((file) => file.endsWith(".jsonl") && !file.includes(`${path.sep}subagents${path.sep}`)).length, changed: true };
}

export async function restore(projectRoot, options = {}) {
  const { native, portable } = locations(projectRoot, options.environment);
  const files = await listFiles(portable);
  if (files.length === 0) {
    return { count: 0, added: 0, updated: 0, unchanged: 0 };
  }
  // Project portable sessions are the source of truth: on conflict they
  // overwrite the native copy (explicit `sessions writeback` semantics).
  const result = await mergeFiles(portable, files, native, (content, relative) =>
    relative.endsWith(".jsonl") ? rewriteCwd(content, projectRoot, true) : content,
    { onConflict: "keep-source" },
  );
  return { count: files.length, ...result };
}

export async function status(projectRoot) {
  const { portable } = locations(projectRoot);
  const files = await listFiles(portable);
  return { count: files.filter((file) => file.endsWith(".jsonl") && !file.includes(`${path.sep}subagents${path.sep}`)).length };
}

// Save the native project directory so the launch flow can restore it after
// the run: sessions created by `agenthome claude` must live only in the
// project, never in the global native storage.
export async function snapshotNative(projectRoot, options = {}) {
  const { native } = locations(projectRoot, options.environment);
  return snapshotPath(native);
}

export async function revertNative(snapshot, projectRoot, options = {}) {
  const { native } = locations(projectRoot, options.environment);
  await revertPath(snapshot, native);
}
