import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import process from "node:process";
import { fail } from "../util/fail.mjs";

export { fail };

export function run(command, argumentsList, options = {}) {
  const result = spawnSync(command, argumentsList, {
    cwd: options.cwd,
    encoding: options.capture ? "utf8" : undefined,
    env: options.env ?? process.env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) {
    fail(`Unable to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = options.capture ? result.stderr.trim() : "";
    fail(`${command} failed${details ? `: ${details}` : ""}`);
  }
  return options.capture ? result.stdout.trim() : "";
}

export function git(argumentsList, options = {}) {
  return run("git", argumentsList, options);
}

export function normalizeRepositoryInput(repository) {
  if (/^[^\s/:@]+\/[^\s/]+$/.test(repository)) {
    return `https://github.com/${repository.replace(/\.git$/i, "")}.git`;
  }
  return repository;
}

export function repositoryIdentity(repository) {
  return normalizeRepositoryInput(repository)
    .replace(/^git\+/, "")
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/\.git$/i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

export function deriveSourceId(repository) {
  const parts = repositoryIdentity(repository).split(/[/:]/).filter(Boolean);
  const owner = parts.at(-2) ?? "source";
  const name = parts.at(-1) ?? "skills";
  return `${owner}-${name}`
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
}

export function currentRepositoryState(catalogRoot) {
  let repository = null;
  let revision = null;
  let dirty = null;
  try {
    const remotes = git(["-C", catalogRoot, "remote"], { capture: true })
      .split(/\r?\n/)
      .filter(Boolean);
    if (remotes.length > 0) {
      repository = git(["-C", catalogRoot, "remote", "get-url", remotes[0]], { capture: true });
    }
    revision = git(["-C", catalogRoot, "rev-parse", "HEAD"], { capture: true });
    dirty = Boolean(git(["-C", catalogRoot, "status", "--porcelain"], { capture: true }));
  } catch {
    // npm's cache copy is intentionally not a Git working tree.
  }
  return { repository, revision, dirty };
}

export async function cloneHead(source, destination) {
  git(["clone", "--depth", "1", source.repository, destination]);
  return git(["-C", destination, "rev-parse", "HEAD"], { capture: true });
}

export async function cloneRevision(source, destination) {
  await mkdir(destination, { recursive: true });
  git(["-C", destination, "init", "--quiet"]);
  git(["-C", destination, "remote", "add", "origin", source.repository]);
  git(["-C", destination, "fetch", "--depth", "1", "origin", source.revision]);
  git(["-C", destination, "checkout", "--quiet", "--detach", "FETCH_HEAD"]);
}

export function remoteHead(source) {
  const output = git(["ls-remote", source.repository, "HEAD"], { capture: true });
  const revision = output.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/i.test(revision)) {
    fail(`Unable to read upstream HEAD: ${source.id}`);
  }
  return revision;
}
