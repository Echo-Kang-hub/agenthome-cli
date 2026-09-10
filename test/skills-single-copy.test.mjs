import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { addDirectSkills, adoptSkills, createInstallContext, installCopies } from "../packages/core/src/index.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentBin = path.join(packageRoot, "packages", "cli", "scripts", "skills.mjs");

function runAgent(cwd, argumentsList, environment = {}) {
  return spawnSync(process.execPath, [agentBin, ...argumentsList], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...environment },
  });
}

function gitQuiet(cwd, argumentsList) {
  const result = spawnSync("git", ["-C", cwd, ...argumentsList], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function withTempDirectory(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function commitAll(root, message) {
  await gitQuiet(root, ["init", "--quiet", "-b", "main"]);
  await gitQuiet(root, ["add", "-A"]);
  await gitQuiet(root, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", message]);
}

async function createCatalogFixture(root) {
  await mkdir(path.join(root, "packs"), { recursive: true });
  await mkdir(path.join(root, "licenses"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "fixture-catalog", version: "1.0.0", private: true, agentSkills: { packageSpec: "fixture#main" } }, null, 2)}\n`,
  );
  await writeFile(
    path.join(root, "sources.lock.json"),
    `${JSON.stringify({ schemaVersion: 1, sources: [{ id: "test-source", name: "Test Source", repository: "https://github.com/example/test.git", skillRoot: "skills", revision: "a".repeat(40), licenseFile: "licenses/test-source-LICENSE" }] }, null, 2)}\n`,
  );
  await writeFile(path.join(root, "licenses", "test-source-LICENSE"), "license\n");
  for (const skillName of ["alpha", "beta", "gamma"]) {
    const directory = path.join(root, "skills", "test-source", skillName);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${skillName}\n---\n# ${skillName} v1\n`);
  }
  const common = { schemaVersion: 1, id: "common", name: "Common", sources: [{ source: "test-source", skills: ["alpha"] }] };
  const development = { schemaVersion: 1, id: "development", name: "Development", sources: [{ source: "test-source", skills: ["beta", "gamma"] }] };
  await writeFile(path.join(root, "packs", "common.json"), `${JSON.stringify(common, null, 2)}\n`);
  await writeFile(path.join(root, "packs", "development.json"), `${JSON.stringify(development, null, 2)}\n`);
  await commitAll(root, "fixture catalog");
}

// 改内容 + 换 revision 并提交：让下一次安装走"更新"路径（而不是 unchanged 快速路径）。
async function publishFixtureUpdate(root, skillName, content, revision) {
  await writeFile(path.join(root, "skills", "test-source", skillName, "SKILL.md"), content);
  const lockPath = path.join(root, "sources.lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.sources[0].revision = revision;
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  await gitQuiet(root, ["add", "-A"]);
  await gitQuiet(root, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", `update ${skillName}`]);
}

function catalogEnvironment(catalogRoot, stateRoot) {
  return { AVENIC_CATALOG_SPEC: catalogRoot, AVENIC_STATE_DIR: stateRoot };
}

async function isLink(target) {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

// --- 进程内安装辅助（走 core 源码，不经过 CLI）---

// 建链必败：模拟 link-hostile 文件系统（EPERM）。installCopies 的 createLink 透传用于此。
function failingCreateLink() {
  return async () => {
    throw Object.assign(new Error("EPERM: operation not permitted, symlink"), { code: "EPERM" });
  };
}

function upgradePacks(skillDirectory, revision) {
  return {
    groups: [
      {
        source: { id: "test-source", revision },
        skills: [{ name: "alpha", directory: skillDirectory, source: { id: "test-source", revision } }],
      },
    ],
  };
}

// v1 现场：canonical 真身 + share 位置上一个内容一致的**真实副本**（上一次建链失败留下的 fallback）。
async function buildV1FallbackState(root, content) {
  const canonical = path.join(root, ".agents", "skills", "alpha");
  await mkdir(canonical, { recursive: true });
  await writeFile(path.join(canonical, "SKILL.md"), content);
  const sharePath = path.join(root, ".claude", "skills", "alpha");
  await cp(canonical, sharePath, { recursive: true });
  return { canonical, sharePath };
}

async function writeUpstreamAlpha(root, content) {
  const directory = path.join(root, "upstream", "alpha");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), content);
  return directory;
}

async function runUpgrade(root, upstreamDirectory, options = {}) {
  const context = createInstallContext(false, { cwd: root, environment: process.env });
  const lines = [];
  const result = await installCopies(
    context,
    upgradePacks(upstreamDirectory, "b".repeat(40)),
    { log: (line) => lines.push(line) },
    options,
  );
  return { result, lines };
}

test("install keeps one physical copy and links the claude target", async () => {
  await withTempDirectory("avenic-single-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);
        const installed = runAgent(projectRoot, ["skills", "install"], environment);
        assert.equal(installed.status, 0, installed.stderr);
        assert.match(installed.stdout, /shared from agents/);

        const canonical = path.join(projectRoot, ".agents", "skills", "alpha", "SKILL.md");
        const shared = path.join(projectRoot, ".claude", "skills", "alpha");
        assert.equal(lstatSync(path.join(projectRoot, ".agents", "skills", "alpha")).isSymbolicLink(), false);
        assert.equal(await isLink(shared), true);
        assert.equal(await readFile(path.join(shared, "SKILL.md"), "utf8"), await readFile(canonical, "utf8"));
      });
    });
  });
});

test("regression: a fallback copy from a previous install upgrades to a link (no conflict)", async () => {
  await withTempDirectory("avenic-fallback-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);
        assert.equal(runAgent(projectRoot, ["skills", "install", "common"], environment).status, 0);

        // 模拟"上次安装时建链失败"的现场：真身内容 + 一个内容完全一致的真实副本。
        const copyPath = path.join(projectRoot, ".claude", "skills", "alpha");
        await unlink(copyPath);
        await cp(path.join(projectRoot, ".agents", "skills", "alpha"), copyPath, { recursive: true });
        assert.equal(await isLink(copyPath), false);

        await publishFixtureUpdate(catalogRoot, "alpha", "---\nname: alpha\n---\n# alpha v2\n", "b".repeat(40));
        const upgraded = runAgent(projectRoot, ["skills", "install"], environment);
        assert.equal(upgraded.status, 0, upgraded.stderr);
        assert.doesNotMatch(upgraded.stdout, /Conflict [1-9]/);
        assert.doesNotMatch(upgraded.stdout, /differs from the shared version/);

        assert.equal(await isLink(copyPath), true, "the fallback copy became a link");
        assert.equal(
          await readFile(path.join(copyPath, "SKILL.md"), "utf8"),
          await readFile(path.join(projectRoot, ".agents", "skills", "alpha", "SKILL.md"), "utf8"),
        );
        assert.match(await readFile(path.join(copyPath, "SKILL.md"), "utf8"), /alpha v2/);
      });
    });
  });
});

test("migrates a legacy double-copy layout into a link", async () => {
  await withTempDirectory("avenic-migrate-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);
        assert.equal(runAgent(projectRoot, ["skills", "install", "common"], environment).status, 0);
        const copyPath = path.join(projectRoot, ".claude", "skills", "alpha");
        await unlink(copyPath);
        await cp(path.join(projectRoot, ".agents", "skills", "alpha"), copyPath, { recursive: true });

        const reinstalled = runAgent(projectRoot, ["skills", "install"], environment);
        assert.equal(reinstalled.status, 0, reinstalled.stderr);
        assert.equal(await isLink(copyPath), true);
        assert.match(reinstalled.stdout, /Migrated [1-9]/);
      });
    });
  });
});

test("keeps a divergent copy and reports conflict, while still updating the shared copy", async () => {
  await withTempDirectory("avenic-conflict-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);
        assert.equal(runAgent(projectRoot, ["skills", "install", "common"], environment).status, 0);

        const copyPath = path.join(projectRoot, ".claude", "skills", "alpha");
        await unlink(copyPath);
        await cp(path.join(projectRoot, ".agents", "skills", "alpha"), copyPath, { recursive: true });
        await writeFile(path.join(copyPath, "SKILL.md"), "---\nname: alpha\n---\n# user edited\n");

        await publishFixtureUpdate(catalogRoot, "alpha", "---\nname: alpha\n---\n# alpha v3\n", "c".repeat(40));
        const upgraded = runAgent(projectRoot, ["skills", "install"], environment);
        assert.equal(upgraded.status, 0, upgraded.stderr);
        assert.match(upgraded.stdout, /Conflict 1/, "手改副本在安装层被报告为冲突（且只报一次）");
        assert.match(upgraded.stdout, /differs from the shared version/);
        assert.equal(await isLink(copyPath), false);
        assert.equal(await readFile(path.join(copyPath, "SKILL.md"), "utf8"), "---\nname: alpha\n---\n# user edited\n");
        assert.match(await readFile(path.join(projectRoot, ".agents", "skills", "alpha", "SKILL.md"), "utf8"), /alpha v3/);
      });
    });
  });
});

test("a link failure on the preflight pass is settled against the NEW canonical (no stale fallback, no false conflict)", async () => {
  const v1 = "---\nname: alpha\n---\n# alpha v1\n";
  const v2 = "---\nname: alpha\n---\n# alpha v2\n";

  // 敌意文件系统（建链必败）：预检趟不得把**旧** canonical 落成 fallback 副本——否则补链趟
  // 会把它当成用户手改的冲突，且降级副本永远停在旧版本。降级拷贝只允许发生在补链趟（新 canonical）。
  await withTempDirectory("avenic-hostile-", async (root) => {
    const { canonical, sharePath } = await buildV1FallbackState(root, v1);
    const upstream = await writeUpstreamAlpha(root, v2);
    const { result, lines } = await runUpgrade(root, upstream, { createLink: failingCreateLink() });

    assert.equal(await isLink(sharePath), false, "建链失败 → 降级为真实副本");
    assert.equal(await readFile(path.join(sharePath, "SKILL.md"), "utf8"), v2, "副本必须是新版本，不是旧版本");
    assert.match(await readFile(path.join(canonical, "SKILL.md"), "utf8"), /alpha v2/);
    assert.equal(result.counts.conflict, 0, "迁移过的旧副本不得被误判为冲突");
    assert.equal(result.counts.migrated, 0, "迁移发生在预检趟，补链趟只负责降级");
    assert.equal(result.counts.fallback, 1, "补链趟降级为 fallback");
    const output = lines.join("\n");
    assert.match(output, /Migrated 1 · Repaired 0 · Fallback 1 · Conflict 0/);
    assert.equal(lines.some((line) => /left untouched|differs from the shared version/.test(line)), false);
  });

  // 友好文件系统（默认 createLink）：同一现场 → 预检迁移并建链，补链趟只记 unchanged。
  await withTempDirectory("avenic-friendly-", async (root) => {
    const { canonical, sharePath } = await buildV1FallbackState(root, v1);
    const upstream = await writeUpstreamAlpha(root, v2);
    const { result, lines } = await runUpgrade(root, upstream);

    assert.equal(await isLink(sharePath), true);
    assert.equal(await readFile(path.join(sharePath, "SKILL.md"), "utf8"), v2);
    assert.match(await readFile(path.join(canonical, "SKILL.md"), "utf8"), /alpha v2/);
    assert.equal(result.counts.conflict, 0);
    assert.equal(result.counts.fallback, 0);
    assert.match(lines.join("\n"), /Migrated 1 · Repaired 0 · Fallback 0 · Conflict 0/);
  });
});

test("preflight covers stale names so a legacy copy cannot survive an uninstall", async () => {
  await withTempDirectory("avenic-stale-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);
        assert.equal(runAgent(projectRoot, ["skills", "development"], environment).status, 0);

        // beta 曾建链失败（遗留内容一致的真实副本），随后该技能被取消选择（dev 卸载 → 只剩 common）。
        // 预检必须覆盖"上次受管"的名字，否则 canonical 先被删、这份副本就判定不出归属。
        const copyPath = path.join(projectRoot, ".claude", "skills", "beta");
        await unlink(copyPath);
        await cp(path.join(projectRoot, ".agents", "skills", "beta"), copyPath, { recursive: true });

        const removed = runAgent(projectRoot, ["skills", "uninstall", "development"], environment);
        assert.equal(removed.status, 0, removed.stderr);
        assert.equal(existsSync(path.join(projectRoot, ".agents", "skills", "beta")), false, "canonical 已移除");
        assert.equal(
          lstatSync(copyPath, { throwIfNoEntry: false }),
          undefined,
          "share 侧不得残留孤儿副本/链接",
        );
        assert.doesNotMatch(removed.stdout, /Conflict [1-9]/);
        assert.doesNotMatch(removed.stdout, /differs from the shared version/);
      });
    });
  });
});

test("uninstall removes the shared copy and unlinks the claude target", async () => {
  await withTempDirectory("avenic-uninstall-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);
        assert.equal(runAgent(projectRoot, ["skills", "install"], environment).status, 0);
        const shared = path.join(projectRoot, ".claude", "skills", "alpha");
        assert.equal(await isLink(shared), true);

        const removed = runAgent(projectRoot, ["skills", "uninstall"], environment);
        assert.equal(removed.status, 0, removed.stderr);
        assert.equal(existsSync(shared), false, "link is gone");
        assert.equal(existsSync(path.join(projectRoot, ".agents", "skills", "alpha")), false);
        assert.equal(existsSync(path.join(projectRoot, ".claude", "skills", "alpha", "SKILL.md")), false);
        assert.equal(existsSync(path.join(projectRoot, ".claude", "skills")), false, "empty share root is removed");
        assert.equal(existsSync(path.join(projectRoot, ".agents", "skills")), false, "empty canonical root is removed");
      });
    });
  });
});

test("a user-owned link to another path survives uninstall and is reported", async () => {
  await withTempDirectory("avenic-foreign-uninstall-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);
        assert.equal(runAgent(projectRoot, ["skills", "install", "common"], environment).status, 0);

        const shared = path.join(projectRoot, ".claude", "skills", "alpha");
        await unlink(shared);
        const userTarget = path.join(projectRoot, "user-skills", "alpha");
        await mkdir(userTarget, { recursive: true });
        await writeFile(path.join(userTarget, "SKILL.md"), "user owned\n");
        if (process.platform === "win32") {
          await symlink(userTarget, shared, "junction");
        } else {
          await symlink(path.relative(path.dirname(shared), userTarget), shared, "dir");
        }

        const removed = runAgent(projectRoot, ["skills", "uninstall"], environment);
        assert.equal(removed.status, 0, removed.stderr);
        assert.equal(await isLink(shared), true, "the user's link is never unlinked");
        assert.equal(await readFile(path.join(userTarget, "SKILL.md"), "utf8"), "user owned\n");
        assert.match(removed.stdout, /points somewhere else/);
      });
    });
  });
});

// R2 钉死：按名删除以名字为授权 —— share 位置上的真实目录必须删除，绝不因内容不同而保留。
// sameTree 闸门只属于自动安装的迁移路径（spec §5.2/§11）；把它加进卸载路径会让这条变红。
test("uninstall removes a divergent real directory at a share target (name is the authorization)", async () => {
  await withTempDirectory("avenic-divergent-share-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);
        assert.equal(runAgent(projectRoot, ["skills", "install"], environment).status, 0);

        const shared = path.join(projectRoot, ".claude", "skills", "alpha");
        await rm(shared, { recursive: true, force: true });
        await mkdir(shared, { recursive: true });
        await writeFile(path.join(shared, "SKILL.md"), "---\nname: alpha\n---\n# user divergent\n");
        assert.equal(await isLink(shared), false, "现场是真实目录，不是链接");

        const removed = runAgent(projectRoot, ["skills", "uninstall"], environment);
        assert.equal(removed.status, 0, removed.stderr);
        assert.equal(existsSync(shared), false, "share 侧真实目录按名删除");
        assert.doesNotMatch(removed.stdout, /left untouched/, "显式按名删除不产生冲突");
        assert.match(removed.stdout, /^Uninstalled all managed project Skills: 2$/m, "share 删除 + canonical 删除都要计数");
      });
    });
  });
});

// R2 钉死（canonical 缺失分支）：canonical 里没有这个技能时，share 侧真实目录仍按名删除。
test("uninstall removes a divergent real directory at a share target when canonical lacks the skill", async () => {
  await withTempDirectory("avenic-divergent-no-canonical-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);
        assert.equal(runAgent(projectRoot, ["skills", "install"], environment).status, 0);

        await rm(path.join(projectRoot, ".agents", "skills", "alpha"), { recursive: true, force: true });
        const shared = path.join(projectRoot, ".claude", "skills", "alpha");
        await rm(shared, { recursive: true, force: true });
        await mkdir(shared, { recursive: true });
        await writeFile(path.join(shared, "SKILL.md"), "---\nname: alpha\n---\n# user divergent\n");

        const removed = runAgent(projectRoot, ["skills", "uninstall"], environment);
        assert.equal(removed.status, 0, removed.stderr);
        assert.equal(existsSync(shared), false, "canonical 缺失不影响按名删除 share 侧真实目录");
        assert.doesNotMatch(removed.stdout, /left untouched/, "不得报冲突");
        assert.match(removed.stdout, /^Uninstalled all managed project Skills: 1$/m, "只删了 share 侧这一份");
      });
    });
  });
});

// 建一个指向不存在路径的目录链接（悬空链接），win32 用 junction 避免权限位问题。
async function linkToMissing(linkPath, missingTarget) {
  if (process.platform === "win32") {
    await symlink(missingTarget, linkPath, "junction");
  } else {
    await symlink(path.relative(path.dirname(linkPath), missingTarget), linkPath, "dir");
  }
}

// R6 钉死：share 轮必须先于 canonical 轮。把 .claude/skills 本身做成指向 canonical 根的
// 别名后，只有在删除真身之前判定，才会识别出 aliases-canonical 并拒绝动它；顺序反转后
// 该冲突会静默消失（此时条目已随 canonical 一起不见，被当成 absent）。
// 别名根是链接：清理绝不跟随、绝不解除它（跨平台语义一致，win32 的 junction 也不得被移除）。
test("uninstall reports an aliased share root before the canonical pass deletes the copy", async () => {
  await withTempDirectory("avenic-alias-root-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);
        assert.equal(runAgent(projectRoot, ["skills", "install"], environment).status, 0);

        const shareRoot = path.join(projectRoot, ".claude", "skills");
        const canonicalRoot = path.join(projectRoot, ".agents", "skills");
        await rm(shareRoot, { recursive: true, force: true });
        if (process.platform === "win32") {
          await symlink(canonicalRoot, shareRoot, "junction");
        } else {
          await symlink(path.relative(path.dirname(shareRoot), canonicalRoot), shareRoot, "dir");
        }

        const removed = runAgent(projectRoot, ["skills", "uninstall"], environment);
        assert.equal(removed.status, 0, removed.stderr);
        assert.equal(removed.stderr, "", "链接形式的 destination 根不得让清理失败");
        assert.match(
          removed.stdout,
          /⚠ alpha: a folder link aliases the shared copy — left untouched/,
          "别名现场必须在 canonical 轮之前被报告",
        );
        assert.equal(existsSync(path.join(canonicalRoot, "alpha")), false, "真身仍由 canonical 轮删除");
        assert.equal(lstatSync(shareRoot).isSymbolicLink(), true, "别名根是链接，清理绝不解除它");
        assert.match(removed.stdout, /^Uninstalled all managed project Skills: 1$/m, "物理目录只删除一次");
      });
    });
  });
});

// 一般不变式钉死：destination 根本身是悬空链接时，清理必须 lstat-first——不跟随、不删除，
// 命令照常成功并完成 canonical 清理；重复卸载保持幂等。
test("uninstall survives a dangling link at the share root and never touches it", async () => {
  await withTempDirectory("avenic-dangling-root-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);
        assert.equal(runAgent(projectRoot, ["skills", "install"], environment).status, 0);

        const shareRoot = path.join(projectRoot, ".claude", "skills");
        const canonicalRoot = path.join(projectRoot, ".agents", "skills");
        await rm(shareRoot, { recursive: true, force: true });
        await linkToMissing(shareRoot, path.join(projectRoot, "missing-share-target"));
        assert.equal(await isLink(shareRoot), true);
        assert.equal(existsSync(shareRoot), false, "现场是悬空链接");

        const removed = runAgent(projectRoot, ["skills", "uninstall"], environment);
        assert.equal(removed.status, 0, removed.stderr);
        assert.equal(removed.stderr, "");
        assert.equal(lstatSync(shareRoot).isSymbolicLink(), true, "悬空链接不得被解除");
        assert.equal(existsSync(path.join(canonicalRoot, "alpha")), false, "canonical 真身照常删除");
        assert.match(removed.stdout, /^Uninstalled all managed project Skills: 1$/m);

        const repeated = runAgent(projectRoot, ["skills", "uninstall"], environment);
        assert.equal(repeated.status, 0, repeated.stderr);
        assert.equal(repeated.stderr, "");
        assert.equal(lstatSync(shareRoot).isSymbolicLink(), true, "第二次卸载仍不得动链接");
        assert.match(repeated.stdout, /No managed project Skills installation found/, "幂等：第二次是空操作");
      });
    });
  });
});

// R3 钉死：removeLinkSafely === false 时不得计为已删除，且必须以既有 unremovable 文案报告
// （POSIX-only：Windows 忽略这些权限位——测试照常运行但无意义，故跳过）。
test(
  "uninstall keeps an unremovable share link and reports it as a conflict (POSIX)",
  { skip: process.platform === "win32" ? "POSIX permissions only" : false },
  async () => {
    await withTempDirectory("avenic-unremovable-uninstall-", async (projectRoot) => {
      await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
        await withTempDirectory("avenic-state-", async (stateRoot) => {
          await createCatalogFixture(catalogRoot);
          const environment = catalogEnvironment(catalogRoot, stateRoot);
          assert.equal(runAgent(projectRoot, ["skills", "install"], environment).status, 0);

          const shareRoot = path.join(projectRoot, ".claude", "skills");
          const shared = path.join(shareRoot, "alpha");
          assert.equal(await isLink(shared), true);
          try {
            await chmod(shareRoot, 0o500); // 只读父目录：unlink 失败 → removeLinkSafely 返回 false
            const removed = runAgent(projectRoot, ["skills", "uninstall"], environment);
            assert.equal(removed.status, 0, removed.stderr);
            assert.equal(await isLink(shared), true, "没删掉就必须保留链接");
            assert.match(
              removed.stdout,
              /⚠ alpha: a broken link could not be removed — left untouched/,
              "复用既有 logConflicts 文案",
            );
            assert.match(removed.stdout, /^Uninstalled all managed project Skills: 1$/m, "未删除的链接不得计入删除数");
          } finally {
            await chmod(shareRoot, 0o755);
          }
        });
      });
    });
  },
);

// --- 直装（avenic skills add）走与 Pack 安装同一套共享语义（spec §5.4/§11）---

async function createDirectSource(sourceRoot, content = "---\nname: direct-skill\n---\n# direct v1\n") {
  await mkdir(path.join(sourceRoot, "skills", "direct-skill"), { recursive: true });
  await writeFile(path.join(sourceRoot, "skills", "direct-skill", "SKILL.md"), content);
  await commitAll(sourceRoot, "direct source");
}

// 上游发新版本并提交：让下一次 skills add 走完整安装路径，而不是 Already installed 快速返回。
async function publishDirectUpdate(sourceRoot, content) {
  await writeFile(path.join(sourceRoot, "skills", "direct-skill", "SKILL.md"), content);
  await gitQuiet(sourceRoot, ["add", "-A"]);
  await gitQuiet(sourceRoot, [
    "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "direct update",
  ]);
}

// 用相对符号链接指向 canonical 之外的路径（用户自己的技能目录）。
async function linkToUserSkill(userTarget, linkPath) {
  if (process.platform === "win32") {
    await symlink(userTarget, linkPath, "junction");
  } else {
    await symlink(path.relative(path.dirname(linkPath), userTarget), linkPath, "dir");
  }
}

test("direct install writes the canonical copy and links the claude target", async () => {
  await withTempDirectory("avenic-direct-src-", async (sourceRoot) => {
    await createDirectSource(sourceRoot);
    await withTempDirectory("avenic-direct-", async (projectRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        const environment = { AVENIC_STATE_DIR: stateRoot };
        const added = runAgent(projectRoot, ["skills", "add", sourceRoot], environment);
        assert.equal(added.status, 0, added.stderr);
        const shared = path.join(projectRoot, ".claude", "skills", "direct-skill");
        assert.equal(await isLink(shared), true, ".claude/skills/direct-skill 必须是指向 canonical 的链接");
        assert.equal(lstatSync(path.join(projectRoot, ".agents", "skills", "direct-skill")).isSymbolicLink(), false);
        // git 检出时可能按平台转换行尾（Windows 上为 CRLF），比较前归一化。
        assert.equal(
          (await readFile(path.join(shared, "SKILL.md"), "utf8")).replace(/\r\n/g, "\n"),
          "---\nname: direct-skill\n---\n# direct v1\n",
        );
        assert.match(added.stdout, /Claude Code \(shared from agents\)/);
      });
    });
  });
});

// 直装重装时，share 位置上的手改真实目录是用户的，不得被上游内容覆盖（spec §3.2/§5.1/§9.3）。
test("direct re-install leaves a divergent share directory untouched and reports a conflict", async () => {
  await withTempDirectory("avenic-direct-conflict-src-", async (sourceRoot) => {
    await createDirectSource(sourceRoot);
    await withTempDirectory("avenic-direct-conflict-", async (projectRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        const environment = { AVENIC_STATE_DIR: stateRoot };
        assert.equal(runAgent(projectRoot, ["skills", "add", sourceRoot], environment).status, 0);

        const shared = path.join(projectRoot, ".claude", "skills", "direct-skill");
        await rm(shared, { recursive: true, force: true });
        await mkdir(shared, { recursive: true });
        await writeFile(path.join(shared, "SKILL.md"), "---\nname: direct-skill\n---\n# user edited\n");

        await publishDirectUpdate(sourceRoot, "---\nname: direct-skill\n---\n# direct v2\n");
        const reinstalled = runAgent(projectRoot, ["skills", "add", sourceRoot], environment);
        assert.equal(reinstalled.status, 0, reinstalled.stderr);
        assert.match(
          reinstalled.stdout,
          /⚠ direct-skill: a copy exists and differs from the shared version — left untouched/,
        );
        assert.match(reinstalled.stdout, /Conflict 1/);
        assert.equal(await isLink(shared), false, "手改目录原样保留，不得换成链接");
        assert.equal(await readFile(path.join(shared, "SKILL.md"), "utf8"), "---\nname: direct-skill\n---\n# user edited\n");
        assert.match(
          await readFile(path.join(projectRoot, ".agents", "skills", "direct-skill", "SKILL.md"), "utf8"),
          /direct v2/,
          "canonical 仍是真身来源",
        );
      });
    });
  });
});

// 直装重装时，指向 canonical 之外的链接是别人的，绝不 unlink（spec §3.2/§9.7）。
test("direct re-install keeps a foreign share link and reports a conflict", async () => {
  await withTempDirectory("avenic-direct-foreign-src-", async (sourceRoot) => {
    await createDirectSource(sourceRoot);
    await withTempDirectory("avenic-direct-foreign-", async (projectRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        const environment = { AVENIC_STATE_DIR: stateRoot };
        assert.equal(runAgent(projectRoot, ["skills", "add", sourceRoot], environment).status, 0);

        const shared = path.join(projectRoot, ".claude", "skills", "direct-skill");
        await rm(shared, { recursive: true, force: true });
        const userTarget = path.join(projectRoot, "user-skills", "direct-skill");
        await mkdir(userTarget, { recursive: true });
        await writeFile(path.join(userTarget, "SKILL.md"), "user owned\n");
        await linkToUserSkill(userTarget, shared);

        await publishDirectUpdate(sourceRoot, "---\nname: direct-skill\n---\n# direct v2\n");
        const reinstalled = runAgent(projectRoot, ["skills", "add", sourceRoot], environment);
        assert.equal(reinstalled.status, 0, reinstalled.stderr);
        assert.match(reinstalled.stdout, /⚠ direct-skill: a link points somewhere else — left untouched/);
        assert.equal(await isLink(shared), true, "用户的链接绝不被 unlink");
        assert.equal(await readFile(path.join(userTarget, "SKILL.md"), "utf8"), "user owned\n");
        assert.match(
          await readFile(path.join(projectRoot, ".agents", "skills", "direct-skill", "SKILL.md"), "utf8"),
          /direct v2/,
        );
      });
    });
  });
});

// 直装 v1 现场：canonical 真身 + share 位置上一个内容一致的**真实副本**（上一次建链失败留下的 fallback）。
async function buildDirectFallbackState(root, content) {
  const canonical = path.join(root, ".agents", "skills", "direct-skill");
  await mkdir(canonical, { recursive: true });
  await writeFile(path.join(canonical, "SKILL.md"), content);
  const sharePath = path.join(root, ".claude", "skills", "direct-skill");
  await cp(canonical, sharePath, { recursive: true });
  return { canonical, sharePath };
}

// 进程内直装：走 core 源码并透传 createLink（模拟 link-hostile 文件系统），与 runUpgrade 对称。
async function runDirectAdd(root, sourceRoot, options = {}) {
  const context = createInstallContext(false, { cwd: root, environment: process.env });
  const lines = [];
  const result = await addDirectSkills(context, sourceRoot, ["direct-skill"], {
    io: { log: (line) => lines.push(line) },
    ...options,
  });
  return { result, lines };
}

// A1 的直装版：上次直装留下的一致性 fallback 副本必须升级为链接——预检趟在 canonical 被改写前
// 用旧内容判定归属；删掉预检调用后，副本会被当成用户手改的冲突，永远停在旧版本。
test("direct: a fallback copy from a previous direct install upgrades to a link (no conflict)", async () => {
  await withTempDirectory("avenic-direct-fallback-src-", async (sourceRoot) => {
    await createDirectSource(sourceRoot);
    await withTempDirectory("avenic-direct-fallback-", async (projectRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        const environment = { AVENIC_STATE_DIR: stateRoot };
        const added = runAgent(projectRoot, ["skills", "add", sourceRoot], environment);
        assert.equal(added.status, 0, added.stderr);

        // 模拟"上次安装时建链失败"的现场：真身内容 + 一个内容完全一致的真实副本。
        const shared = path.join(projectRoot, ".claude", "skills", "direct-skill");
        await unlink(shared);
        await cp(path.join(projectRoot, ".agents", "skills", "direct-skill"), shared, { recursive: true });
        assert.equal(await isLink(shared), false);

        await publishDirectUpdate(sourceRoot, "---\nname: direct-skill\n---\n# direct v2\n");
        const upgraded = runAgent(projectRoot, ["skills", "add", sourceRoot], environment);
        assert.equal(upgraded.status, 0, upgraded.stderr);
        assert.doesNotMatch(upgraded.stdout, /left untouched/);
        assert.doesNotMatch(upgraded.stdout, /Conflict [1-9]/);
        assert.match(upgraded.stdout, /Conflict 0/);

        const canonical = path.join(projectRoot, ".agents", "skills", "direct-skill", "SKILL.md");
        assert.equal(await isLink(shared), true, "fallback 副本升级为指向 canonical 的链接");
        assert.match(
          (await readFile(canonical, "utf8")).replace(/\r\n/g, "\n"),
          /direct v2/,
          "canonical 已是新版本",
        );
        assert.match(
          (await readFile(path.join(shared, "SKILL.md"), "utf8")).replace(/\r\n/g, "\n"),
          /direct v2/,
          "穿透链接读到的是新版本",
        );
      });
    });
  });
});

// 预检趟（restoreCopy: false）的直装版：此刻 canonical 还是旧版本，建链失败绝不允许把旧内容
// 落成 fallback 副本——否则补链趟会把它误判成冲突，降级副本永远停在旧版本。
test("direct: a link failure on the preflight pass is settled against the NEW canonical (no stale fallback)", async () => {
  const v1 = "---\nname: direct-skill\n---\n# direct v1\n";
  const v2 = "---\nname: direct-skill\n---\n# direct v2\n";

  await withTempDirectory("avenic-direct-hostile-src-", async (sourceRoot) => {
    await createDirectSource(sourceRoot, v1);
    await withTempDirectory("avenic-direct-hostile-", async (root) => {
      const { canonical, sharePath } = await buildDirectFallbackState(root, v1);
      await publishDirectUpdate(sourceRoot, v2);
      const { lines } = await runDirectAdd(root, sourceRoot, { createLink: failingCreateLink() });

      assert.equal(await isLink(sharePath), false, "建链失败 → 降级为真实副本");
      assert.equal(
        (await readFile(path.join(sharePath, "SKILL.md"), "utf8")).replace(/\r\n/g, "\n"),
        v2,
        "副本必须是新版本，不是被预检趟钉住的旧版本",
      );
      assert.match(await readFile(path.join(canonical, "SKILL.md"), "utf8"), /direct v2/);
      const output = lines.join("\n");
      assert.match(output, /Conflict 0/, "旧副本迁移不得被误判为冲突");
      assert.equal(lines.some((line) => /left untouched|differs from the shared version/.test(line)), false);
    });
  });
});

// repair 钉死：卸载路径上"指向 canonical 的悬空链接"仍是我方条目，必须删除；
// 把它当成需要保留的冲突会让这条变红（spec §5.2 表第一行含"悬空"）。
test("uninstall removes a dangling link that points at the missing canonical copy", async () => {
  await withTempDirectory("avenic-dangling-uninstall-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);
        assert.equal(runAgent(projectRoot, ["skills", "install"], environment).status, 0);

        const shared = path.join(projectRoot, ".claude", "skills", "alpha");
        assert.equal(await isLink(shared), true);
        await rm(path.join(projectRoot, ".agents", "skills", "alpha"), { recursive: true, force: true });
        assert.equal(await isLink(shared), true, "canonical 没了，链接悬空但仍存在");

        const removed = runAgent(projectRoot, ["skills", "uninstall"], environment);
        assert.equal(removed.status, 0, removed.stderr);
        assert.equal(lstatSync(shared, { throwIfNoEntry: false }), undefined, "悬空链接已移除");
        assert.doesNotMatch(removed.stdout, /left untouched/, "悬空链接是我方条目，不报冲突");
        assert.match(removed.stdout, /^Uninstalled all managed project Skills: 1$/m, "悬空链接的删除计入总数");
      });
    });
  });
});

// --- 接管（avenic skills adopt）走与安装/直装同一套共享语义（spec §5.3/§11）---

// 进程内接管：走 core 源码并透传 createLink（模拟 link-hostile 文件系统）。
async function runAdopt(root, names, options = {}) {
  const context = createInstallContext(false, { cwd: root, environment: process.env });
  const lines = [];
  const result = await adoptSkills(context, names, {
    io: { log: (line) => lines.push(line) },
    ...options,
  });
  return { result, lines, context };
}

test("adopt fills the canonical target and links the shared target", async () => {
  await withTempDirectory("avenic-adopt-link-", async (projectRoot) => {
    await withTempDirectory("avenic-state-", async (stateRoot) => {
      const environment = { AVENIC_STATE_DIR: stateRoot };
      const host = path.join(projectRoot, ".agents", "skills", "handmade");
      await mkdir(host, { recursive: true });
      await writeFile(path.join(host, "SKILL.md"), "---\nname: handmade\n---\n# handmade\n");

      const adopted = runAgent(projectRoot, ["skills", "adopt", "handmade"], environment);
      assert.equal(adopted.status, 0, adopted.stderr);
      const shared = path.join(projectRoot, ".claude", "skills", "handmade");
      assert.equal(await isLink(shared), true, ".claude/skills/handmade 必须是指向 canonical 的链接");
      assert.equal(await readFile(path.join(shared, "SKILL.md"), "utf8"), "---\nname: handmade\n---\n# handmade\n");
    });
  });
});

test("adopt migrates an identical copy at the share target into a link", async () => {
  const content = "---\nname: handmade\n---\n# handmade\n";
  await withTempDirectory("avenic-adopt-migrate-", async (root) => {
    const sharePath = path.join(root, ".claude", "skills", "handmade");
    await mkdir(sharePath, { recursive: true });
    await writeFile(path.join(sharePath, "SKILL.md"), content);
    const canonical = path.join(root, ".agents", "skills", "handmade");
    assert.equal(existsSync(canonical), false, "现场只有 .claude 一份真实副本");

    const { result, lines } = await runAdopt(root, ["handmade"]);
    assert.equal(lstatSync(canonical).isSymbolicLink(), false, "canonical 补齐为真实目录");
    assert.equal(await readFile(path.join(canonical, "SKILL.md"), "utf8"), content, "内容逐字节一致");
    assert.equal(await isLink(sharePath), true, "内容一致的真实副本迁移为链接");
    assert.equal(await readFile(path.join(sharePath, "SKILL.md"), "utf8"), content);
    assert.equal(result.linked, 1);
    // placed 语义：canonical 补齐 1 + share 位置由链接补齐 1（迁移也算本轮建立链接）。
    assert.equal(result.placed, 2);
    const output = lines.join("\n");
    assert.doesNotMatch(output, /left untouched/, "一致的副本不是冲突");
    assert.match(output, /Conflict 0/);
  });
});

test("adopt leaves a divergent copy at the share target and reports a conflict", async () => {
  await withTempDirectory("avenic-adopt-conflict-", async (projectRoot) => {
    await withTempDirectory("avenic-state-", async (stateRoot) => {
      const canonical = path.join(projectRoot, ".agents", "skills", "handmade");
      await mkdir(canonical, { recursive: true });
      await writeFile(path.join(canonical, "SKILL.md"), "---\nname: handmade\n---\n# v1\n");
      const sharePath = path.join(projectRoot, ".claude", "skills", "handmade");
      await mkdir(sharePath, { recursive: true });
      await writeFile(path.join(sharePath, "SKILL.md"), "---\nname: handmade\n---\n# user edited v2\n");

      const adopted = runAgent(projectRoot, ["skills", "adopt", "handmade"], { AVENIC_STATE_DIR: stateRoot });
      assert.equal(adopted.status, 0, adopted.stderr);
      assert.equal(await isLink(sharePath), false, "用户手改的目录原样保留");
      assert.equal(await readFile(path.join(sharePath, "SKILL.md"), "utf8"), "---\nname: handmade\n---\n# user edited v2\n");
      assert.equal(await readFile(path.join(canonical, "SKILL.md"), "utf8"), "---\nname: handmade\n---\n# v1\n", "canonical 不得被覆盖");
      assert.match(
        adopted.stdout,
        /⚠ handmade: a copy exists and differs from the shared version — left untouched/,
        "分歧副本必须被报告为冲突",
      );
      assert.match(adopted.stdout, /Conflict 1/, "摘要在 silent 之下不得吞掉冲突");
    });
  });
});

test("adopt keeps a foreign share link and reports a conflict", async () => {
  await withTempDirectory("avenic-adopt-foreign-", async (projectRoot) => {
    await withTempDirectory("avenic-state-", async (stateRoot) => {
      const canonical = path.join(projectRoot, ".agents", "skills", "handmade");
      await mkdir(canonical, { recursive: true });
      await writeFile(path.join(canonical, "SKILL.md"), "---\nname: handmade\n---\n# v1\n");
      const userTarget = path.join(projectRoot, "user-skills", "handmade");
      await mkdir(userTarget, { recursive: true });
      await writeFile(path.join(userTarget, "SKILL.md"), "user owned\n");
      const sharePath = path.join(projectRoot, ".claude", "skills", "handmade");
      await mkdir(path.dirname(sharePath), { recursive: true }); // junction 的父目录必须先存在
      await linkToUserSkill(userTarget, sharePath);
      const before = readlinkSync(sharePath);

      const adopted = runAgent(projectRoot, ["skills", "adopt", "handmade"], { AVENIC_STATE_DIR: stateRoot });
      assert.equal(adopted.status, 0, adopted.stderr);
      assert.equal(await isLink(sharePath), true, "用户的链接绝不被 unlink");
      assert.equal(readlinkSync(sharePath), before, "链接的 target 原样保留");
      assert.equal(await readFile(path.join(userTarget, "SKILL.md"), "utf8"), "user owned\n", "链接目标内容不得被改动");
      assert.match(adopted.stdout, /⚠ handmade: a link points somewhere else — left untouched/);
      assert.match(adopted.stdout, /Conflict 1/);
    });
  });
});

// R2 钉死：接管必须透传 createLink，建链失败时按 §10 降级为真实副本而不是抛错。
// 预检迁移删掉 share 位置的真实副本后建链失败 → cp 回一份新内容（不是旧内容、不是半成品）。
test("adopt degrades to a copy at the share target when link creation fails", async () => {
  const content = "---\nname: handmade\n---\n# handmade\n";
  await withTempDirectory("avenic-adopt-hostile-", async (root) => {
    const sharePath = path.join(root, ".claude", "skills", "handmade");
    await mkdir(sharePath, { recursive: true });
    await writeFile(path.join(sharePath, "SKILL.md"), content);
    const canonical = path.join(root, ".agents", "skills", "handmade");

    const { result, lines } = await runAdopt(root, ["handmade"], { createLink: failingCreateLink() });
    assert.equal(await isLink(sharePath), false, "建链失败 → 降级为真实副本");
    assert.equal(await readFile(path.join(sharePath, "SKILL.md"), "utf8"), content, "降级副本内容取自 canonical");
    assert.equal(await readFile(path.join(canonical, "SKILL.md"), "utf8"), content, "canonical 已从 host 补齐");
    assert.equal(result.linked, 0);
    // placed 语义：只有 canonical 补齐计 1；share 位置降级为拷贝，不是链接，不计入 linked。
    assert.equal(result.placed, 1);
    const output = lines.join("\n");
    assert.match(output, /Linked 0 · Migrated 1 · Repaired 0 · Fallback 1 · Conflict 0/);
    assert.doesNotMatch(output, /left untouched/, "降级不是冲突");
  });
});

// --- 启动补齐（§5.5）：PATH 上放一个假的官方 CLI，由它写标记文件证明确实被拉起 ---

async function withFakeAgentCli(run) {
  await withTempDirectory("avenic-launch-bin-", async (binDirectory) => {
    const windows = process.platform === "win32";
    // Windows 的 .ps1 shim 由运行时经 PowerShell 解析执行（与 runtime.test.mjs 同法）；
    // POSIX 上是可执行的 sh 脚本。两者都只在 AVENIC_LAUNCH_MARK 存在时写标记。
    const script = windows
      ? "if ($env:AVENIC_LAUNCH_MARK) { Set-Content -Path $env:AVENIC_LAUNCH_MARK -Value launched }\nexit 0\n"
      : "#!/bin/sh\nif [ -n \"$AVENIC_LAUNCH_MARK\" ]; then printf 'launched\\n' > \"$AVENIC_LAUNCH_MARK\"; fi\nexit 0\n";
    const fake = path.join(binDirectory, windows ? "claude.ps1" : "claude");
    await writeFile(fake, script);
    if (!windows) await chmod(fake, 0o755);
    await run(binDirectory);
  });
}

// 启动用的环境：假的 CLI 目录在 PATH 最前。catalogRoot 可为空（纯启动测试不需要 catalog）。
function launchEnvironment(binDirectory, stateRoot, catalogRoot = null) {
  const environment = {
    PATH: `${binDirectory}${path.delimiter}${process.env.PATH}`,
    Path: `${binDirectory}${path.delimiter}${process.env.PATH}`,
    AVENIC_STATE_DIR: stateRoot,
  };
  if (catalogRoot) environment.AVENIC_CATALOG_SPEC = catalogRoot;
  return environment;
}

function launchMarker(projectRoot) {
  return path.join(projectRoot, "launched.txt");
}

test("launching an agent repairs a missing link and never touches unmanaged skills", async () => {
  await withFakeAgentCli(async (binDirectory) => {
    await withTempDirectory("avenic-launch-", async (projectRoot) => {
      await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
        await withTempDirectory("avenic-state-", async (stateRoot) => {
          await createCatalogFixture(catalogRoot);
          const environment = launchEnvironment(binDirectory, stateRoot, catalogRoot);
          assert.equal(runAgent(projectRoot, ["claude", "init", "--sessions", "global"], environment).status, 0);
          assert.equal(runAgent(projectRoot, ["skills", "install", "common"], environment).status, 0);

          // 外部（未受管）技能混在 canonical 里：启动补齐不得给它建链接。
          const unmanaged = path.join(projectRoot, ".agents", "skills", "outsider");
          await mkdir(unmanaged, { recursive: true });
          await writeFile(path.join(unmanaged, "SKILL.md"), "outsider\n");

          const shared = path.join(projectRoot, ".claude", "skills", "alpha");
          await unlink(shared); // 模拟 clone 后只有真身、没有链接
          assert.equal(await isLink(shared), false);

          const marker = launchMarker(projectRoot);
          const launched = runAgent(projectRoot, ["claude"], { ...environment, AVENIC_LAUNCH_MARK: marker });
          assert.equal(launched.status, 0, launched.stderr);
          assert.equal(existsSync(marker), true, "the agent was launched");
          assert.equal(await isLink(shared), true, "launch repaired the link");
          assert.equal(existsSync(path.join(projectRoot, ".claude", "skills", "outsider")), false, "unmanaged skills are not linked");
          assert.match(launched.stdout, /Skills shared: Linked 1/, "the repaired link is reported");
        });
      });
    });
  });
});

test("launching without any installed skills creates nothing and stays quiet", async () => {
  await withFakeAgentCli(async (binDirectory) => {
    await withTempDirectory("avenic-launch-empty-", async (projectRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        const environment = launchEnvironment(binDirectory, stateRoot);
        assert.equal(runAgent(projectRoot, ["claude", "init", "--sessions", "global"], environment).status, 0);

        const marker = launchMarker(projectRoot);
        const launched = runAgent(projectRoot, ["claude"], { ...environment, AVENIC_LAUNCH_MARK: marker });
        assert.equal(launched.status, 0, launched.stderr);
        assert.equal(existsSync(marker), true, "the agent was launched");
        assert.equal(existsSync(path.join(projectRoot, ".claude", "skills")), false, "no share directory is created");
        assert.equal(existsSync(path.join(projectRoot, ".agents", "skills")), false, "no canonical directory is created");
        assert.doesNotMatch(`${launched.stdout}${launched.stderr}`, /Skills shared:/);
      });
    });
  });
});

test("launch repair follows the managed set only, never a directory scan", async () => {
  await withFakeAgentCli(async (binDirectory) => {
    await withTempDirectory("avenic-launch-unmanaged-", async (projectRoot) => {
      await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
        await withTempDirectory("avenic-state-", async (stateRoot) => {
          await createCatalogFixture(catalogRoot);
          const environment = launchEnvironment(binDirectory, stateRoot, catalogRoot);
          assert.equal(runAgent(projectRoot, ["claude", "init", "--sessions", "global"], environment).status, 0);
          assert.equal(runAgent(projectRoot, ["skills", "install", "common"], environment).status, 0);

          // 受管记录清零：锁文件仍在，但没有任何技能归 Avenic 管。
          await writeFile(
            path.join(projectRoot, ".avenic.lock.json"),
            `${JSON.stringify({ schemaVersion: 3, sources: [], adopted: [], directSources: [] }, null, 2)}\n`,
          );
          // 现场只剩未受管的 canonical 真身，分享位置整体缺席。
          const skillsDirectory = path.join(projectRoot, ".claude", "skills");
          await unlink(path.join(skillsDirectory, "alpha"));
          await rm(skillsDirectory, { recursive: true, force: true });
          const unmanaged = path.join(projectRoot, ".agents", "skills", "outsider");
          await mkdir(unmanaged, { recursive: true });
          await writeFile(path.join(unmanaged, "SKILL.md"), "outsider\n");

          const marker = launchMarker(projectRoot);
          const launched = runAgent(projectRoot, ["claude"], { ...environment, AVENIC_LAUNCH_MARK: marker });
          assert.equal(launched.status, 0, launched.stderr);
          assert.equal(existsSync(marker), true, "the agent was launched");
          assert.equal(existsSync(skillsDirectory), false, "unmanaged skills must not be linked");
          assert.equal(existsSync(path.join(unmanaged, "SKILL.md")), true, "unmanaged skills are left untouched");
          assert.doesNotMatch(`${launched.stdout}${launched.stderr}`, /Skills shared:/);
        });
      });
    });
  });
});

test("a failing repair prints one warning and still launches the agent", async () => {
  await withFakeAgentCli(async (binDirectory) => {
    await withTempDirectory("avenic-launch-fail-", async (projectRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        const environment = launchEnvironment(binDirectory, stateRoot);
        assert.equal(runAgent(projectRoot, ["claude", "init", "--sessions", "global"], environment).status, 0);

        // 损坏的锁文件：managedSkillNames 的 readJson 必抛（JSON.parse 语法错误）。
        // 触发点与平台无关——不依赖权限位、文件占用、长路径等平台差异。
        await writeFile(path.join(projectRoot, ".avenic.lock.json"), "{ this is not json\n");

        const marker = launchMarker(projectRoot);
        const launched = runAgent(projectRoot, ["claude"], { ...environment, AVENIC_LAUNCH_MARK: marker });
        assert.equal(launched.status, 0, launched.stderr);
        assert.equal(existsSync(marker), true, "the agent was launched despite the repair failure");
        const output = `${launched.stdout}${launched.stderr}`;
        const warnings = output.split(/\r?\n/).filter((line) => line.includes("Skills repair skipped"));
        assert.equal(warnings.length, 1, output);
        assert.match(launched.stderr, /⚠ Skills repair skipped: Cannot parse JSON file/);
      });
    });
  });
});

test("a healthy installation launches without repair noise", async () => {
  await withFakeAgentCli(async (binDirectory) => {
    await withTempDirectory("avenic-launch-healthy-", async (projectRoot) => {
      await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
        await withTempDirectory("avenic-state-", async (stateRoot) => {
          await createCatalogFixture(catalogRoot);
          const environment = launchEnvironment(binDirectory, stateRoot, catalogRoot);
          assert.equal(runAgent(projectRoot, ["claude", "init", "--sessions", "global"], environment).status, 0);
          assert.equal(runAgent(projectRoot, ["skills", "install", "common"], environment).status, 0);

          const marker = launchMarker(projectRoot);
          const launched = runAgent(projectRoot, ["claude"], { ...environment, AVENIC_LAUNCH_MARK: marker });
          assert.equal(launched.status, 0, launched.stderr);
          assert.equal(existsSync(marker), true, "the agent was launched");
          const output = `${launched.stdout}${launched.stderr}`;
          assert.doesNotMatch(output, /Skills shared:/, "nothing needed repair");
          assert.doesNotMatch(output, /⚠/, "no conflicts are reported");
        });
      });
    });
  });
});
