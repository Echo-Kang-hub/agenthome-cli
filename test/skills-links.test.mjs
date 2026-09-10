import assert from "node:assert/strict";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalTargets,
  classifyShareEntry,
  createInstallContext,
  createSkillLink,
  ensureSkillLinks,
  formatLinkSummary,
  logConflicts,
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

test("ensureSkillLinks links missing, repairs dangling and migrates identical copies", async () => {
  await withTempDirectory("avenic-ensure-", async (cwd) => {
    const context = createInstallContext(false, { cwd, environment: process.env });
    const canonicalRoot = path.join(cwd, ".agents", "skills");
    const shareRoot = path.join(cwd, ".claude", "skills");
    const canonical = await writeSkill(canonicalRoot, "alpha");

    // 1) canonical 缺失的技能：不建悬空链接
    await writeSkill(canonicalRoot, "known");
    const missingLink = await ensureSkillLinks(context, ["known", "ghost"], { silent: true });
    assert.equal(missingLink.counts.skipped, 1);
    assert.equal(existsSync(path.join(shareRoot, "ghost")), false);

    // 2) 悬空链接 → repair（只解除，不重建；调用时 canonical 仍缺失）
    const dangling = path.join(shareRoot, "alpha");
    await createSkillLink(canonical, dangling);
    await rm(path.join(canonicalRoot, "alpha"), { recursive: true, force: true });
    const repaired = await ensureSkillLinks(context, ["alpha"], { silent: true });
    assert.equal(repaired.counts.repaired, 1);
    assert.equal(repaired.counts.linked, 0);
    assert.equal(existsSync(path.join(shareRoot, "alpha")), false, "悬空条目已解除，不残留");
    // existsSync 对悬空链接同样为 false，无法区分"已解除"与"仍是断链"——用 lstat 钉死。
    assert.equal(lstatSync(path.join(shareRoot, "alpha"), { throwIfNoEntry: false }), undefined, "条目真的不在了");

    await writeSkill(canonicalRoot, "alpha"); // canonical 恢复
    const relinked = await ensureSkillLinks(context, ["alpha"], { silent: true });
    assert.equal(relinked.counts.linked, 1);
    assert.equal(lstatSync(path.join(shareRoot, "alpha")).isSymbolicLink(), true);
    assert.equal(existsSync(path.join(shareRoot, "alpha", "SKILL.md")), true);

    // 3) 真实副本且内容一致 → migrated（删副本 + 建链）
    const copyPath = path.join(shareRoot, "copy");
    await cp(path.join(canonicalRoot, "alpha"), copyPath, { recursive: true });
    const migrated = await ensureSkillLinks(context, ["alpha"], { silent: true, createLink: null });
    assert.equal(migrated.counts.unchanged, 1, "alpha 已经是链接");

    const copied = path.join(canonicalRoot, "copy");
    await mkdir(copied, { recursive: true });
    await writeFile(path.join(copied, "SKILL.md"), "# copy\n");
    await rm(copyPath, { recursive: true, force: true });
    await cp(copied, copyPath, { recursive: true });
    const migrateCopy = await ensureSkillLinks(context, ["copy"], { silent: true });
    assert.equal(migrateCopy.counts.migrated, 1);
    assert.equal(lstatSync(copyPath).isSymbolicLink(), true);
    assert.equal(await readFile(path.join(copyPath, "SKILL.md"), "utf8"), "# copy\n");

    // 4) 真实副本但内容不同 → conflict 且原样保留
    const differs = path.join(shareRoot, "differs");
    const canonicalDiffers = path.join(canonicalRoot, "differs");
    await mkdir(canonicalDiffers, { recursive: true });
    await writeFile(path.join(canonicalDiffers, "SKILL.md"), "# canonical\n");
    await mkdir(differs, { recursive: true });
    await writeFile(path.join(differs, "SKILL.md"), "# user edited\n");
    const conflicted = await ensureSkillLinks(context, ["differs"], { silent: true });
    assert.equal(conflicted.counts.conflict, 1);
    assert.equal(conflicted.conflicts[0].name, "differs");
    assert.equal(conflicted.conflicts[0].reason, "content-differs");
    assert.equal(await readFile(path.join(differs, "SKILL.md"), "utf8"), "# user edited\n");
  });
});

test("ensureSkillLinks never touches a link that points somewhere else", async () => {
  await withTempDirectory("avenic-foreign-", async (cwd) => {
    const context = createInstallContext(false, { cwd, environment: process.env });
    const canonical = await writeSkill(path.join(cwd, ".agents", "skills"), "alpha");
    const userTarget = await writeSkill(path.join(cwd, "user-skills"), "alpha");
    const linkPath = path.join(cwd, ".claude", "skills", "alpha");
    await linkUserSkill(userTarget, linkPath);
    const before = readlinkSync(linkPath);

    const result = await ensureSkillLinks(context, ["alpha"], { silent: true });
    assert.equal(result.counts.conflict, 1);
    assert.equal(result.counts.linked, 0);
    assert.equal(readlinkSync(linkPath), before, "the user's link is untouched");
    assert.equal(existsSync(path.join(userTarget, "SKILL.md")), true);
    assert.equal(existsSync(path.join(canonical, "SKILL.md")), true);
  });
});

test("ensureSkillLinks falls back to a copy when the platform refuses the link", async () => {
  await withTempDirectory("avenic-fallback-", async (cwd) => {
    const context = createInstallContext(false, { cwd, environment: process.env });
    await writeSkill(path.join(cwd, ".agents", "skills"), "alpha");
    const result = await ensureSkillLinks(context, ["alpha"], {
      silent: true,
      createLink: async () => {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      },
    });
    assert.equal(result.counts.fallback, 1);
    assert.equal(result.counts.linked, 0);
    const copyPath = path.join(cwd, ".claude", "skills", "alpha");
    assert.equal(lstatSync(copyPath).isSymbolicLink(), false);
    assert.equal(await readFile(path.join(copyPath, "SKILL.md"), "utf8"), "# alpha\n");
  });
});

test("formatLinkSummary is stable for CLI output", () => {
  assert.equal(
    formatLinkSummary({ linked: 2, migrated: 1, repaired: 0, fallback: 0, conflict: 0 }),
    "Linked 2 · Migrated 1 · Repaired 0 · Fallback 0 · Conflict 0",
  );
});

// spec §9.6：建链前 canonical 必须存在且是普通目录 —— 普通文件或链接一律不建链、不改动。
test("ensureSkillLinks never links to a canonical that is not a plain directory", async () => {
  await withTempDirectory("avenic-canonical-plain-", async (cwd) => {
    const context = createInstallContext(false, { cwd, environment: process.env });
    const canonicalRoot = path.join(cwd, ".agents", "skills");
    const shareRoot = path.join(cwd, ".claude", "skills");
    await mkdir(canonicalRoot, { recursive: true });

    // a) canonical 位置被普通文件占用
    const canonicalFile = path.join(canonicalRoot, "alpha");
    await writeFile(canonicalFile, "# not a directory\n");
    const asFile = await ensureSkillLinks(context, ["alpha"], { silent: true });
    assert.equal(asFile.counts.skipped, 1);
    assert.equal(asFile.counts.linked, 0);
    assert.equal(existsSync(path.join(shareRoot, "alpha")), false, "不建链");
    assert.equal(lstatSync(canonicalFile).isFile(), true, "canonical 文件未被改动");
    assert.equal(await readFile(canonicalFile, "utf8"), "# not a directory\n");

    // b) canonical 位置被符号链接（指向真实目录）占用
    await unlink(canonicalFile);
    const elsewhere = await writeSkill(path.join(cwd, "elsewhere"), "alpha");
    if (process.platform === "win32") {
      await symlink(path.resolve(elsewhere), canonicalFile, "junction");
    } else {
      await symlink(path.relative(canonicalRoot, elsewhere), canonicalFile, "dir");
    }
    const asLink = await ensureSkillLinks(context, ["alpha"], { silent: true });
    assert.equal(asLink.counts.skipped, 1);
    assert.equal(asLink.counts.linked, 0);
    assert.equal(existsSync(path.join(shareRoot, "alpha")), false, "不建链");
    assert.equal(lstatSync(canonicalFile).isSymbolicLink(), true, "canonical 链接未被改动");
    assert.equal(existsSync(path.join(elsewhere, "SKILL.md")), true, "链接目标未被改动");
  });
});

// 回归（评审 finding 1）：canonical 自身是符号链接时，能解析到真实目录的条目是可用的，必须保留；
// canonical 是普通文件（或链接解析不到）时条目才失效，才解除。
test("ensureSkillLinks keeps a working link to a symlinked canonical and removes a dead one", async () => {
  await withTempDirectory("avenic-symlinked-canonical-", async (cwd) => {
    const context = createInstallContext(false, { cwd, environment: process.env });
    const canonicalRoot = path.join(cwd, ".agents", "skills");
    const shareRoot = path.join(cwd, ".claude", "skills");
    await mkdir(canonicalRoot, { recursive: true });
    const canonicalPath = path.join(canonicalRoot, "alpha");
    const linkPath = path.join(shareRoot, "alpha");
    const linkCanonical = async (relative = false) => {
      if (process.platform === "win32") {
        await symlink(path.resolve(relative ? path.join(cwd, "missing", "alpha") : realTarget), canonicalPath, "junction");
      } else {
        await symlink(path.relative(canonicalRoot, relative ? path.join(cwd, "missing", "alpha") : realTarget), canonicalPath, "dir");
      }
    };

    // a) canonical 指向真实目录的符号链接 + 我方的链接 → 条目可用，一动不动
    const realTarget = await writeSkill(path.join(cwd, "real-skills"), "alpha");
    await linkCanonical();
    await linkUserSkill(canonicalPath, linkPath);
    assert.equal(await readFile(path.join(linkPath, "SKILL.md"), "utf8"), "# alpha\n", "调用前条目可读");
    const working = await ensureSkillLinks(context, ["alpha"], { silent: true });
    assert.equal(working.counts.unchanged, 1);
    assert.equal(working.counts.repaired, 0);
    assert.equal(working.counts.linked, 0);
    assert.equal(working.counts.skipped, 0);
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true, "条目仍在");
    assert.equal(await readFile(path.join(linkPath, "SKILL.md"), "utf8"), "# alpha\n", "仍可穿透读取");
    assert.equal(existsSync(path.join(realTarget, "SKILL.md")), true, "真身未被改动");

    // b) canonical 被换成普通文件 + 我方的链接 → 条目失效，解除；文件不动
    await unlink(canonicalPath);
    await writeFile(canonicalPath, "# plain file\n");
    const asFile = await ensureSkillLinks(context, ["alpha"], { silent: true });
    assert.equal(asFile.counts.repaired, 1);
    assert.equal(asFile.counts.linked, 0);
    assert.equal(lstatSync(linkPath, { throwIfNoEntry: false }), undefined, "失效条目已解除");
    assert.equal(await readFile(canonicalPath, "utf8"), "# plain file\n", "canonical 文件未被改动");

    // c) canonical 自身是解析不到的符号链接 + 我方的链接 → 条目失效，解除；canonical 链接不动
    await unlink(canonicalPath);
    await linkCanonical(true);
    await linkUserSkill(canonicalPath, linkPath);
    const dead = await ensureSkillLinks(context, ["alpha"], { silent: true });
    assert.equal(dead.counts.repaired, 1);
    assert.equal(dead.counts.linked, 0);
    assert.equal(lstatSync(linkPath, { throwIfNoEntry: false }), undefined, "失效条目已解除");
    assert.equal(lstatSync(canonicalPath).isSymbolicLink(), true, "canonical 链接本身未被改动");
  });
});

// 回归（评审 finding 2，spec §9.8）：连降级拷贝都放不下时也必须 resolve，不得让安装/启动中断。
test("ensureSkillLinks reports an unplaceable skill instead of rejecting", async () => {
  await withTempDirectory("avenic-unplaceable-", async (cwd) => {
    const context = createInstallContext(false, { cwd, environment: process.env });
    await writeSkill(path.join(cwd, ".agents", "skills"), "alpha");
    await mkdir(path.join(cwd, ".claude"), { recursive: true });
    const blocked = path.join(cwd, ".claude", "skills"); // 被普通文件占位：mkdir/cp 都放不下
    await writeFile(blocked, "not a directory\n");

    const result = await ensureSkillLinks(context, ["alpha"], {
      silent: true,
      createLink: async () => {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      },
    });
    assert.equal(result.counts.fallback, 0);
    assert.equal(result.counts.conflict, 1);
    assert.deepEqual(result.conflicts, [{ name: "alpha", targetId: "claude", reason: "unplaceable" }]);
    assert.equal(await readFile(blocked, "utf8"), "not a directory\n", "占位文件未被改动");
  });
});

// 回归（评审 finding 3）：解链失败时 repaired 不得撒谎（POSIX-only：Windows 忽略这些权限位）。
test("ensureSkillLinks counts an unremovable dead link as conflict, not repaired (POSIX)", async () => {
  if (process.platform !== "win32") {
    await withTempDirectory("avenic-unremovable-", async (root) => {
      const context = createInstallContext(false, { cwd: root, environment: process.env });
      const canonical = await writeSkill(path.join(root, ".agents", "skills"), "alpha");
      const shareRoot = path.join(root, ".claude", "skills");
      const linkPath = path.join(shareRoot, "alpha");
      await createSkillLink(canonical, linkPath);
      await rm(canonical, { recursive: true, force: true }); // 链接悬空
      try {
        await chmod(shareRoot, 0o500); // 只读父目录：unlink 失败
        const result = await ensureSkillLinks(context, ["alpha"], { silent: true });
        assert.equal(result.counts.repaired, 0, "没删掉就不能算 repaired");
        assert.equal(result.counts.conflict, 1);
        assert.equal(result.conflicts[0].reason, "unremovable");
        assert.equal(lstatSync(linkPath, { throwIfNoEntry: false })?.isSymbolicLink(), true, "悬空链接仍在");
      } finally {
        await chmod(shareRoot, 0o755);
      }
    });
  }
});

// 回归（评审 finding 5）：reason 决定文案，未知 reason 不得冒充"指向别处"。
test("logConflicts labels every reason instead of guessing", () => {
  const lines = [];
  logConflicts({ log: (line) => lines.push(line) }, [
    { name: "differs", targetId: "claude", reason: "content-differs" },
    { name: "foreign", targetId: "claude", reason: "points-elsewhere" },
    { name: "dead", targetId: "claude", reason: "unremovable" },
    { name: "stuck", targetId: "claude", reason: "unplaceable" },
    { name: "mystery", targetId: "claude", reason: "no-idea" },
  ]);
  assert.equal(lines[0], "⚠ differs: a copy exists and differs from the shared version — left untouched");
  assert.equal(lines[1], "⚠ foreign: a link points somewhere else — left untouched");
  assert.equal(lines[2], "⚠ dead: a broken link could not be removed — left untouched");
  assert.equal(lines[3], "⚠ stuck: neither a link nor a copy could be placed — left untouched");
  assert.doesNotMatch(lines[2], /points somewhere else/);
  assert.doesNotMatch(lines[3], /points somewhere else/);
  assert.match(lines[4], /needs attention/);
});

// F19(b) 回归：只读判定必须早于 canonical 可用性闸门 —— 否则 canonical 缺该技能时，
// 外来链接会被吞成 skipped（判定顺序的差异只在这个现场暴露）。
test("ensureSkillLinks reports foreign links under a missing canonical instead of skipping them", async () => {
  await withTempDirectory("avenic-missing-canonical-", async (cwd) => {
    const context = createInstallContext(false, { cwd, environment: process.env });
    const canonicalRoot = path.join(cwd, ".agents", "skills");
    const shareRoot = path.join(cwd, ".claude", "skills");
    await mkdir(canonicalRoot, { recursive: true }); // canonical 根在，但没有 alpha

    // a) 外来链接 → conflict（不是 skipped），链接与其 target 均不动
    const userTarget = await writeSkill(path.join(cwd, "user-skills"), "alpha");
    const foreign = path.join(shareRoot, "alpha");
    await linkUserSkill(userTarget, foreign);
    const before = readlinkSync(foreign);
    const linked = await ensureSkillLinks(context, ["alpha"], { silent: true });
    assert.equal(linked.counts.conflict, 1);
    assert.equal(linked.counts.skipped, 0, "只读判定不得被 canonical 闸门吞掉");
    assert.deepEqual(linked.conflicts, [{ name: "alpha", targetId: "claude", reason: "points-elsewhere" }]);
    assert.equal(readlinkSync(foreign), before, "外来链接未动");
    assert.equal(existsSync(path.join(userTarget, "SKILL.md")), true, "链接 target 未动");

    // b) 真实目录副本（F19(b) 有意保留的一半）→ skipped，副本原样保留
    await rm(foreign);
    const copy = path.join(shareRoot, "alpha");
    await mkdir(copy, { recursive: true });
    await writeFile(path.join(copy, "SKILL.md"), "# user copy\n");
    const copied = await ensureSkillLinks(context, ["alpha"], { silent: true });
    assert.equal(copied.counts.skipped, 1);
    assert.equal(copied.counts.conflict, 0);
    assert.equal(lstatSync(copy).isSymbolicLink(), false, "真实副本不得被替换");
    assert.equal(await readFile(path.join(copy, "SKILL.md"), "utf8"), "# user copy\n");
  });
});
