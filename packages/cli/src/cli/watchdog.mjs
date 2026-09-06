import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionLeasePath } from "#core";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Start the detached watchdog that finishes this launch if the CLI process is
// killed without a normal exit (closed terminal, closed editor, crash): it
// captures the run's sessions into the project and restores the native
// storage. Detached and windowless, so closing the terminal does not kill it.
// Best-effort: launch continues without it if spawning fails.
export async function spawnSessionWatchdog(agentId, projectRoot, member, environment) {
  const stateDir = sessionLeasePath(agentId, projectRoot);
  await writeFile(
    path.join(stateDir, "watchdog.json"),
    JSON.stringify({ member, parentPid: process.pid, agentId, projectRoot, environment }),
    { encoding: "utf8", mode: 0o600 },
  );
  const child = spawn(process.execPath, [path.join(packageRoot, "scripts", "watchdog.mjs"), stateDir], {
    cwd: os.tmpdir(),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child;
}
