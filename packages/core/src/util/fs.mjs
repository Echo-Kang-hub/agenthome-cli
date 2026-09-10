import { lstat, readdir, rmdir } from "node:fs/promises";
import path from "node:path";

export function isInside(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// Best-effort cleanup of an empty destination directory. Invariant: lstat before every entry op,
// never follow or unlink a link. A symlink/junction/file at the root (e.g. a destination that
// aliases the canonical tree) is left untouched; only a plain empty directory is removed.
export async function removeEmptyDirectory(directory) {
  try {
    const entry = await lstat(directory);
    if (!entry.isDirectory()) {
      return;
    }
    if ((await readdir(directory)).length === 0) {
      await rmdir(directory);
    }
  } catch (error) {
    // The entry vanished between checks (benign race); anything else is a real failure.
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return;
    }
    throw error;
  }
}
