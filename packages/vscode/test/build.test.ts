import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("production build emits dist/extension.js containing bundled core", async () => {
  const js = await import("node:fs/promises").then((m) => m.readFile(path.join(pkgDir, "dist", "extension.js"), "utf8"));
  assert.ok(js.includes("avenic"), "bundle 应含 core 逻辑");
});

test("vsce package produces a VSIX via npm script", async () => {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  // Windows: Node >=20.12 拒绝对 .cmd 直接 spawnSync（CVE-2024-27980 缓解），需经 shell 执行
  execFileSync(npm, ["--prefix", pkgDir, "run", "package"], { stdio: "inherit", shell: process.platform === "win32" });
  const info = await stat(path.join(pkgDir, "dist", "avenic.vsix"));
  assert.ok(info.size > 0, "VSIX 应已产出");
});
