import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function snapshotTree(directory, root = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = new Map();
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [relative, contents] of await snapshotTree(full, root)) {
        result.set(relative, contents);
      }
    } else {
      result.set(path.relative(root, full).replaceAll("\\", "/"), await readFile(full, "utf8"));
    }
  }
  return result;
}

test("vendor core-src stays in sync with packages/core/src", async () => {
  const coreRoot = path.join(packageRoot, "packages", "core", "src");
  const vendorRoot = path.join(packageRoot, "packages", "cli", "vendor", "core-src");
  const [core, vendor] = await Promise.all([snapshotTree(coreRoot), snapshotTree(vendorRoot)]);
  assert.ok(core.size > 0, "core src tree must not be empty");
  assert.deepEqual(vendor, core, "vendor tree must match core src exactly (no missing or extra files)");
});
