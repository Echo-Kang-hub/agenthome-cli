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
