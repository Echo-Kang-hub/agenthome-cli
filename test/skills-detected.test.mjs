import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createInstallContext, detectedSkillNames } from "../packages/core/src/index.mjs";

async function withTempDirectory(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("detectedSkillNames lists SKILL.md-bearing directories across all targets", async () => {
  await withTempDirectory("avenic-detected-", async (dir) => {
    await mkdir(path.join(dir, ".agents", "skills", "alpha"), { recursive: true });
    await writeFile(path.join(dir, ".agents", "skills", "alpha", "SKILL.md"), "# alpha");
    await mkdir(path.join(dir, ".agents", "skills", "bravo"), { recursive: true });
    await writeFile(path.join(dir, ".agents", "skills", "bravo", "SKILL.md"), "# bravo");
    await mkdir(path.join(dir, ".claude", "skills", "charlie"), { recursive: true });
    await writeFile(path.join(dir, ".claude", "skills", "charlie", "SKILL.md"), "# charlie");
    // 无 SKILL.md 的目录与散落文件不计入
    await mkdir(path.join(dir, ".claude", "skills", "delta"), { recursive: true });
    await writeFile(path.join(dir, ".claude", "skills", "notes.txt"), "not a skill");
    const names = await detectedSkillNames(createInstallContext(false, { cwd: dir }));
    assert.deepEqual(names, ["alpha", "bravo", "charlie"]);
  });
});

test("detectedSkillNames deduplicates names shared across targets", async () => {
  await withTempDirectory("avenic-detected-", async (dir) => {
    await mkdir(path.join(dir, ".agents", "skills", "shared"), { recursive: true });
    await writeFile(path.join(dir, ".agents", "skills", "shared", "SKILL.md"), "# shared");
    await mkdir(path.join(dir, ".claude", "skills", "shared"), { recursive: true });
    await writeFile(path.join(dir, ".claude", "skills", "shared", "SKILL.md"), "# shared");
    const names = await detectedSkillNames(createInstallContext(false, { cwd: dir }));
    assert.deepEqual(names, ["shared"]);
  });
});

test("detectedSkillNames returns [] when no target directories exist", async () => {
  await withTempDirectory("avenic-detected-", async (dir) => {
    const names = await detectedSkillNames(createInstallContext(false, { cwd: dir }));
    assert.deepEqual(names, []);
  });
});

test("detectedSkillNames never writes metadata", async () => {
  await withTempDirectory("avenic-detected-", async (dir) => {
    await mkdir(path.join(dir, ".agents", "skills", "solo"), { recursive: true });
    await writeFile(path.join(dir, ".agents", "skills", "solo", "SKILL.md"), "# solo");
    await detectedSkillNames(createInstallContext(false, { cwd: dir }));
    const entries = await import("node:fs/promises").then((m) => m.readdir(dir));
    const metadata = entries.filter((n) => n.startsWith(".avenic") || n.startsWith(".agent-skills"));
    assert.deepEqual(metadata, [], "检测调用不得创建任何元数据文件");
  });
});
