import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const REQUIRED_RULES = [
  ".claude/skills/",
  ".agents/skills/",
  ".agents/local/",
  ".agents/tmp/",
];
const SESSIONS_RULE = ".agents/sessions/";

async function readGitignore(projectRoot) {
  const file = path.join(projectRoot, ".gitignore");
  return {
    content: existsSync(file) ? await readFile(file, "utf8") : "",
    file,
  };
}

async function addRules(projectRoot, rules) {
  const { content, file } = await readGitignore(projectRoot);
  const lines = new Set(content.split(/\r?\n/).map((line) => line.trim()));
  const missing = rules.filter((rule) => !lines.has(rule));
  if (missing.length === 0) return false;
  const prefix = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  await writeFile(file, `${content}${prefix}# Agent Runtime\n${missing.join("\n")}\n`, "utf8");
  return true;
}

export async function ensureRuntimeGitignore(projectRoot) {
  return addRules(projectRoot, REQUIRED_RULES);
}

export async function sessionsGitIgnored(projectRoot) {
  const { content } = await readGitignore(projectRoot);
  return content.split(/\r?\n/).some((line) => line.trim() === SESSIONS_RULE);
}

export async function setSessionsGitIgnored(projectRoot, ignored) {
  if (ignored) return addRules(projectRoot, [SESSIONS_RULE]);
  const { content, file } = await readGitignore(projectRoot);
  const lines = content.split(/\r?\n/);
  const filtered = lines.filter((line) => line.trim() !== SESSIONS_RULE);
  if (filtered.length === lines.length) return false;
  await writeFile(file, filtered.join("\n"), "utf8");
  return true;
}

export async function removeRuntimeGitignore(projectRoot, options = {}) {
  const { content, file } = await readGitignore(projectRoot);
  if (!content) return false;
  const removable = new Set([".agents/local/", ".agents/tmp/"]);
  if (options.sessions) removable.add(SESSIONS_RULE);
  let lines = content.split(/\r?\n/).filter((line) => !removable.has(line.trim()));
  const managedRules = new Set([...REQUIRED_RULES, SESSIONS_RULE]);
  if (!lines.some((line) => managedRules.has(line.trim()))) {
    lines = lines.filter((line) => line.trim() !== "# Agent Runtime");
  }
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const updated = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  if (updated === content) return false;
  await writeFile(file, updated, "utf8");
  return true;
}

export { REQUIRED_RULES, SESSIONS_RULE };
