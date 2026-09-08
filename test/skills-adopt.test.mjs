import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adoptSkills, createInstallContext, detectedSkillNames, skillsInstallationStatus } from "../packages/core/src/index.mjs";

async function withTempDirectory(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("adoptSkills places the skill into every target and records it in the lock", async () => {
  await withTempDirectory("avenic-adopt-", async (dir) => {
    await mkdir(path.join(dir, ".agents", "skills", "beta"), { recursive: true });
    await writeFile(path.join(dir, ".agents", "skills", "beta", "SKILL.md"), "# beta");
    const context = createInstallContext(false, { cwd: dir });
    const result = await adoptSkills(context, ["beta"]);
    assert.deepEqual(result.adopted, ["beta"]);
    assert.equal(result.placed, 1, ".claude/skills 缺失 → 生成 1 份拷贝");
    assert.ok(existsSync(path.join(dir, ".claude", "skills", "beta", "SKILL.md")), "补齐的 target 是真实拷贝");
    assert.equal(await readFile(path.join(dir, ".claude", "skills", "beta", "SKILL.md"), "utf8"), "# beta");
    const lock = JSON.parse(await readFile(path.join(dir, ".avenic.lock.json"), "utf8"));
    assert.deepEqual(lock.adopted, ["beta"]);
    const status = await skillsInstallationStatus(context);
    assert.equal(status === null, false);
    assert.deepEqual(status.names, ["beta"]);
    assert.ok(status.targets.every((t) => t.complete));
  });
});

test("adoptSkills is idempotent and never overwrites existing target content", async () => {
  await withTempDirectory("avenic-adopt-", async (dir) => {
    await mkdir(path.join(dir, ".claude", "skills", "keep"), { recursive: true });
    await writeFile(path.join(dir, ".claude", "skills", "keep", "SKILL.md"), "# keep");
    const context = createInstallContext(false, { cwd: dir });
    await adoptSkills(context, ["keep"]);
    await adoptSkills(context, ["keep", "keep"]);
    const lock = JSON.parse(await readFile(path.join(dir, ".avenic.lock.json"), "utf8"));
    assert.deepEqual(lock.adopted, ["keep"], "重复托管不产生重复记录");
    assert.equal(await readFile(path.join(dir, ".agents", "skills", "keep", "SKILL.md"), "utf8"), "# keep");
  });
});

test("adoptSkills rejects names with no on-disk skill", async () => {
  await withTempDirectory("avenic-adopt-", async (dir) => {
    await assert.rejects(adoptSkills(createInstallContext(false, { cwd: dir }), ["ghost"]), /ghost/);
  });
});

test("adoptSkills rejects unsafe names", async () => {
  await withTempDirectory("avenic-adopt-", async (dir) => {
    await mkdir(path.join(dir, ".agents", "skills", "ok"), { recursive: true });
    await writeFile(path.join(dir, ".agents", "skills", "ok", "SKILL.md"), "# ok");
    await assert.rejects(adoptSkills(createInstallContext(false, { cwd: dir }), ["../escape"]));
  });
});

test("adopted skills vanish from untracked detection after adopting", async () => {
  await withTempDirectory("avenic-adopt-", async (dir) => {
    await mkdir(path.join(dir, ".agents", "skills", "beta"), { recursive: true });
    await writeFile(path.join(dir, ".agents", "skills", "beta", "SKILL.md"), "# beta");
    const context = createInstallContext(false, { cwd: dir });
    assert.deepEqual(await detectedSkillNames(context), ["beta"]);
    await adoptSkills(context, ["beta"]);
    const status = await skillsInstallationStatus(context);
    const untracked = (await detectedSkillNames(context)).filter((name) => !status.names.includes(name));
    assert.deepEqual(untracked, [], "检测-托管闭环后无残留未托管项");
  });
});
