import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { select } from "../src/services/catalog.ts";
import { addDirect, directSkills, installedPackIds, installPacks, removeDirect, status, uninstallPacks } from "../src/services/skills.ts";
import { makeCatalogFixture, testEnv } from "./helpers.ts";

test("pack install → status → uninstall round-trip in project scope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-skills-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const cwd = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(cwd, { recursive: true });
    await makeCatalogFixture(catalogDir);
    await select(catalogDir, env);
    assert.equal(await status("project", cwd, env), null);
    const result = await installPacks("project", ["common", "extra"], cwd, env);
    assert.equal(result.packIds.includes("common"), true);
    assert.equal(result.packIds.includes("extra"), true);
    const installed = await installedPackIds("project", cwd, env);
    assert.equal(installed?.includes("common"), true);
    assert.equal(installed?.includes("extra"), true);
    assert.ok((await status("project", cwd, env)) !== null, "安装后 lock 存在 → status 非 null");
    expectSkillDirs(cwd, ["alpha", "beta"], true, "installed");
    const removed = await uninstallPacks("project", ["extra"], cwd, env);
    assert.equal(removed.removed.includes("extra"), true);
    const remaining = await installedPackIds("project", cwd, env);
    assert.equal(remaining?.includes("extra"), false);
    assert.equal(remaining?.includes("common"), true, "core 语义：common 永驻，卸载只移除其余 pack — lock 保留，status 不会回到 null");
    expectSkillDirs(cwd, ["alpha"], true, "remaining");
    expectSkillDirs(cwd, ["beta"], false, "removed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct add/remove round-trip on local git repo", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-direct-"));
  try {
    const cwd = path.join(root, "project");
    const repo = path.join(root, "repo");
    const env = testEnv(path.join(root, "state"));
    await mkdir(cwd, { recursive: true });
    await mkdir(path.join(repo, "skills", "manual"), { recursive: true });
    await writeFile(path.join(repo, "skills", "manual", "SKILL.md"), "---\nname: manual\n---\n");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "one"], { cwd: repo });
    const added = await addDirect("project", repo, [], cwd, env);
    assert.equal(added.names.includes("manual"), true);
    const state = await directSkills("project", cwd, env);
    assert.equal(state.directSources.flatMap((s) => s.skills).includes("manual"), true);
    expectSkillDirs(cwd, ["manual"], true, "added");
    const removed = await removeDirect("project", ["manual"], cwd, env);
    assert.equal(removed.includes("manual"), true);
    expectSkillDirs(cwd, ["manual"], false, "removed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 决议 8：全局只读测试——全新隔离 state dir：status null、directSkills 空形状；证明全局
// 上下文完全由 env state dir 隔离。禁止任何全局写测试：全局安装目标直指用户主目录
// (GLOBAL_TARGETS: ~/.claude/skills 等)，写入即污染真机。
test("global scope is env-state-isolated and read-only safe", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-global-"));
  try {
    const env = testEnv(path.join(root, "state"));
    assert.equal(await status("global", undefined, env), null);
    const direct = await directSkills("global", undefined, env);
    assert.equal(direct.directSources.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest registers the five skills command ids with skills-tree context menus", async () => {
  const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  const ids = manifest.contributes?.commands ?? [];
  const ids5 = ["avenic.skills.installPacks", "avenic.skills.uninstallPacks", "avenic.skills.addDirect", "avenic.skills.removeDirect", "avenic.skills.directList"];
  for (const id of ids5) {
    assert.ok(ids.some((c: { command: string }) => c.command === id), id);
  }
  // 决议 9：视图级绑定（skills 树为分组行结构，五命令挂每行），不做 viewItem 细分
  const contextMenus: Array<{ command: string; when: string }> = manifest.contributes?.menus?.["view/item/context"] ?? [];
  for (const id of ids5) {
    assert.ok(contextMenus.some((m) => m.command === id && m.when === "view == avenic.skills"), id);
  }
});

// 目标目录断言辅助：项目作用域目标两处（.claude/skills + .agents/skills）
function expectSkillDirs(cwd: string, skills: string[], present: boolean, phase: string): void {
  for (const skill of skills) {
    const targets = [path.join(cwd, ".claude", "skills", skill), path.join(cwd, ".agents", "skills", skill)];
    for (const target of targets) {
      assert.equal(existsSync(target), present, `期望 ${target} ${present ? "存在" : "已删除"}（${phase}）`);
    }
  }
}
