import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

function findMarker(startDirectory, relativeMarker) {
  let current = path.resolve(startDirectory);
  while (true) {
    if (existsSync(path.join(current, relativeMarker))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function findGitRoot(startDirectory) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: startDirectory,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    return null;
  }
  const root = result.stdout.trim();
  return root ? path.resolve(root) : null;
}

export function locateProjectRoot(startDirectory = process.cwd()) {
  const start = path.resolve(startDirectory);
  return (
    findGitRoot(start) ??
    findMarker(start, path.join(".agents", "runtime.json")) ??
    findMarker(start, ".agent-skills.json") ??
    start
  );
}
