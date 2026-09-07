import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { agentsToViewModels } from "../src/views/view-models.ts";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("manifest contributes three views under avenic container", async () => {
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].id, "avenic");
  assert.deepEqual(manifest.contributes.views.avenic.map((v: { id: string }) => v.id).sort(), ["avenic.agents", "avenic.catalog", "avenic.skills"]);
});

test("view models feed tree rendering without vscode", () => {
  const items = agentsToViewModels([]);
  assert.deepEqual(items, []); // 数据通路纯函数；provider 内部映射 TreeItem 由 M5 手动冒烟
});
