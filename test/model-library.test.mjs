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

test("the persisted library keeps only the schema keys and no machine-local data", async () => {
  await withTempDirectory("avenic-lib-shape-", async (stateDir) => {
    const environment = environmentFor(stateDir);
    await upsertProfile(environment, { id: "a", name: "A", endpoint: { baseUrl: "https://a.example", api: "anthropic", apiKey: "k" } });
    const raw = await readFile(modelsFile(environment), "utf8");
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["profiles", "revision", "schemaVersion"]);
    assert.equal(raw.includes(String(process.pid)), false, "the pid must never be persisted");
    assert.equal(/\d{10,}/.test(raw), false, "no timestamp- or pid-shaped digit run may be persisted");
  });
});

test("a library polluted with read-view fields is healed by the next write", async () => {
  await withTempDirectory("avenic-lib-heal-", async (stateDir) => {
    const environment = environmentFor(stateDir);
    const file = modelsFile(environment);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      profiles: { a: { id: "a", name: "A", endpoint: { baseUrl: "https://a.example", api: "anthropic", apiKey: "k" } } },
      exists: false,
      file,
    }, null, 2));
    await upsertProfile(environment, { id: "b", name: "B", endpoint: { baseUrl: "https://b.example", api: "anthropic", apiKey: "k" } });
    const stored = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(Object.keys(stored).sort(), ["profiles", "revision", "schemaVersion"]);
    assert.equal(stored.exists, undefined);
    assert.equal(stored.file, undefined);
    assert.equal(stored.revision, 2);
  });
});

// 合法 JSON 但形状不对：绝不静默修复、绝不覆盖用户文件（spec §13）。
const malformedLibraries = [
  ["profiles is null", { schemaVersion: 1, revision: 1, profiles: null }],
  ["profiles is missing", { schemaVersion: 1, revision: 1 }],
  ["the document is an array", []],
  ["a profile entry is null", { schemaVersion: 1, revision: 1, profiles: { a: null } }],
  ["a profile entry is an array", { schemaVersion: 1, revision: 1, profiles: { a: ["x"] } }],
];
for (const [label, document] of malformedLibraries) {
  test(`a library whose ${label} fails loudly and is never overwritten`, async () => {
    await withTempDirectory("avenic-lib-malformed-", async (stateDir) => {
      const environment = environmentFor(stateDir);
      const file = modelsFile(environment);
      await mkdir(path.dirname(file), { recursive: true });
      const raw = JSON.stringify(document, null, 2);
      await writeFile(file, raw);
      await assert.rejects(() => readLibrary(environment), /malformed/);
      await assert.rejects(() => listProfiles(environment), /malformed/);
      await assert.rejects(
        () => upsertProfile(environment, { id: "a", name: "A", endpoint: { baseUrl: "https://a.example", api: "anthropic", apiKey: "k" } }),
        /malformed/,
      );
      assert.equal(await readFile(file, "utf8"), raw);
    });
  });
}

test("listProfiles sorts entries that have no name instead of throwing a TypeError", async () => {
  await withTempDirectory("avenic-lib-noname-", async (stateDir) => {
    const environment = environmentFor(stateDir);
    const file = modelsFile(environment);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({
      schemaVersion: 1,
      revision: 0,
      profiles: { c: { id: "c" }, a: { id: "a" }, b: { id: "b" } },
    }));
    const profiles = await listProfiles(environment);
    assert.deepEqual(profiles.map((profile) => profile.id), ["a", "b", "c"]);
  });
});

test("transact fails loudly when every attempt loses the revision race", async () => {
  await withTempDirectory("avenic-tx-exhausted-", async (root) => {
    const target = path.join(root, "value.json");
    await writeFile(target, "0");
    let reads = 0;
    let builds = 0;
    await assert.rejects(
      () => transact({
        tempRoot: path.join(root, "tmp"),
        read: async () => {
          reads += 1;
          // 版本戳每次读取都在增长：模拟另一个进程在每次替换前抢先写入
          return { revision: reads, value: await readFile(target, "utf8") };
        },
        build: (current) => {
          builds += 1;
          return `${current.value}+`;
        },
        stage: async (next, directory) => {
          const file = path.join(directory, "staged", "value.json");
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, next);
          return [{ relativePath: "value.json", staged: file, target }];
        },
      }),
      /retry/,
    );
    // attempts = 3 → build 恰好 3 次（旧实现允许 4 次）；每次尝试读 2 次（替换前 + 替换前的版本复查）
    assert.equal(builds, 3);
    assert.equal(reads, 6);
    assert.equal(await readFile(target, "utf8"), "0", "a conflicting transaction must not touch the target");
  });
});

test("transact reports a change even when stage declares no replacements", async () => {
  await withTempDirectory("avenic-tx-empty-stage-", async (root) => {
    const target = path.join(root, "value.json");
    await writeFile(target, "old");
    const tempRoot = path.join(root, "tmp");
    const result = await transact({
      tempRoot,
      read: async () => ({ revision: 0, value: await readFile(target, "utf8") }),
      build: () => "next",
      stage: async () => [],
    });
    // 契约：stage 返回空数组 = 调用方声明"无实际写入"，build 本应改为返回 null；
    // 当前实现仍报 changed:true / revision+1 而磁盘不动——此用例把该行为钉死。
    assert.equal(result.changed, true);
    assert.equal(result.revision, 1);
    assert.equal(await readFile(target, "utf8"), "old");
    assert.deepEqual(existsSync(tempRoot) ? await readdir(tempRoot) : [], []);
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

// FAIL-1(a)：同进程并发事务的目录名必须唯一（旧实现 pid+attempt+Date.now 会碰撞，
// 两个事务共用一个目录、互相删掉对方 staged 文件 → ENOENT / 内容损坏）。
test("concurrent transactions use distinct directories and never delete each other's staged files", async () => {
  await withTempDirectory("avenic-tx-unique-", async (root) => {
    const tempRoot = path.join(root, "tmp");
    const targets = [path.join(root, "a.json"), path.join(root, "b.json")];
    const directories = [];
    let ready = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const run = (index) => transact({
      tempRoot,
      read: async () => ({ revision: 0, value: String(index) }),
      build: async (current) => {
        ready += 1;
        if (ready === 2) release();
        await gate; // 屏障：两个事务在同一 tick 继续 → 旧实现拿到同一个目录名
        return current.value;
      },
      stage: async (next, directory) => {
        directories.push(directory);
        const staged = path.join(directory, "staged", "value.json"); // 故意同名，逼出互删
        await mkdir(path.dirname(staged), { recursive: true });
        await writeFile(staged, next);
        return [{ relativePath: "value.json", staged, target: targets[Number(next)] }];
      },
    });
    await Promise.all([run(0), run(1)]);
    assert.equal(new Set(directories).size, 2, "并发事务不得共用事务目录");
    assert.equal(await readFile(targets[0], "utf8"), "0");
    assert.equal(await readFile(targets[1], "utf8"), "1");
    assert.deepEqual(existsSync(tempRoot) ? await readdir(tempRoot) : [], []);
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
