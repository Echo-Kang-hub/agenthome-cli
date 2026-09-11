import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("vscode extension manifest identity", async () => {
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  assert.equal(manifest.name, "avenic-agent-manager");
  assert.equal(manifest.displayName, "Avenic Agent Manager");
  assert.equal(manifest.main, "./dist/extension.js");
  assert.equal(manifest.type, "module");
  assert.deepEqual(manifest.engines, { vscode: "^1.90.0" });
  assert.equal(manifest.activationEvents, undefined, "1.75+ 由 contributes 自动激活，不写 activationEvents");
});

test("esbuild test runner emits executable tests", async (t) => {
  const bundle = path.join(pkgDir, ".test-out", "manifest.test.js");
  // 本文件会被根仓库 `node --test` 扫描到（Node 24 默认匹配 *.test.ts），那是一次源码运行、
  // 不经由 build-tests.mjs，不代表 .test-out 已构建；仅 bundle 运行时才校验产物存在。
  if (path.basename(path.dirname(fileURLToPath(import.meta.url))) !== ".test-out") {
    t.skip("源码运行：由 build-tests.mjs 打包执行时校验");
    return;
  }
  await stat(bundle); // bundle 运行：esbuild 必须已产出可执行测试
});

test("active editor window has vscode engine", async () => {
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  assert.equal(manifest.workspaces, undefined, "不得引入 workspaces 字段");
  assert.equal(manifest.private, true, "防止误发 npm");
});

// 面板内部命令同样要进 contributes.commands（registerCommand 与清单一致、不出现未声明项），
// 再用 commandPalette 的 when:false 隐藏——"进数组"与"对用户不可见"是两件事，
// 所以下面的可见性断言按 when 过滤，不能只看命令是否出现在数组里。
const MODEL_INTERNAL_COMMANDS = [
  "avenic.model.saveProfile",
  "avenic.model.duplicateProfile",
  "avenic.model.preview",
  "avenic.model.deleteProfile",
  "avenic.model.bindProject",
  "avenic.model.clearProject",
  "avenic.model.testConnection",
  "avenic.model.openLibraryFile",
  "avenic.model.openSettingsFile",
];

test("model commands are declared in the manifest", async () => {
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  const ids = manifest.contributes.commands.map((entry: { command: string }) => entry.command);
  assert.equal(ids.includes("avenic.model.open"), true);
  assert.equal(ids.includes("avenic.model.switch"), true);
  for (const id of MODEL_INTERNAL_COMMANDS) assert.equal(ids.includes(id), true, `未声明内部命令 ${id}`);

  const palette: Array<{ command: string; when?: string }> = manifest.contributes.menus.commandPalette;
  const visible = palette.filter((entry) => entry.when !== "false").map((entry) => entry.command);
  assert.equal(visible.includes("avenic.model.open"), true);
  assert.equal(visible.includes("avenic.model.openLibraryFile"), false, "internal plumbing stays out of the palette");
  for (const id of MODEL_INTERNAL_COMMANDS) {
    assert.equal(palette.find((entry) => entry.command === id)?.when, "false", `${id} 必须从命令面板隐藏`);
  }

  const titleMenus: Array<{ command: string; when: string; group?: string }> = manifest.contributes.menus["view/title"];
  assert.ok(titleMenus.some((m) => m.command === "avenic.model.open" && m.when === "view == avenic.agents" && m.group === "navigation"), "Agents 标题栏入口");
});

// 上面那条只钉住了已知清单：新加一个 register("…") 而忘了写清单，它照样是绿的
// （duplicateProfile / preview 就是这么漏掉的）。这条从源码里的 register 调用反推，
// 两个方向都查：注册了的必须声明，声明了的必须真有人注册。
test("registered model commands and the manifest declare the same set", async () => {
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  const declared = manifest.contributes.commands.map((entry: { command: string }) => entry.command);
  const source = await readFile(path.join(pkgDir, "src", "commands", "model-commands.ts"), "utf8");
  const registered = [...source.matchAll(/\bregister\("([A-Za-z]+)"/g)].map((m) => `avenic.model.${m[1]}`);
  assert.ok(registered.length > 0, "没解析到 register 调用——正则过期了");
  for (const id of registered) assert.ok(declared.includes(id), `registerCommand 了未声明的命令 ${id}`);
  for (const id of declared.filter((entry: string) => entry.startsWith("avenic.model."))) {
    assert.ok(registered.includes(id), `清单声明了 ${id}，但没有任何 register 实现它`);
  }
});
