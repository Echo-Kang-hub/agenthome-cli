import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runtimePaths } from "../config.mjs";
import { hashContent, listFiles, replaceDirectory, samePath } from "../sessions.mjs";
import { spawnExecutableSync } from "../process.mjs";

function run(argumentsList, projectRoot, options = {}) {
  const result = spawnExecutableSync("opencode", argumentsList, {
    cwd: projectRoot,
    encoding: "utf8",
    env: options.environment ?? process.env,
    windowsHide: true,
    spawn: options.spawn,
  });
  if (result.error) {
    throw new Error(`Unable to launch opencode: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `opencode exited with code ${result.status}`);
  }
  return result.stdout;
}

function portableRoot(projectRoot) {
  return path.join(runtimePaths(projectRoot).sessionsRoot, "opencode");
}

function matchingSessions(projectRoot, options) {
  const sessions = JSON.parse(run(["session", "list", "--format", "json"], projectRoot, options));
  return sessions.filter((session) => samePath(session.directory, projectRoot));
}

export async function capture(projectRoot, options = {}) {
  const sessions = matchingSessions(projectRoot, options);
  if (sessions.length === 0) {
    return { count: 0, changed: false };
  }
  await replaceDirectory(portableRoot(projectRoot), async (temporary) => {
    for (const session of sessions) {
      await writeFile(path.join(temporary, `${session.id}.json`), run(["export", session.id], projectRoot, options), "utf8");
    }
  });
  return { count: sessions.length, changed: true };
}

export async function restore(projectRoot, options = {}) {
  const portable = portableRoot(projectRoot);
  const files = (await listFiles(portable)).filter((file) => file.endsWith(".json"));
  if (files.length === 0) {
    return { count: 0, added: 0, updated: 0, unchanged: 0 };
  }
  const localRoot = path.join(runtimePaths(projectRoot).localRoot, "opencode");
  const manifestFile = path.join(localRoot, "session-imports.json");
  const manifest = existsSync(manifestFile) ? JSON.parse(await readFile(manifestFile, "utf8")) : {};
  let imported = 0;
  let unchanged = 0;
  for (const relative of files) {
    const file = path.join(portable, relative);
    const hash = hashContent(await readFile(file));
    if (manifest[relative] === hash) {
      unchanged += 1;
      continue;
    }
    run(["import", file], projectRoot, options);
    manifest[relative] = hash;
    imported += 1;
  }
  await mkdir(localRoot, { recursive: true });
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { count: files.length, added: imported, updated: 0, unchanged };
}

export async function status(projectRoot) {
  return { count: (await listFiles(portableRoot(projectRoot))).filter((file) => file.endsWith(".json")).length };
}
