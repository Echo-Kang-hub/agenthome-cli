import { existsSync } from "node:fs";
import { readdir, rmdir } from "node:fs/promises";
import path from "node:path";

export function isInside(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function removeEmptyDirectory(directory) {
  if (existsSync(directory) && (await readdir(directory)).length === 0) {
    await rmdir(directory);
  }
}
