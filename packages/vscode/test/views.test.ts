import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { agentsToViewModels } from "../src/views/view-models.ts";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("manifest contributes four views under avenic container", async () => {
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].id, "avenic");
  assert.deepEqual(manifest.contributes.views.avenic.map((v: { id: string }) => v.id).sort(), ["avenic.agents", "avenic.catalog", "avenic.overview", "avenic.skills"]);
  const overview = manifest.contributes.views.avenic.find((v: { id: string }) => v.id === "avenic.overview");
  assert.equal(overview.type, "webview"); // T10 dashboard 视图条目
});

test("view models feed tree rendering without vscode", () => {
  const items = agentsToViewModels([]);
  assert.deepEqual(items, []); // 数据通路纯函数；provider 内部映射 TreeItem 由 M5 手动冒烟
});

test("agent rows expose state-specific keys and title/init key bindings", async () => {
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  const contextMenus: Array<{ command: string; when: string; group?: string }> = manifest.contributes?.menus?.["view/item/context"] ?? [];
  // 未初始化行：悬停 + 右键均有「初始化」键位（viewItem == agent-inactive）
  const inactive = "view == avenic.agents && viewItem == agent-inactive";
  assert.ok(contextMenus.some((m) => m.command === "avenic.agents.init" && m.when === inactive && m.group === "inline@1"), "未初始化行悬停键位");
  assert.ok(contextMenus.some((m) => m.command === "avenic.agents.init" && m.when === inactive), "未初始化行右键菜单");
  // 已初始化行：移除等键位（viewItem == agent），初始化键位不出现在已初始化行
  assert.ok(contextMenus.some((m) => m.command === "avenic.agents.deinit" && m.when === "view == avenic.agents && viewItem == agent" && m.group === "inline@2"));
  assert.ok(!contextMenus.some((m) => m.command === "avenic.agents.init" && m.when === "view == avenic.agents && viewItem == agent"));
  // AGENTS 标题栏初始化键位（命令面板式入口，无需先选中行）
  const titleMenus: Array<{ command: string; when: string }> = manifest.contributes?.menus?.["view/title"] ?? [];
  assert.ok(titleMenus.some((m) => m.command === "avenic.agents.init" && m.when === "view == avenic.agents"));
});
