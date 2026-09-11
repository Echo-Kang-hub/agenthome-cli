import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// 模型配置专用规则（spec §12 第 3 条）：只在保存模型配置时写入，不并入 REQUIRED_RULES
// （避免改变 init 的既有输出与断言）。
// 第三条 `.agents/model.lock` 是绑定写锁的残留兜底：进程崩溃会留下锁文件。
// 第四条 `.agents/tmp/` 是事务备份目录的兜底：备份里可能含密钥，而从未 init 过的项目
// 不会有这条规则。它与 REQUIRED_RULES 已含的规则同形，重复写入是幂等的。
export const MODEL_RULES = [
  ".agents/model.json",
  ".claude/settings.local.json",
  ".agents/model.lock",
  ".agents/tmp/",
];

// 读写失败时必须带上目标路径：EISDIR 这类 fs 错误在 Windows/Linux 的 message 里都不含路径，
// 用户看到 "EISDIR: illegal operation on a directory, read" 无从知道是哪个文件。
// 这里只补上下文再抛（原错误在 cause 里），不吞错。
function gitignoreFailure(file, error) {
  return new Error(
    `Cannot update ${file} before saving the project model configuration: ${error.message}`,
    { cause: error },
  );
}

export async function ensureModelGitignore(projectRoot) {
  const file = path.join(projectRoot, ".gitignore");
  let content = "";
  if (existsSync(file)) {
    try {
      content = await readFile(file, "utf8");
    } catch (error) {
      throw gitignoreFailure(file, error);
    }
  }
  const lines = new Set(content.split(/\r?\n/).map((line) => line.trim()));
  const missing = MODEL_RULES.filter((rule) => !lines.has(rule));
  if (missing.length === 0) return false;

  // 只有当前文件既无 `# Agent Runtime` 头、也无任何受管规则时才写头。
  // 否则（典型：init 已写入 `# Agent Runtime` + sessions 规则）无条件写头会让文件出现
  // 两个同名分节。runtime 侧的 REQUIRED_RULES/SESSIONS_RULE 不能在这里反向导入（会成环），
  // 因此把 `.agents/` 与 `.claude/` 命名空间下的既有规则都视为已存在的受管分节。
  const hasManagedRule = [...lines].some(
    (line) => line.startsWith(".agents/") || line.startsWith(".claude/"),
  );
  const needsHeader = !lines.has("# Agent Runtime") && !hasManagedRule;
  const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  const header = needsHeader ? "# Agent Runtime\n" : "";
  try {
    await writeFile(file, `${content}${separator}${header}${missing.join("\n")}\n`, "utf8");
  } catch (error) {
    throw gitignoreFailure(file, error);
  }
  return true;
}
