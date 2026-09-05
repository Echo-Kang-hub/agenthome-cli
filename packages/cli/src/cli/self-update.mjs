import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnExecutableSync } from "#core";

export async function agentHomePackageSpec(packageRoot) {
  const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  return metadata.agentHome?.packageSpec ?? "Echo-Kang-hub/agenthome-cli#main";
}

export async function updateAgentHome(packageRoot, options = {}) {
  const packageSpec = await agentHomePackageSpec(packageRoot);
  console.log("Updating AgentHome");
  console.log(`Source: ${packageSpec}\n`);
  const result = (options.spawn ?? spawnExecutableSync)(
    "npm",
    ["install", "--global", packageSpec],
    { stdio: "inherit" },
  );
  if (result.error) {
    throw new Error(`Unable to launch npm: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`npm install failed with exit code ${result.status ?? 1}`);
  }
  console.log("\nAgentHome update complete");
  return packageSpec;
}
