import { existsSync, lstatSync } from "node:fs";
import { cp, mkdir, readFile, readdir, readlink, realpath, rm, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { hashContent, samePath } from "../runtime/sessions.mjs";

// Windows 的 junction 经 readlink 返回带 \\?\ 前缀的绝对路径；比较前必须剥掉。
const WINDOWS_PREFIX = /^\\\\\?\\/;

export function canonicalTargets(context) {
  return context.targets.filter((target) => !target.shareFrom);
}

export function shareTargets(context) {
  return context.targets.filter((target) => Boolean(target.shareFrom));
}

export function normalizeLinkTarget(linkPath, rawTarget) {
  const stripped = rawTarget.replace(WINDOWS_PREFIX, "");
  return path.resolve(path.dirname(linkPath), stripped);
}

export async function readLinkTarget(linkPath) {
  try {
    return normalizeLinkTarget(linkPath, await readlink(linkPath));
  } catch {
    return null;
  }
}

export async function createSkillLink(canonicalPath, linkPath) {
  await mkdir(path.dirname(linkPath), { recursive: true });
  if (process.platform === "win32") {
    // junction 要求绝对路径；不需要管理员权限。
    await symlink(path.resolve(canonicalPath), linkPath, "junction");
    return;
  }
  // 相对符号链接：项目整体移动后仍然有效。
  await symlink(path.relative(path.dirname(linkPath), canonicalPath), linkPath, "dir");
}

export async function removeLinkSafely(linkPath) {
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) {
      return false;
    }
    await unlink(linkPath);
    return true;
  } catch {
    // 解链失败（EACCES/EPERM/EBUSY…）不得向上抛：调用方按"没删掉"处理。
    return false;
  }
}

async function realpathOrNull(target) {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

// 只回答一个问题：这个位置上的东西，能不能被当成"avenic 自己的布局"处理。
// 判定一律走 samePath（win32 大小写不敏感），不按文件名猜；不确定就 conflict。
export async function classifyShareEntry(canonicalPath, linkPath) {
  let stats;
  try {
    stats = lstatSync(linkPath);
  } catch (error) {
    // 只有"那里确实没有条目"才算 absent；读不到（EACCES/EPERM…）一律 conflict，
    // 否则下游会把一个未知状态当成空地创建/删除。
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { state: "absent" };
    }
    return { state: "conflict", reason: "unreadable-entry" };
  }
  if (!stats.isSymbolicLink()) {
    // 末级分量不是链接，但路径的中间分量可能是（用户把整个 .claude/skills 指向
    // .agents/skills 的用法）。lstat 不跟随中间分量，这里必须用 realpath 识破：
    // 否则 linkPath 就是 canonical 本身，sameTree 会自比自真，删除即数据丢失。
    const [resolvedLink, resolvedCanonical] = [await realpathOrNull(linkPath), await realpathOrNull(canonicalPath)];
    if (resolvedLink && resolvedCanonical && samePath(resolvedLink, resolvedCanonical)) {
      return { state: "conflict", reason: "aliases-canonical" };
    }
    return { state: "real-directory" };
  }
  const target = await readLinkTarget(linkPath);
  if (!target) {
    return { state: "conflict", reason: "unreadable-link" };
  }
  if (samePath(target, canonicalPath)) {
    let canonical;
    try {
      canonical = lstatSync(canonicalPath);
    } catch {
      return { state: "repair", reason: "dangling" };
    }
    if (!canonical.isDirectory() || canonical.isSymbolicLink()) {
      return { state: "repair", reason: "canonical-not-directory" };
    }
    return { state: "linked" };
  }
  const [resolvedLink, resolvedCanonical] = [await realpathOrNull(linkPath), await realpathOrNull(canonicalPath)];
  if (resolvedLink && resolvedCanonical && samePath(resolvedLink, resolvedCanonical)) {
    return { state: "linked" };
  }
  return { state: "conflict", reason: "points-elsewhere", target };
}

async function sameEntry(left, right) {
  try {
    const [leftStats, rightStats] = [lstatSync(left), lstatSync(right)];
    if (leftStats.isSymbolicLink() || rightStats.isSymbolicLink()) {
      if (!(leftStats.isSymbolicLink() && rightStats.isSymbolicLink())) {
        return false;
      }
      const [leftTarget, rightTarget] = [await readLinkTarget(left), await readLinkTarget(right)];
      return Boolean(leftTarget && rightTarget && samePath(leftTarget, rightTarget));
    }
    if (leftStats.isDirectory() !== rightStats.isDirectory()) {
      return false;
    }
    if (leftStats.isDirectory()) {
      return sameTree(left, right);
    }
    if (!leftStats.isFile() || !rightStats.isFile()) {
      return false;
    }
    if (leftStats.size !== rightStats.size) {
      return false;
    }
    const [leftContent, rightContent] = await Promise.all([readFile(left), readFile(right)]);
    return hashContent(leftContent) === hashContent(rightContent);
  } catch {
    return false;
  }
}

// 唯一的删除依据：两棵子树逐条一致（条目名集合、条目类型、链接 target、文件 size+sha256）。
// 任何异常（EACCES/ENOENT/EIO/ELOOP）都返回 false → 调用方按 conflict 处理，绝不删。
export async function sameTree(left, right) {
  try {
    const [leftStats, rightStats] = [lstatSync(left), lstatSync(right)];
    if (!leftStats.isDirectory() || !rightStats.isDirectory()) {
      return false;
    }
    if (leftStats.isSymbolicLink() || rightStats.isSymbolicLink()) {
      return false;
    }
    const [leftEntries, rightEntries] = await Promise.all([
      readdir(left, { withFileTypes: true }),
      readdir(right, { withFileTypes: true }),
    ]);
    const leftNames = leftEntries.map((entry) => entry.name).sort();
    const rightNames = rightEntries.map((entry) => entry.name).sort();
    if (leftNames.length !== rightNames.length) {
      return false;
    }
    if (leftNames.some((name, index) => name !== rightNames[index])) {
      return false;
    }
    for (const name of leftNames) {
      if (!(await sameEntry(path.join(left, name), path.join(right, name)))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
