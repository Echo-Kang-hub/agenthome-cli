import assert from "node:assert/strict";
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
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
import { lockFile, lockQueueSize, withProjectLock } from "../packages/core/src/model/lock.mjs";

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

// 模拟"另一个进程持有的锁"：token 是外人的（不是本进程当前调用的 token）。
const FOREIGN_TOKEN = "foreign-owner-token";

async function writeHeldLock(projectRoot, { stale = false, token = FOREIGN_TOKEN } = {}) {
  const file = lockFile(projectRoot);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ pid: 999999, token, startedAt: Date.now() })}\n`);
  if (stale) await utimes(file, PAST, PAST);
  return file;
}

function readToken(file) {
  return readFile(file, "utf8").then((raw) => JSON.parse(raw).token);
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

// —— WARN-1（复审如实指出）——
// 旧实现的模块级 held Set 让"锁已在本进程手里"的第二次调用直接跳过整个锁：它同时
// 放过了真正的嵌套重入和同进程的**独立**并发调用（复审实测 60/60 不等锁）。
// 现在改为同进程 per-project 串行队列，第二个调用必须等待；契约随之变为**不可重入**。
// 本用例替代旧的自加断言 "withProjectLock allows same-process reentry without deadlocking"
//（该断言的前提是"嵌套静默跳过锁"，已随 WARN-1 修复作废；改写已在修复报告显著标注）。
test("serializes an independent same-process caller that arrives while another holds the lock", async () => {
  await withProjectRoot(async (projectRoot) => {
    let active = 0;
    let maxActive = 0;
    let holderEntered;
    const entered = new Promise((resolve) => { holderEntered = resolve; });
    let releaseHolder;
    const gate = new Promise((resolve) => { releaseHolder = resolve; });

    const holder = withProjectLock(projectRoot, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      holderEntered();
      await gate;
      active -= 1;
    });
    await entered;

    const requestedAt = Date.now();
    let secondEnteredAt = null;
    const second = withProjectLock(projectRoot, async () => {
      active += 1;
      secondEnteredAt = Date.now();
      maxActive = Math.max(maxActive, active);
      active -= 1;
    });
    // 给第二个调用充分的"抢跑"机会：修复前 held Set 会直接放行（实测 waitedMs=0、maxActive=2）。
    await new Promise((resolve) => setTimeout(resolve, 80));
    releaseHolder();
    await Promise.all([holder, second]);

    assert.equal(maxActive, 1, "同一时刻只允许一个持有者（独立并发调用必须排队，不得跳过锁）");
    assert.ok(
      secondEnteredAt - requestedAt >= 50,
      `第二个调用必须等待持有者释放（实测等待 ${secondEnteredAt - requestedAt}ms）`,
    );
    assert.equal(existsSync(lockFile(projectRoot)), false);
  });
});

// 契约：withProjectLock 不可重入。同进程排队意味着在回调里再次调用它会排队等自己，
// 外层若 await 内层就是死锁。嵌套写路径必须用未加锁的内部实现
//（binding.mjs 的 clearBindingLocked 即此模式）。本用例只钉住"不再静默跳过锁"。
test("withProjectLock is not reentrant: a nested call queues instead of entering silently", async () => {
  await withProjectRoot(async (projectRoot) => {
    let innerRan = false;
    let inner;
    const outer = await withProjectLock(projectRoot, async () => {
      inner = withProjectLock(projectRoot, async () => {
        innerRan = true;
        return "inner";
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(innerRan, false, "嵌套调用不得在外层临界区内静默执行（必须排队）");
      return "outer";
    });
    assert.equal(outer, "outer");
    assert.equal(await inner, "inner", "外层释放后内层才轮到执行");
    assert.equal(innerRan, true);
    assert.equal(existsSync(lockFile(projectRoot)), false);
  });
});

test("same-process callers are served in issue order (FIFO queue)", async () => {
  await withProjectRoot(async (projectRoot) => {
    const order = [];
    await Promise.all(Array.from({ length: 6 }, (_, index) => withProjectLock(projectRoot, async () => {
      order.push(index);
      await new Promise((resolve) => setTimeout(resolve, 2));
    })));
    assert.deepEqual(order, [0, 1, 2, 3, 4, 5], "同进程队列必须按调用顺序串行化（不是各抢各的）");
  });
});

test("a failing caller does not block the next caller in the same-process queue", async () => {
  await withProjectRoot(async (projectRoot) => {
    const failing = withProjectLock(projectRoot, async () => {
      throw new Error("first caller failed");
    });
    // 与失败者同 tick 入队：前驱的 rejection 绝不能把后来者一起带走。
    const following = withProjectLock(projectRoot, async () => "second survived");
    await assert.rejects(failing, /first caller failed/);
    assert.equal(await following, "second survived");
    assert.equal(existsSync(lockFile(projectRoot)), false);
  });
});

test("the same-process queue drains and is cleaned up", async () => {
  await withProjectRoot(async (projectRoot) => {
    await Promise.all(Array.from({ length: 5 }, () => withProjectLock(projectRoot, async () => {})));
    assert.equal(lockQueueSize(), 0, "全部结束后队列条目必须清理（避免 Map 无界增长）");
    await assert.rejects(
      () => withProjectLock(projectRoot, async () => { throw new Error("boom"); }),
      /boom/,
    );
    assert.equal(lockQueueSize(), 0, "失败路径同样必须清理");
  });
});

// —— WARN-2（复审如实指出）——
// 陈旧锁抢占不校验持有者存活本身是设计取舍（崩溃残留最长 staleMs 后可抢），
// 但旧 release 按路径无条件 unlink：被抢走的持有者结束时会删掉**抢占者**的锁，
// 第三个写者随即进入抢占者临界区，双向失去互斥。现在释放前校验 owner token。
test("a holder whose stale lock was taken over does not delete the new owner's lock on release", async () => {
  await withProjectRoot(async (projectRoot) => {
    const warnings = [];
    const capture = { warn: (message) => warnings.push(message) };
    let holderEntered;
    const entered = new Promise((resolve) => { holderEntered = resolve; });
    let releaseHolder;
    const gate = new Promise((resolve) => { releaseHolder = resolve; });

    // A 持锁并故意超过 staleMs（50ms）不释放 → 锁变陈旧。
    const holder = withProjectLock(projectRoot, async () => {
      holderEntered();
      await gate;
    }, { staleMs: 50, io: capture });
    await entered;
    await new Promise((resolve) => setTimeout(resolve, 80));

    // 模拟 B 抢占成功：unlink 陈旧锁后以自己的 token 重建（正是修复后的抢占动作）。
    const file = lockFile(projectRoot);
    const stealerToken = "stealer-token-b";
    await rm(file, { force: true });
    await writeFile(file, `${JSON.stringify({ pid: 4242, token: stealerToken, startedAt: Date.now() })}\n`);

    releaseHolder();
    await holder; // A 释放：token 不是自己的 → 绝不能 unlink B 的锁

    assert.equal(existsSync(file), true, "被抢后原持有者的释放不得删除抢占者的锁文件");
    assert.equal(await readToken(file), stealerToken, "抢占者的 token 必须原样保留");
    assert.equal(warnings.length, 1, "被抢必须留下一条告警（异常路径不做静默）");
    assert.match(warnings[0], /taken over/);

    // B 未释放前，C 拿不到锁（双向互斥恢复）；等待者同样不得删除他人锁。
    await assert.rejects(
      () => withProjectLock(projectRoot, async () => {}, { timeoutMs: 80, io: capture }),
      /retry/,
    );
    assert.equal(await readToken(file), stealerToken);

    // B 释放后 C 才能进入。
    await rm(file, { force: true });
    let enteredC = false;
    await withProjectLock(projectRoot, async () => { enteredC = true; }, { io: capture });
    assert.equal(enteredC, true);
    assert.equal(existsSync(file), false);
    assert.equal(warnings.length, 1, "正常路径不得新增告警噪音");
  });
});

test("release removes only its own lock and stays silent on the normal path", async () => {
  await withProjectRoot(async (projectRoot) => {
    const warnings = [];
    const capture = { warn: (message) => warnings.push(message) };
    assert.equal(await withProjectLock(projectRoot, async () => "ok", { io: capture }), "ok");
    assert.equal(existsSync(lockFile(projectRoot)), false);
    assert.deepEqual(warnings, [], "正常释放必须完全静默");
  });
});

// —— WARN-4（复审变异体 S-once 存活）——
// "陈旧锁最多抢一次"：抢过一次后即使锁再次变陈旧也不得反复抢占。
// 对手方（模拟另一个抢占者）在每次被抢走锁之后立刻重建一个同样陈旧的锁；
// 有守卫 → 抢 1 次后老实等到超时；无守卫 → 反复 unlink 对手的锁（有界性被破坏）。
test("a stale lock is stolen at most once, then the waiter keeps waiting", async () => {
  await withProjectRoot(async (projectRoot) => {
    const file = await writeHeldLock(projectRoot, { stale: true, token: "rival-token" });
    const steals = [];
    await assert.rejects(
      () => withProjectLock(projectRoot, async () => {
        throw new Error("must not acquire: the rival re-creates a stale lock after every steal");
      }, {
        timeoutMs: 150,
        staleMs: 0,
        onStaleLockRemoved: () => {
          steals.push(Date.now());
          // 只在第一次被抢后重建：无守卫的实现会再抢一次并因此拿到锁（错误消息不匹配 → 红），
          // 有守卫的实现只抢一次，之后一直等待到超时。
          if (steals.length === 1) {
            writeFileSync(file, `${JSON.stringify({ pid: 777, token: "rival-token", startedAt: Date.now() })}\n`);
            utimesSync(file, PAST, PAST);
          }
        },
      }),
      /retry/,
    );
    assert.equal(steals.length, 1, "陈旧锁最多抢一次：再次变陈旧也不得重复抢占");
    assert.equal(await readToken(file), "rival-token", "等待者不得删除/改写对手重建的锁");
    await rm(file, { force: true });
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
