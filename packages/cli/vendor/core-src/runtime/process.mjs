import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

function resolveOnPath(executable, environment) {
  if (path.isAbsolute(executable) || executable.includes(path.sep)) {
    return existsSync(executable) ? executable : null;
  }
  const extensions = process.platform === "win32" ? [".exe", ".com", ".ps1", ".cmd", ".bat", ""] : [""];
  for (const directory of (environment.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"|"$/g, ""), `${executable}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function invocation(executable, argumentsList, environment) {
  const resolved = resolveOnPath(executable, environment) ?? executable;
  if (process.platform === "win32" && resolved.toLowerCase().endsWith(".ps1")) {
    const powershell = path.join(environment.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return {
      command: powershell,
      argumentsList: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolved, ...argumentsList],
    };
  }
  return { command: resolved, argumentsList };
}

export function spawnExecutableSync(executable, argumentsList, options = {}) {
  const environment = options.env ?? process.env;
  const { spawn, ...spawnOptions } = options;
  if (spawn) {
    return spawn(executable, argumentsList, { ...spawnOptions, env: environment });
  }
  const resolved = invocation(executable, argumentsList, environment);
  return spawnSync(resolved.command, resolved.argumentsList, { ...spawnOptions, env: environment });
}
