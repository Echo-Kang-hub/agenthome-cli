import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { replaceStagedFiles } from "../skills/vendor.mjs";
import { fail } from "../util/fail.mjs";

// 通用事务写：
//   read()            → { revision, value }（磁盘现值 + 版本戳）
//   build(current)    → 新值；返回 null 表示"无需写入"
//   stage(next, dir)  → [{ relativePath, staged, target }]（staged 必须与 target 同卷）；
//                       返回空数组 = 调用方声明"无实际写入"，此时 build 本应改为返回 null。
//                       当前实现不特判空数组：仍报 changed:true / revision+1 而磁盘不动（测试钉住）。
// 并发：替换前重读版本戳；不一致则丢弃本次结果重放。attempts = 最多尝试次数（默认 3，不是 3+1 次）。
// 崩溃安全：最终是 rename 覆盖，磁盘上任何时刻要么旧内容要么新内容。
// 两个根（库 / 项目）各自独立事务：不同卷的文件绝不放进同一次替换。
export async function transact(options) {
  const { read, build, stage, tempRoot, attempts = 3, rename, commit } = options;
  // commit 可注入项目侧替换器（支持删除）；默认仍是技能安装用的 replaceStagedFiles，
  // 且必须保留 rename 注入（T2 的回滚测试整个建立在它之上）。
  const replace = commit ?? ((replacements, directory) => replaceStagedFiles(replacements, directory, rename ? { rename } : undefined));
  await mkdir(tempRoot, { recursive: true });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await read();
    const next = await build(current);
    if (next === null) {
      return { changed: false, value: current.value, revision: current.revision };
    }
    const directory = path.join(tempRoot, `model-${process.pid}-${attempt}-${Date.now()}`);
    await mkdir(directory, { recursive: true });
    try {
      const replacements = await stage(next, directory);
      const fresh = await read();
      if (fresh.revision !== current.revision) {
        await rm(directory, { recursive: true, force: true });
        continue; // 有人先写了一步：重读重放
      }
      await replace(replacements, directory);
      await rm(directory, { recursive: true, force: true });
      return { changed: true, value: next, revision: current.revision + 1 };
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
  return fail("Configuration was modified by another window or process; please retry");
}
