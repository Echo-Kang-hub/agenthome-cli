import { mkdir, open, stat, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

// 项目级写锁：绑定 + 投影是两个文件，revision 的"比对-提交"不是原子操作，
// 两个写者各自顺序替换会留下"绑定=A / 投影=B"的半写对。所有项目写操作走这条锁串行化。
//
// 语义是"进程级互斥 + 陈旧锁超时抢占"，不是内核级 advisory lock：
//   - open(lock, "wx") 原子创建（Windows CREATE_NEW / POSIX O_EXCL），EEXIST = 被占用；
//   - 持有者崩溃会留下锁文件，mtime 超过 staleMs（默认 30s）后被下一个写者抢走；
//     30s 的取值理由：正常一次绑定是毫秒级，30s 足以覆盖慢磁盘/杀毒扫描，又不至于让
//     崩溃后的用户长时间无法再次绑定；
//   - 陈旧锁最多抢一次：抢不到就老实排队，避免两个进程互相抢死。
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_STALE_MS = 30000;
export const LOCK_TIMEOUT_CODE = "MODEL_LOCK_TIMEOUT";

// Windows 上 open(path, "wx") 与并发 unlink 撞车时返回 EPERM/EACCES 而不是 EEXIST
// （删除中的文件无法以 CREATE_NEW 打开）——三者都按"被占用"处理并重试。
const BUSY_CODES = new Set(["EEXIST", "EPERM", "EACCES"]);

// 同进程重入：本进程已持有的锁路径。嵌套调用直接执行 fn（不再获取/释放），
// 否则同一 projectRoot 的嵌套 withProjectLock 会等自己而死锁。
const held = new Set();

export function lockFile(projectRoot) {
  return path.join(projectRoot, ".agents", "model.lock");
}

function lockTimeoutError() {
  const error = new Error("Another process is updating this project's model binding; please retry");
  error.code = LOCK_TIMEOUT_CODE;
  return error;
}

async function acquire(file) {
  const handle = await open(file, "wx");
  try {
    await handle.writeFile(`${process.pid} ${Date.now()}\n`);
  } catch (error) {
    await unlink(file).catch(() => {});
    throw error;
  } finally {
    await handle.close().catch(() => {});
  }
}

// 释放：Windows 上若恰好有人正打开锁文件（stat），unlink 可能瞬时 EPERM/EACCES，
// 有限重试几次；其余错误一律吞掉，释放失败绝不能掩盖 fn 的结果。ENOENT = 已经不在。
async function release(file) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await unlink(file);
      return;
    } catch (error) {
      if (error.code === "ENOENT") return;
      if (error.code !== "EPERM" && error.code !== "EACCES") return;
      await delay(5 + Math.random() * 15);
    }
  }
}

export async function withProjectLock(projectRoot, fn, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, staleMs = DEFAULT_STALE_MS } = options;
  const file = lockFile(projectRoot);
  if (held.has(file)) return fn(); // 同进程重入：锁已经在自己手里
  await mkdir(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let stole = false; // 陈旧锁最多抢一次
  for (;;) {
    try {
      await acquire(file);
      break;
    } catch (error) {
      if (!BUSY_CODES.has(error.code)) throw error;
      if (!stole) {
        try {
          const info = await stat(file);
          if (Date.now() - info.mtimeMs > staleMs) {
            await unlink(file).catch(() => {});
            stole = true;
            continue;
          }
        } catch (statError) {
          if (statError.code === "ENOENT") continue; // 持有者恰好释放：立刻重试
        }
      }
      if (Date.now() >= deadline) throw lockTimeoutError();
      await delay(10 + Math.random() * 40); // 10-50ms 抖动，降低同步重试的碰撞
    }
  }
  held.add(file);
  try {
    return await fn();
  } finally {
    held.delete(file);
    await release(file); // fn 抛错也必须释放；正常路径不得残留 model.lock
  }
}
