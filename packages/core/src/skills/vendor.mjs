import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";

export async function createTempDirectory(catalogRoot) {
  const tempRoot = path.join(catalogRoot, ".tmp");
  await mkdir(tempRoot, { recursive: true });
  return mkdtemp(path.join(tempRoot, "vendor-"));
}

export async function removeTempDirectory(directory, io = console) {
  try {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  } catch (error) {
    io.warn(
      `Warning: temporary directory cleanup failed: ${directory} (${error.code ?? error.message})`,
    );
  }
}

export async function replaceStagedFiles(replacements, tempDirectory) {
  const completed = [];
  try {
    for (const replacement of replacements) {
      const backup = path.join(tempDirectory, "backup", replacement.relativePath);
      await mkdir(path.dirname(backup), { recursive: true });
      let hasBackup = false;
      if (existsSync(replacement.target)) {
        await rename(replacement.target, backup);
        hasBackup = true;
      }
      await mkdir(path.dirname(replacement.target), { recursive: true });
      try {
        await rename(replacement.staged, replacement.target);
      } catch (error) {
        if (hasBackup) {
          await rename(backup, replacement.target);
        }
        throw error;
      }
      completed.push({ ...replacement, backup });
    }
  } catch (error) {
    for (const replacement of completed.reverse()) {
      await rm(replacement.target, { recursive: true, force: true });
      if (existsSync(replacement.backup)) {
        await rename(replacement.backup, replacement.target);
      }
    }
    throw error;
  }
}
