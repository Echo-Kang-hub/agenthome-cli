import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createInstallContext, installCopies } from "../packages/core/src/index.mjs";

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

// R6 钉死：share 轮必须先于 canonical 轮。把 .claude/skills 本身做成指向 canonical 根的
// 别名后，只有在删除真身之前判定，才会识别出 aliases-canonical 并拒绝动它；顺序反转后
// 该冲突会静默消失（此时条目已随 canonical 一起不见，被当成 absent）。
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
        assert.match(
          removed.stdout,
          /⚠ alpha: a folder link aliases the shared copy — left untouched/,
          "别名现场必须在 canonical 轮之前被报告",
        );
        assert.equal(existsSync(path.join(canonicalRoot, "alpha")), false, "真身仍由 canonical 轮删除");
        assert.equal(existsSync(shareRoot), false, "别名根随空目录清理移除");
        assert.match(removed.stdout, /^Uninstalled all managed project Skills: 1$/m, "物理目录只删除一次");
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
