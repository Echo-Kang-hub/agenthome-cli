import assert from "node:assert/strict";
import { lstatSync, readlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalTargets,
  classifyShareEntry,
  createInstallContext,
  createSkillLink,
  removeLinkSafely,
  sameTree,
  shareTargets,
} from "../packages/core/src/index.mjs";

async function withTempDirectory(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeSkill(root, name, content = `# ${name}\n`) {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), content);
  return directory;
}

// 用户自建链接（不是 avenic 建的）：Windows 用 junction（绝对路径），POSIX 用相对符号链接。
async function linkUserSkill(targetPath, linkPath) {
  await mkdir(path.dirname(linkPath), { recursive: true });
  if (process.platform === "win32") {
    await symlink(path.resolve(targetPath), linkPath, "junction");
  } else {
    await symlink(path.relative(path.dirname(linkPath), targetPath), linkPath, "dir");
  }
}

test("canonicalTargets / shareTargets split the table", async () => {
  await withTempDirectory("avenic-split-", async (cwd) => {
    const context = createInstallContext(false, { cwd, environment: process.env });
    assert.deepEqual(canonicalTargets(context).map((t) => t.id), ["agents"]);
    assert.deepEqual(shareTargets(context).map((t) => t.id), ["claude"]);
  });
});

test("createSkillLink produces a link that classifyShareEntry reports as linked", async () => {
  await withTempDirectory("avenic-link-", async (root) => {
    const canonicalRoot = path.join(root, "canonical");
    const shareRoot = path.join(root, "share");
    const canonical = await writeSkill(canonicalRoot, "alpha");
    const linkPath = path.join(shareRoot, "alpha");
    await createSkillLink(canonical, linkPath);
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true);
    assert.equal(readlinkSync(linkPath).length > 0, true);
    assert.deepEqual(await classifyShareEntry(canonical, linkPath), { state: "linked" });
  });
});

test("classifyShareEntry distinguishes foreign links, dangling links, real dirs and absent entries", async () => {
  await withTempDirectory("avenic-classify-", async (root) => {
    const canonicalRoot = path.join(root, "canonical");
    const shareRoot = path.join(root, "share");
    const canonical = await writeSkill(canonicalRoot, "alpha");
    const userTarget = await writeSkill(path.join(root, "user"), "alpha");

    const foreign = path.join(shareRoot, "foreign");
    await linkUserSkill(userTarget, foreign);
    const foreignVerdict = await classifyShareEntry(canonical, foreign);
    assert.equal(foreignVerdict.state, "conflict");
    assert.equal(foreignVerdict.reason, "points-elsewhere");

    const dangling = path.join(shareRoot, "dangling");
    await createSkillLink(canonical, dangling);
    await rm(canonical, { recursive: true, force: true });
    assert.equal((await classifyShareEntry(canonical, dangling)).state, "repair");

    await writeSkill(canonicalRoot, "alpha");
    const real = await writeSkill(shareRoot, "real");
    assert.equal((await classifyShareEntry(canonical, real)).state, "real-directory");

    assert.equal((await classifyShareEntry(canonical, path.join(shareRoot, "nothing"))).state, "absent");
  });
});

test("sameTree compares content, entry types and link targets without following links", async () => {
  await withTempDirectory("avenic-sametree-", async (root) => {
    const left = await writeSkill(path.join(root, "left"), "alpha", "# same\n");
    await mkdir(path.join(left, "nested"), { recursive: true });
    await writeFile(path.join(left, "nested", "extra.md"), "x");
    const right = path.join(root, "right", "alpha");
    await mkdir(path.join(right, "nested"), { recursive: true });
    await writeFile(path.join(right, "SKILL.md"), "# same\n");
    await writeFile(path.join(right, "nested", "extra.md"), "x");
    assert.equal(await sameTree(left, right), true);

    await writeFile(path.join(right, "nested", "extra.md"), "y");
    assert.equal(await sameTree(left, right), false, "same size, different content");

    await writeFile(path.join(right, "nested", "extra.md"), "longer-content");
    assert.equal(await sameTree(left, right), false, "different size");

    await rm(path.join(right, "nested"), { recursive: true, force: true });
    assert.equal(await sameTree(left, right), false, "entry set differs");

    await mkdir(path.join(right, "nested"), { recursive: true });
    await writeFile(path.join(right, "nested", "extra.md"), "x");
    const external = await writeSkill(path.join(root, "external"), "target");
    await linkUserSkill(external, path.join(left, "link-entry"));
    await linkUserSkill(external, path.join(right, "link-entry"));
    assert.equal(await sameTree(left, right), true, "identical internal link targets");

    await rm(path.join(right, "link-entry"));
    await linkUserSkill(path.join(root, "external", "other"), path.join(right, "link-entry"));
    assert.equal(await sameTree(left, right), false, "different internal link target");

    assert.equal(await sameTree(left, path.join(root, "missing")), false);
  });
});

test("removeLinkSafely removes only links and leaves the target intact", async () => {
  await withTempDirectory("avenic-remove-", async (root) => {
    const canonical = await writeSkill(path.join(root, "canonical"), "alpha");
    const linkPath = path.join(root, "share", "alpha");
    await createSkillLink(canonical, linkPath);
    assert.equal(await removeLinkSafely(linkPath), true);
    assert.equal(lstatSync(canonical).isDirectory(), true);
    assert.equal(lstatSync(path.join(canonical, "SKILL.md")).isFile(), true);
    assert.equal(await removeLinkSafely(canonical), false, "real directories are not unlinked");
    await unlink(linkPath).catch(() => {});
  });
});

// L1 回归（跨平台）：用户把整个 skills 目录做成链接时，末级分量不是链接，
// 但路径中间是 —— 此时 linkPath 与 canonical 是同一个真实目录，必须判 conflict。
test("classifyShareEntry refuses a whole-directory link that aliases the canonical root", async () => {
  await withTempDirectory("avenic-alias-", async (root) => {
    const canonicalRoot = path.join(root, "canonical");
    const shareRoot = path.join(root, "share");
    await writeSkill(canonicalRoot, "alpha");
    if (process.platform === "win32") {
      await symlink(path.resolve(canonicalRoot), shareRoot, "junction");
    } else {
      await symlink(path.relative(path.dirname(shareRoot), canonicalRoot), shareRoot, "dir");
    }
    const verdict = await classifyShareEntry(path.join(canonicalRoot, "alpha"), path.join(shareRoot, "alpha"));
    assert.equal(verdict.state, "conflict");
    assert.equal(verdict.reason, "aliases-canonical");
    assert.equal(lstatSync(path.join(canonicalRoot, "alpha", "SKILL.md")).isFile(), true);
  });
});

// L2 + L3（POSIX-only：Windows 忽略这些权限位，此处在 win32 上为有意的空跑）。
test("classifyShareEntry reports unreadable entries as conflict, never absent (POSIX)", async () => {
  if (process.platform !== "win32") {
    await withTempDirectory("avenic-unreadable-", async (root) => {
      const canonical = await writeSkill(path.join(root, "canonical"), "alpha");
      const parent = path.join(root, "parent");
      const child = path.join(parent, "child");
      await mkdir(child, { recursive: true });
      try {
        await chmod(parent, 0o000);
        const verdict = await classifyShareEntry(canonical, child);
        assert.equal(verdict.state, "conflict");
        assert.equal(verdict.reason, "unreadable-entry");
      } finally {
        await chmod(parent, 0o755);
      }
    });
  }
});

test("removeLinkSafely resolves to false instead of throwing when unlink fails (POSIX)", async () => {
  if (process.platform !== "win32") {
    await withTempDirectory("avenic-unlink-fail-", async (root) => {
      const canonical = await writeSkill(path.join(root, "canonical"), "alpha");
      const parent = path.join(root, "share");
      const linkPath = path.join(parent, "alpha");
      await createSkillLink(canonical, linkPath);
      try {
        await chmod(parent, 0o500);
        assert.equal(await removeLinkSafely(linkPath), false);
      } finally {
        await chmod(parent, 0o755);
      }
    });
  }
});
