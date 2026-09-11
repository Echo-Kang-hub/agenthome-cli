import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getProfile,
  listProfiles,
  modelsFile,
  modelsTempRoot,
  readLibrary,
  removeProfile,
  transact,
  upsertProfile,
} from "../packages/core/src/index.mjs";

async function withTempDirectory(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function environmentFor(stateDir) {
  return { AVENIC_STATE_DIR: stateDir };
}

test("upsertProfile writes a versioned library with 0600 permissions", async () => {
  await withTempDirectory("avenic-lib-", async (stateDir) => {
    const environment = environmentFor(stateDir);
    assert.equal((await readLibrary(environment)).exists, false);

    const first = await upsertProfile(environment, {
      id: "mimo",
      name: "小米 MiMo",
      endpoint: { baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic", api: "anthropic", apiKey: "sk-aaaabbbbccccdddd" },
      models: { main: { id: "mimo-v2.5-pro" } },
    });
    assert.equal(first.changed, true);
    assert.equal(first.revision, 1);

    const stored = JSON.parse(await readFile(modelsFile(environment), "utf8"));
    assert.equal(stored.schemaVersion, 1);
    assert.equal(stored.revision, 1);
    assert.equal(stored.profiles.mimo.endpoint.apiKey, "sk-aaaabbbbccccdddd");
    assert.equal(stored.profiles.mimo.createdAt, stored.profiles.mimo.updatedAt);

    const second = await upsertProfile(environment, { ...stored.profiles.mimo, name: "MiMo 2" });
    assert.equal(second.revision, 2);
    const profiles = await listProfiles(environment);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].name, "MiMo 2");
    assert.equal(profiles[0].createdAt, stored.profiles.mimo.createdAt);

    const removed = await removeProfile(environment, "mimo");
    assert.equal(removed.changed, true);
    assert.deepEqual(await listProfiles(environment), []);
    assert.equal(await getProfile(environment, "mimo"), null);
  });
});

test("removeProfile on an unknown id changes nothing", async () => {
  await withTempDirectory("avenic-lib-missing-", async (stateDir) => {
    const environment = environmentFor(stateDir);
    await upsertProfile(environment, { id: "a", name: "A", endpoint: { baseUrl: "https://a.example", api: "anthropic", apiKey: "k" } });
    const result = await removeProfile(environment, "nope");
    assert.equal(result.changed, false);
    assert.equal((await readLibrary(environment)).revision, 1);
  });
});

test("a broken library file fails loudly and is never overwritten", async () => {
  await withTempDirectory("avenic-lib-broken-", async (stateDir) => {
    const environment = environmentFor(stateDir);
    const file = modelsFile(environment);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{ not json");
    await assert.rejects(() => readLibrary(environment), /Cannot parse JSON file/);
    await assert.rejects(
      () => upsertProfile(environment, { id: "a", name: "A", endpoint: { baseUrl: "https://a.example", api: "anthropic", apiKey: "k" } }),
      /Cannot parse JSON file/,
    );
    assert.equal(await readFile(file, "utf8"), "{ not json");
  });
});

test("transact rolls both files back when the second rename fails", async () => {
  await withTempDirectory("avenic-tx-", async (root) => {
    const first = path.join(root, "a.json");
    const second = path.join(root, "b.json");
    await writeFile(first, "old-a");
    await writeFile(second, "old-b");
    let renames = 0;
    await assert.rejects(
      () => transact({
        tempRoot: path.join(root, "tmp"),
        read: async () => ({ revision: 0, value: { first: await readFile(first, "utf8"), second: await readFile(second, "utf8") } }),
        build: () => ({ first: "new-a", second: "new-b" }),
        stage: async (next, directory) => {
          const staged = [];
          for (const [name, target] of [["a.json", first], ["b.json", second]]) {
            const file = path.join(directory, "staged", name);
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, next[name === "a.json" ? "first" : "second"]);
            staged.push({ relativePath: name, staged: file, target });
          }
          return staged;
        },
        rename: async (from, to) => {
          renames += 1;
          if (renames === 4) throw new Error("disk full"); // 第 2 个文件的 staged→target
          const { rename } = await import("node:fs/promises");
          return rename(from, to);
        },
      }),
      /disk full/,
    );
    assert.equal(await readFile(first, "utf8"), "old-a");
    assert.equal(await readFile(second, "utf8"), "old-b");
  });
});

test("transact replays when the revision changed under it", async () => {
  await withTempDirectory("avenic-tx-replay-", async (root) => {
    const target = path.join(root, "value.json");
    await writeFile(target, "0");
    let reads = 0;
    let builds = 0;
    const result = await transact({
      tempRoot: path.join(root, "tmp"),
      read: async () => {
        reads += 1;
        // 第一次替换前"另一个进程"写入了新内容：版本戳变化 → 本实现重读重放
        if (reads === 2) await writeFile(target, "external");
        return { revision: reads === 1 ? 0 : 1, value: await readFile(target, "utf8") };
      },
      build: (current) => {
        builds += 1;
        return current.value === "external" ? null : String(Number(current.value) + 1);
      },
      stage: async (next, directory) => {
        const file = path.join(directory, "staged", "value.json");
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, next);
        return [{ relativePath: "value.json", staged: file, target }];
      },
    });
    assert.equal(result.changed, false, "the replayed build saw the external value and opted out");
    assert.equal(await readFile(target, "utf8"), "external");
    assert.equal(builds, 2);
  });
});

test("upserts leave no temporary directories behind and the file is 0600 on POSIX", async () => {
  await withTempDirectory("avenic-lib-clean-", async (stateDir) => {
    const environment = environmentFor(stateDir);
    await upsertProfile(environment, { id: "a", name: "A", endpoint: { baseUrl: "https://a.example", api: "anthropic", apiKey: "k" } });
    await upsertProfile(environment, { id: "b", name: "B", endpoint: { baseUrl: "https://b.example", api: "anthropic", apiKey: "k" } });
    await removeProfile(environment, "b");
    const tempRoot = modelsTempRoot(environment);
    assert.deepEqual(existsSync(tempRoot) ? await readdir(tempRoot) : [], []);
    if (process.platform !== "win32") {
      assert.equal((await stat(modelsFile(environment))).mode & 0o777, 0o600);
    }
  });
});

test("a failed transact removes its temp directory too", async () => {
  await withTempDirectory("avenic-tx-clean-", async (root) => {
    const tempRoot = path.join(root, "tmp");
    await assert.rejects(
      () => transact({
        tempRoot,
        read: async () => ({ revision: 0, value: null }),
        build: () => "next",
        stage: async () => { throw new Error("stage failed"); },
      }),
      /stage failed/,
    );
    assert.deepEqual(existsSync(tempRoot) ? await readdir(tempRoot) : [], []);
  });
});
