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
  const bound = (command: string, rowState: string, group?: string) =>
    contextMenus.some((m) =>
      m.command === command &&
      m.when === `view == avenic.agents && viewItem == ${rowState}` &&
      (group === undefined || m.group === group));
  // bootstrap（未初始化 + CLI 未安装）：安装 @1 + 初始化 @2
  assert.ok(bound("avenic.agents.install", "agent-bootstrap", "inline@1"), "bootstrap 安装悬停键位");
  assert.ok(bound("avenic.agents.install", "agent-bootstrap"), "bootstrap 安装右键菜单");
  assert.ok(bound("avenic.agents.init", "agent-bootstrap", "inline@2"), "bootstrap 初始化键位");
  // inactive（未初始化）：仅初始化 @1
  assert.ok(bound("avenic.agents.init", "agent-inactive", "inline@1"), "未初始化行悬停键位");
  assert.ok(bound("avenic.agents.init", "agent-inactive"), "未初始化行右键菜单");
  assert.ok(!bound("avenic.agents.install", "agent-inactive"), "未初始化行不出现安装键位");
  // active（已初始化）：启动 @1 + 移除 @2
  assert.ok(bound("avenic.agents.launch", "agent", "inline@1"), "已初始化行启动悬停键位");
  assert.ok(bound("avenic.agents.launch", "agent"), "已初始化行启动右键菜单");
  assert.ok(bound("avenic.agents.deinit", "agent", "inline@2"));
  assert.ok(!bound("avenic.agents.init", "agent"), "初始化键位不出现在已初始化行");
  // update（可升级）：启动 @1 + 升级 @2 + 移除 @3
  assert.ok(bound("avenic.agents.update", "agent-update", "inline@2"), "升级悬停键位");
  assert.ok(bound("avenic.agents.update", "agent-update"), "升级右键菜单");
  assert.ok(bound("avenic.agents.deinit", "agent-update", "inline@3"));
  assert.ok(!bound("avenic.agents.update", "agent"), "无新版本行不出现升级键位");
  // missing（已初始化 + CLI 未安装）：安装 @1 + 移除 @2
  assert.ok(bound("avenic.agents.install", "agent-missing", "inline@1"), "missing 安装悬停键位");
  assert.ok(bound("avenic.agents.deinit", "agent-missing", "inline@2"));
  // AGENTS 标题栏初始化键位（命令面板式入口，无需先选中行）
  const titleMenus: Array<{ command: string; when: string }> = manifest.contributes?.menus?.["view/title"] ?? [];
  assert.ok(titleMenus.some((m) => m.command === "avenic.agents.init" && m.when === "view == avenic.agents"));
});
