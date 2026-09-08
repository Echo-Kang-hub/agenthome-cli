import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  adoptPackedSkills,
  createInstallContext,
  installPacks,
  planAdoptSkills,
  skillsInstallationStatus,
} from "../packages/core/src/index.mjs";

async function withTempDirectory(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function commitAll(dir, message) {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", message], { cwd: dir });
}

// 本地 git fixture：common = alpha；development = beta + gamma（同一来源 test-source）
async function createCatalogFixture(root) {
  await mkdir(path.join(root, "packs"), { recursive: true });
  await mkdir(path.join(root, "skills", "test-source"), { recursive: true });
  for (const skillName of ["alpha", "beta", "gamma"]) {
    const directory = path.join(root, "skills", "test-source", skillName);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${skillName}\n---\n`);
  }
  await writeFile(
    path.join(root, "sources.lock.json"),
    `${JSON.stringify({ schemaVersion: 1, sources: [{ id: "test-source", name: "Test Source", repository: "https://github.com/example/test.git", skillRoot: "skills", revision: "a".repeat(40) }] }, null, 2)}\n`,
  );
  await writeFile(path.join(root, "packs", "common.json"), `${JSON.stringify({ schemaVersion: 1, id: "common", name: "Common", sources: [{ source: "test-source", skills: ["alpha"] }] }, null, 2)}\n`);
  await writeFile(path.join(root, "packs", "development.json"), `${JSON.stringify({ schemaVersion: 1, id: "development", name: "Development", sources: [{ source: "test-source", skills: ["beta", "gamma"] }] }, null, 2)}\n`);
  await commitAll(root, "fixture catalog");
}

function testEnvironment(catalogRoot, stateRoot) {
  return { AVENIC_CATALOG_SPEC: catalogRoot, AVENIC_STATE_DIR: stateRoot };
}

test("planAdoptSkills ranks the best-matching pack by coverage", async () => {
  await withTempDirectory("avenic-adopt-", async (project) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const context = createInstallContext(false, { cwd: project, environment: testEnvironment(catalogRoot, stateRoot) });
        await mkdir(path.join(project, ".agents", "skills", "beta"), { recursive: true });
        await mkdir(path.join(project, ".agents", "skills", "gamma"), { recursive: true });
        for (const name of ["beta", "gamma"]) {
          await writeFile(path.join(project, ".agents", "skills", name, "SKILL.md"), `# ${name}`);
        }
        const plan = await planAdoptSkills(context, ["beta", "gamma"]);
        assert.deepEqual(plan.candidates.map((c) => c.packId), ["development"]);
        assert.equal(plan.best?.coverage, 1);
        assert.deepEqual(plan.best?.matched, ["beta", "gamma"]);
      });
    });
  });
});

test("planAdoptSkills returns no candidate for unknown disk skills", async () => {
  await withTempDirectory("avenic-adopt-", async (project) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const context = createInstallContext(false, { cwd: project, environment: testEnvironment(catalogRoot, stateRoot) });
        await mkdir(path.join(project, ".agents", "skills", "mystery"), { recursive: true });
        await writeFile(path.join(project, ".agents", "skills", "mystery", "SKILL.md"), "# mystery");
        const plan = await planAdoptSkills(context, ["mystery"]);
        assert.deepEqual(plan.candidates, []);
        assert.equal(plan.best, null);
      });
    });
  });
});

test("adoptPackedSkills fills every target and writes pack metadata", async () => {
  await withTempDirectory("avenic-adopt-", async (project) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const context = createInstallContext(false, { cwd: project, environment: testEnvironment(catalogRoot, stateRoot) });
        // 仅 .agents 有 beta（旧版安装残留），development 还应含 gamma
        await mkdir(path.join(project, ".agents", "skills", "beta"), { recursive: true });
        await writeFile(path.join(project, ".agents", "skills", "beta", "SKILL.md"), "# beta");
        const result = await adoptPackedSkills(context, ["beta"], "development");
        assert.equal(result.packId, "development");
        assert.deepEqual(result.names, ["beta", "gamma"]);
        for (const target of [".agents", ".claude"]) {
          for (const name of ["beta", "gamma"]) {
            assert.ok(existsSync(path.join(project, target, "skills", name, "SKILL.md")), `${target}/${name}`);
          }
        }
        const config = JSON.parse(await readFile(path.join(project, ".avenic.json"), "utf8"));
        assert.deepEqual(config.packs, ["development"]);
        const lock = JSON.parse(await readFile(path.join(project, ".avenic.lock.json"), "utf8"));
        assert.ok(lock.packs.some((p) => p.id === "development"));
        const source = lock.sources.find((s) => s.id === "test-source");
        assert.deepEqual(source.skills, ["beta", "gamma"]);
        const status = await skillsInstallationStatus(context);
        assert.deepEqual(status.names, ["beta", "gamma"]);
        assert.ok(status.targets.every((t) => t.complete));
      });
    });
  });
});

test("adoptPackedSkills keeps previously managed records and never removes them", async () => {
  await withTempDirectory("avenic-adopt-", async (project) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const context = createInstallContext(false, { cwd: project, environment: testEnvironment(catalogRoot, stateRoot) });
        // 先正规安装 common（alpha），再手工放入未托管的 beta（仅 .agents）
        await installPacks(context, ["common"]);
        await mkdir(path.join(project, ".agents", "skills", "beta"), { recursive: true });
        await writeFile(path.join(project, ".agents", "skills", "beta", "SKILL.md"), "# beta");
        await adoptPackedSkills(context, ["beta"], "development");
        // alpha 文件不得被接管式清理删除
        assert.ok(existsSync(path.join(project, ".agents", "skills", "alpha", "SKILL.md")));
        assert.ok(existsSync(path.join(project, ".claude", "skills", "alpha", "SKILL.md")));
        const config = JSON.parse(await readFile(path.join(project, ".avenic.json"), "utf8"));
        assert.deepEqual(config.packs, ["common", "development"]);
        const lock = JSON.parse(await readFile(path.join(project, ".avenic.lock.json"), "utf8"));
        const source = lock.sources.find((s) => s.id === "test-source");
        assert.deepEqual(source.skills, ["alpha", "beta", "gamma"], "同来源 skills 并集合并");
        const status = await skillsInstallationStatus(context);
        assert.deepEqual(status.names, ["alpha", "beta", "gamma"]);
      });
    });
  });
});

test("adoptPackedSkills rejects names outside the chosen pack", async () => {
  await withTempDirectory("avenic-adopt-", async (project) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const context = createInstallContext(false, { cwd: project, environment: testEnvironment(catalogRoot, stateRoot) });
        await mkdir(path.join(project, ".agents", "skills", "alpha"), { recursive: true });
        await writeFile(path.join(project, ".agents", "skills", "alpha", "SKILL.md"), "# alpha");
        await assert.rejects(adoptPackedSkills(context, ["alpha"], "development"), /alpha/);
      });
    });
  });
});
