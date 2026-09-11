import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import {
  bindProject,
  clearProjectBinding,
  projectModelFile,
  readBinding,
  removeProfile,
  resolveProjectProfile,
  upsertProfile,
} from "../packages/core/src/index.mjs";
import { lockFile, withProjectLock } from "../packages/core/src/model/lock.mjs";

const PAST = new Date("2000-01-01T00:00:00.000Z");

async function withTempDirectory(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withProjectRoot(run) {
  await withTempDirectory("avenic-lock-", async (projectRoot) => {
    await run(projectRoot);
  });
}

async function writeHeldLock(projectRoot, { stale = false } = {}) {
  const file = lockFile(projectRoot);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${process.pid} ${Date.now()}\n`);
  if (stale) await utimes(file, PAST, PAST);
  return file;
}

test("withProjectLock runs the callback and never leaves the lock file behind", async () => {
  await withProjectRoot(async (projectRoot) => {
    const value = await withProjectLock(projectRoot, async () => "done");
    assert.equal(value, "done");
    assert.equal(existsSync(lockFile(projectRoot)), false);
  });
});

test("withProjectLock releases the lock when the callback throws", async () => {
  await withProjectRoot(async (projectRoot) => {
    await assert.rejects(
      () => withProjectLock(projectRoot, async () => {
        throw new Error("callback exploded");
      }),
      /callback exploded/,
    );
    assert.equal(existsSync(lockFile(projectRoot)), false, "失败路径也必须释放锁");
    // 释放后可立即再次获取（未留下死锁）
    assert.equal(await withProjectLock(projectRoot, async () => 42), 42);
  });
});

test("withProjectLock steals a lock left behind by a dead process", async () => {
  await withProjectRoot(async (projectRoot) => {
    await writeHeldLock(projectRoot, { stale: true });
    let ran = false;
    await withProjectLock(projectRoot, async () => { ran = true; });
    assert.equal(ran, true, "陈旧锁（mtime 远超 staleMs）必须被抢占");
    assert.equal(existsSync(lockFile(projectRoot)), false);
  });
});

test("withProjectLock fails loudly with a retry hint when the holder never releases", async () => {
  await withProjectRoot(async (projectRoot) => {
    const file = await writeHeldLock(projectRoot);
    let ran = false;
    await assert.rejects(
      () => withProjectLock(projectRoot, async () => { ran = true; }, { timeoutMs: 80 }),
      /retry/,
    );
    assert.equal(ran, false, "拿不到锁不得执行回调");
    assert.equal(existsSync(file), true, "超时方绝不能删除他人的锁文件");
  });
});

test("a zero timeout makes exactly one attempt and gives up without waiting", async () => {
  await withProjectRoot(async (projectRoot) => {
    await writeHeldLock(projectRoot);
    const started = Date.now();
    await assert.rejects(
      () => withProjectLock(projectRoot, async () => {}, { timeoutMs: 0 }),
      /retry/,
    );
    assert.ok(Date.now() - started < 1000, "timeoutMs: 0 不得进入等待循环");
  });
});

test("withProjectLock serializes concurrent callers in the same process", async () => {
  await withProjectRoot(async (projectRoot) => {
    let active = 0;
    let maxActive = 0;
    let completed = 0;
    await Promise.all(Array.from({ length: 8 }, () => withProjectLock(projectRoot, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed += 1;
      active -= 1;
    })));
    assert.equal(completed, 8);
    assert.equal(maxActive, 1, "同一时刻只允许一个持有者");
    assert.equal(existsSync(lockFile(projectRoot)), false);
  });
});

test("withProjectLock allows same-process reentry without deadlocking", async () => {
  await withProjectRoot(async (projectRoot) => {
    let inner = false;
    const value = await withProjectLock(projectRoot, async () => {
      const nested = await withProjectLock(projectRoot, async () => {
        inner = true;
        return "inner";
      });
      assert.equal(nested, "inner");
      return "outer";
    });
    assert.equal(value, "outer");
    assert.equal(inner, true);
    assert.equal(existsSync(lockFile(projectRoot)), false);
  });
});

// 绑定是显式写操作：成功后锁必须已释放（win32 同样成立；POSIX 是简报点名的断言平台）。
test("bind and clear leave no lock file behind", async () => {
  await withTempDirectory("avenic-lock-bind-", async (projectRoot) => {
    await withTempDirectory("avenic-lock-state-", async (stateDir) => {
      const environment = { AVENIC_STATE_DIR: stateDir };
      await upsertProfile(environment, {
        id: "mimo",
        name: "MiMo",
        endpoint: { baseUrl: "https://lock.example/anthropic", api: "anthropic", apiKey: "sk-test-lock" },
        models: { main: { id: "lock-main" } },
      });
      await bindProject(projectRoot, environment, "mimo");
      assert.equal(existsSync(projectModelFile(projectRoot)), true);
      assert.equal(existsSync(lockFile(projectRoot)), false, "绑定成功后不得残留 .agents/model.lock");
      await clearProjectBinding(projectRoot, environment);
      assert.equal(existsSync(lockFile(projectRoot)), false, "clear 之后同样不得残留");
    });
  });
});

// 启动路径的顺带清理用 timeoutMs: 0：锁被占则跳过本次清理，绝不抛错、绝不空等。
test("resolveProjectProfile skips the dangling cleanup when the lock is held", async () => {
  await withTempDirectory("avenic-lock-dangling-", async (projectRoot) => {
    await withTempDirectory("avenic-lock-dangling-state-", async (stateDir) => {
      const environment = { AVENIC_STATE_DIR: stateDir };
      await upsertProfile(environment, {
        id: "mimo",
        name: "MiMo",
        endpoint: { baseUrl: "https://lock.example/anthropic", api: "anthropic", apiKey: "sk-test-lock" },
        models: { main: { id: "lock-main" } },
      });
      await bindProject(projectRoot, environment, "mimo");
      await removeProfile(environment, "mimo");

      // 另一个进程（此处用新鲜锁文件模拟）正在写：启动清理必须让路。
      await writeHeldLock(projectRoot);
      const held = await resolveProjectProfile(projectRoot, environment);
      assert.equal(held.cleaned, false, "拿不到锁 → 本次未清理");
      assert.match(held.message, /no longer exists/);
      assert.equal((await readBinding(projectRoot)).value.activeProfileId, "mimo", "跳过时绑定保持原样");

      // 锁释放后（模拟对方写完），下一次启动清理成功。
      await rm(lockFile(projectRoot), { force: true });
      const cleaned = await resolveProjectProfile(projectRoot, environment);
      assert.equal(cleaned.cleaned, true);
      assert.equal((await readBinding(projectRoot)).value.activeProfileId, null);
    });
  });
});
