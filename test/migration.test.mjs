import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createInstallContext, stateRoot } from "../packages/core/src/index.mjs";

test("createInstallContext migrates legacy project files to .avenic.*", (t) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "avenic-migrate-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(path.join(cwd, ".agent-skills.json"), JSON.stringify({ schemaVersion: 2, packs: ["common"] }));
  writeFileSync(path.join(cwd, ".agent-skills.lock.json"), JSON.stringify({ catalog: { spec: "x" } }));
  const context = createInstallContext(false, { cwd });
  assert.equal(context.configFile, path.join(cwd, ".avenic.json"));
  assert.equal(context.lockFile, path.join(cwd, ".avenic.lock.json"));
  assert.deepEqual(JSON.parse(readFileSync(context.configFile, "utf8")), { schemaVersion: 2, packs: ["common"] });
  assert.equal(existsSync(path.join(cwd, ".agent-skills.json")), false);
  assert.equal(existsSync(path.join(cwd, ".agent-skills.lock.json")), false);
});

test("migration never overwrites existing new files", (t) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "avenic-migrate-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  // 两处都写合法 JSON，避免 createInstallContext 解析失败干扰断言
  writeFileSync(path.join(cwd, ".avenic.json"), JSON.stringify({ schemaVersion: 2, packs: ["fresh"] }));
  writeFileSync(path.join(cwd, ".agent-skills.json"), JSON.stringify({ schemaVersion: 2, packs: ["old"] }));
  const context = createInstallContext(false, { cwd });
  assert.deepEqual(JSON.parse(readFileSync(context.configFile, "utf8")), { schemaVersion: 2, packs: ["fresh"] });
  assert.equal(existsSync(path.join(cwd, ".agent-skills.json")), true);
});

test("stateRoot migrates ~/.config/agent-skills to avenic once", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "avenic-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "agent-skills", "catalog"), { recursive: true });
  writeFileSync(path.join(root, "agent-skills", "catalog.json"), "{}");
  const env = { XDG_CONFIG_HOME: root };
  assert.equal(stateRoot(env), path.join(root, "avenic"));
  assert.equal(existsSync(path.join(root, "avenic", "catalog.json")), true);
  assert.equal(existsSync(path.join(root, "agent-skills")), false);
});

test("stateRoot keeps legacy directory when rename fails", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "avenic-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // 用一个同名文件占位，使 rename 失败
  writeFileSync(path.join(root, "avenic"), "blocked");
  mkdirSync(path.join(root, "agent-skills"));
  const env = { XDG_CONFIG_HOME: root };
  assert.equal(stateRoot(env), path.join(root, "agent-skills"));
});
