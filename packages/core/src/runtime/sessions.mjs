import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const PROJECT_ROOT_TOKEN = "${PROJECT_ROOT}";

export function samePath(left, right) {
  if (!left || !right) {
    return false;
  }
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

export function transformJsonLines(content, transform) {
  const trailingNewline = content.endsWith("\n");
  const lines = content.split(/\r?\n/);
  if (trailingNewline) {
    lines.pop();
  }
  const transformed = lines.map((line) => {
    if (!line.trim()) {
      return line;
    }
    try {
      return JSON.stringify(transform(JSON.parse(line)));
    } catch {
      return line;
    }
  });
  return `${transformed.join("\n")}${trailingNewline ? "\n" : ""}`;
}

export async function listFiles(root) {
  if (!existsSync(root)) {
    return [];
  }
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        files.push(path.relative(root, absolute));
      }
    }
  }
  await walk(root);
  return files.sort();
}

export async function replaceDirectory(destination, build) {
  const parent = path.dirname(destination);
  const suffix = `${process.pid}-${Date.now()}`;
  const temporary = `${destination}.tmp-${suffix}`;
  const backup = `${destination}.bak-${suffix}`;
  await mkdir(parent, { recursive: true });
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  try {
    await build(temporary);
    if (existsSync(destination)) {
      await renameWithRetry(destination, backup);
    }
    await renameWithRetry(temporary, destination);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (existsSync(backup) && !existsSync(destination)) {
      await renameWithRetry(backup, destination);
    }
    throw error;
  }
}

async function renameWithRetry(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (attempt >= 4 || !["EACCES", "EBUSY", "EPERM"].includes(error.code)) throw error;
      await delay(40 * (attempt + 1));
    }
  }
}

export async function snapshotFiles(sourceRoot, relativeFiles, destination, transform) {
  await replaceDirectory(destination, async (temporary) => {
    for (const relative of relativeFiles) {
      const source = path.join(sourceRoot, relative);
      const target = path.join(temporary, relative);
      await mkdir(path.dirname(target), { recursive: true });
      const content = await readFile(source);
      await writeFile(target, transform ? await transform(content, relative) : content);
    }
  });
}

function isPrefix(prefix, content) {
  return prefix.length <= content.length && content.subarray(0, prefix.length).equals(prefix);
}

export async function mergeFiles(sourceRoot, relativeFiles, destinationRoot, transform, options = {}) {
  let added = 0;
  let conflicts = 0;
  let updated = 0;
  let unchanged = 0;
  for (const relative of relativeFiles) {
    const source = path.join(sourceRoot, relative);
    const destination = path.join(destinationRoot, relative);
    const sourceContent = Buffer.from(transform ? await transform(await readFile(source), relative) : await readFile(source));
    if (!existsSync(destination)) {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, sourceContent);
      added += 1;
      continue;
    }
    const destinationContent = await readFile(destination);
    if (sourceContent.equals(destinationContent) || isPrefix(sourceContent, destinationContent)) {
      unchanged += 1;
      continue;
    }
    if (relative.endsWith(".jsonl") && isPrefix(destinationContent, sourceContent)) {
      await writeFile(destination, sourceContent);
      updated += 1;
      continue;
    }
    if (options.onConflict === "keep-destination") {
      conflicts += 1;
      continue;
    }
    if (options.onConflict === "keep-source") {
      // The portable (project) copy wins; the destination gets the source
      // content and the caller reports the conflict.
      await writeFile(destination, sourceContent);
      conflicts += 1;
      continue;
    }
    throw new Error(`Session conflict: ${relative}. Keep one version, then retry.`);
  }
  return { added, conflicts, updated, unchanged };
}

export async function readFirstJsonLine(file) {
  const content = await readFile(file, "utf8");
  const line = content.split(/\r?\n/, 1)[0];
  return JSON.parse(line.replace(/^\uFEFF/, ""));
}

export function hashContent(content) {
  return createHash("sha256").update(content).digest("hex");
}
