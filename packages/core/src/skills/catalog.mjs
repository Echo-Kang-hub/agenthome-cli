import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fail } from "../util/fail.mjs";
import { readJson } from "../util/json.mjs";
import { git, normalizeRepositoryInput, repositoryIdentity } from "./git.mjs";
import { catalogCacheRoot, defaultCatalogFile } from "./paths.mjs";

const DEFAULT_CATALOG_SPEC = "Echo-Kang-hub/agenthome-catalog#main";

export function parseCatalogSpec(spec) {
  if (typeof spec !== "string" || spec.length === 0) {
    fail(`Invalid catalog spec: ${spec}`);
  }
  const hashIndex = spec.lastIndexOf("#");
  const repository = hashIndex === -1 ? spec : spec.slice(0, hashIndex);
  const ref = hashIndex === -1 ? "main" : spec.slice(hashIndex + 1) || "main";
  return { repository: normalizeRepositoryInput(repository), ref };
}

export async function loadDefaultCatalogSpec(environment = process.env) {
  if (environment.AGENTHOME_CATALOG_SPEC) {
    return environment.AGENTHOME_CATALOG_SPEC;
  }
  const file = defaultCatalogFile(environment);
  if (existsSync(file)) {
    const config = await readJson(file);
    if (typeof config.spec === "string" && config.spec.length > 0) {
      return config.spec;
    }
  }
  return DEFAULT_CATALOG_SPEC;
}

export async function setDefaultCatalogSpec(environment = process.env, spec) {
  const file = defaultCatalogFile(environment);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ schemaVersion: 1, spec }, null, 2)}\n`, "utf8");
}

function cacheDirectory(environment, repository) {
  const identity = repositoryIdentity(repository).replace(/\\/g, "/");
  const parts = identity.split("/").filter(Boolean);
  const owner = parts.at(-2) ?? "catalog";
  const name = parts.at(-1) ?? "catalog";
  const slug = `${owner}-${name}`
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  return path.join(catalogCacheRoot(environment), slug);
}

export async function ensureCatalog(spec, options = {}) {
  const environment = options.environment ?? process.env;
  const { repository, ref } = parseCatalogSpec(spec);
  const directory = cacheDirectory(environment, repository);
  try {
    if (existsSync(path.join(directory, ".git"))) {
      git(["-C", directory, "fetch", "--depth", "1", "origin", ref], { capture: true });
    } else {
      await mkdir(directory, { recursive: true });
      git(["-C", directory, "init", "--quiet"], { capture: true });
      git(["-C", directory, "remote", "add", "origin", repository], { capture: true });
      git(["-C", directory, "fetch", "--depth", "1", "origin", ref], { capture: true });
    }
    git(["-C", directory, "checkout", "--quiet", "--detach", "FETCH_HEAD"], { capture: true });
    const revision = git(["-C", directory, "rev-parse", "HEAD"], { capture: true });
    return { catalogRoot: directory, repository, ref, revision, spec };
  } catch (error) {
    fail(
      `${error.message}\nUnable to fetch catalog: ${spec}\n` +
      "Check your GitHub authentication (gh auth login, SSH key, or credential helper) and the catalog spec.\n" +
      "To point AgentHome at your own catalog: agent catalog use <owner/repo>",
    );
  }
}
