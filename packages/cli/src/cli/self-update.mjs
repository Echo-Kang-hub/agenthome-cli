import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnExecutableSync } from "#core";

export async function avenicPackageSpec(packageRoot) {
  const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  return metadata.avenic?.packageSpec ?? "Echo-Kang-hub/avenic#main";
}

export async function updateAvenic(packageRoot, options = {}) {
  const packageSpec = await avenicPackageSpec(packageRoot);
  console.log("Updating Avenic");
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
  console.log("\nAvenic update complete");
  return packageSpec;
}
