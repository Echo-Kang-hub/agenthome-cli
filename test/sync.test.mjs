import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("vendor core-src stays in sync with packages/core/src", async () => {
  const core = await readFile(path.join(packageRoot, "packages", "core", "src", "index.mjs"), "utf8");
  const vendor = await readFile(path.join(packageRoot, "packages", "cli", "vendor", "core-src", "index.mjs"), "utf8");
  assert.equal(vendor, core);
});
