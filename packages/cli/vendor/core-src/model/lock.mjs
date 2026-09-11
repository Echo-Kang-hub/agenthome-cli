import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

// 项目级写锁：绑定 + 投影是两个文件，revision 的"比对-提交"不是原子操作，
// 两个写者各自顺序替换会留下"绑定=A / 投影=B"的半写对。所有项目写操作走这条锁串行化。
//
// 语义是"进程级互斥 + 陈旧锁超时抢占"，不是内核级 advisory lock：
//   - open(lock, "wx") 原子创建（Windows CREATE_NEW / POSIX O_EXCL），EEXIST = 被占用；
//   - 锁文件写入 owner token（{ pid, token, startedAt }）；释放前读回校验，只有自己的锁
//     才 unlink。被抢走的持有者若按路径无条件删除，会删掉**抢占者**的锁，第三个写者随即
//     进入抢占者临界区（双向失去互斥，复审 WARN-2）；
//   - 持有者崩溃会留下锁文件，mtime 超过 staleMs（默认 30s）后被下一个写者抢走；
//     30s 的取值理由：正常一次绑定是毫秒级，30s 足以覆盖慢磁盘/杀毒扫描，又不至于让
//     崩溃后的用户长时间无法再次绑定；
//   - 陈旧锁最多抢一次：抢不到就老实排队，避免两个进程互相抢死。
//
// 同进程并发由 per-project 串行队列保证：第二个调用等前一个结束，而不是按路径判断
// "锁已在自己手里"就跳过整个锁（那会把真正的嵌套重入与独立并发调用混为一谈）。
// 契约：**withProjectLock 不可重入**——回调里再次调用它会排队等自己，外层若 await 内层
// 即死锁；嵌套写路径必须改用未加锁的内部实现（binding.mjs 的 clearBindingLocked 即此模式）。
// timeoutMs 只约束文件锁争用；同进程排队是必要的串行化，不计入超时。
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_STALE_MS = 30000;
export const LOCK_TIMEOUT_CODE = "MODEL_LOCK_TIMEOUT";

// Windows 上 open(path, "wx") 与并发 unlink 撞车时返回 EPERM/EACCES 而不是 EEXIST
// （删除中的文件无法以 CREATE_NEW 打开）——三者都按"被占用"处理并重试。
const BUSY_CODES = new Set(["EEXIST", "EPERM", "EACCES"]);

// 同进程 per-project 串行队列：lockPath → 队尾 promise（永不 reject，只负责排队）。
const queues = new Map();

// 测试诊断导出（不进 index.mjs）：断言空闲时队列条目被清理，避免 Map 无界增长。
export function lockQueueSize() {
  return queues.size;
}

export function lockFile(projectRoot) {
  return path.join(projectRoot, ".agents", "model.lock");
}

function lockTimeoutError() {
  const error = new Error("Another process is updating this project's model binding; please retry");
  error.code = LOCK_TIMEOUT_CODE;
  return error;
}

// 旧版本/被破坏的锁文件读不出 token → 无法证明锁是自己的 → 一律不删。
function tokenOf(raw) {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.token === "string" ? parsed.token : null;
  } catch {
    return null;
  }
}

async function acquire(file, token) {
  const handle = await open(file, "wx");
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, startedAt: Date.now() })}\n`);
  } catch (error) {
    await unlink(file).catch(() => {});
    throw error;
  } finally {
    await handle.close().catch(() => {});
  }
}

// 释放：先读锁文件校验 token，只有自己的锁才 unlink。token 不同（锁已被抢走）→ 绝不
// unlink 并留下一条告警；文件已不存在 → 静默（正常的"别人已释放"路径不得有噪音）。
// Windows 上读/删撞上瞬时 EPERM/EACCES 有限重试；重试之间重读，避免删掉抢进来的新锁。
async function release(file, token, io) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return;
      if (error.code !== "EPERM" && error.code !== "EACCES") return;
      await delay(5 + Math.random() * 15);
      continue;
    }
    if (tokenOf(raw) !== token) {
      io?.warn?.(`Warning: the project model lock at ${file} was taken over by another process; not removing it`);
      return;
    }
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

async function acquireAndRun(file, fn, { timeoutMs, staleMs, io, onStaleLockRemoved }) {
  await mkdir(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const token = randomBytes(8).toString("hex");
  let stole = false; // 陈旧锁最多抢一次：再次变陈旧也不得重复抢占
  for (;;) {
    try {
      await acquire(file, token);
      break;
    } catch (error) {
      if (!BUSY_CODES.has(error.code)) throw error;
      if (!stole) {
        try {
          const info = await stat(file);
          if (Date.now() - info.mtimeMs > staleMs) {
            await unlink(file).catch(() => {});
            stole = true;
            // 测试注入点：删掉陈旧锁之后、重试获取之前（生产调用方不传）。
            await onStaleLockRemoved?.(file);
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
  try {
    return await fn();
  } finally {
    await release(file, token, io); // fn 抛错也必须释放；正常路径不得残留 model.lock
  }
}

export async function withProjectLock(projectRoot, fn, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    staleMs = DEFAULT_STALE_MS,
    io = console,
    onStaleLockRemoved,
  } = options;
  const file = lockFile(projectRoot);
  const previous = queues.get(file) ?? Promise.resolve();
  const run = previous.then(() => acquireAndRun(file, fn, { timeoutMs, staleMs, io, onStaleLockRemoved }));
  // 队尾永不 reject：前驱的失败既不会卡死后来者，也不会转嫁——后来者排到自己才开始尝试。
  const tail = run.then(() => {}, () => {});
  queues.set(file, tail);
  try {
    return await run;
  } finally {
    // 自己已不是队尾 → 后面还有人排队，条目留给最后一个人清理（避免 Map 无界增长）。
    if (queues.get(file) === tail) queues.delete(file);
  }
}
