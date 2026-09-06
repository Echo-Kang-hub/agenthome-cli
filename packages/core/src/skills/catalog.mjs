import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fail } from "../util/fail.mjs";
import { readJson } from "../util/json.mjs";
import { git, normalizeRepositoryInput, repositoryIdentity } from "./git.mjs";
import { loadPacks } from "./packs.mjs";
import { catalogCacheRoot, defaultCatalogFile, deprecatedEnvironmentValue, knownCatalogsFile } from "./paths.mjs";

const DEFAULT_CATALOG_SPEC = "Echo-Kang-hub/avenic-catalog#main";

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
  const catalogSpec = deprecatedEnvironmentValue(environment, "AVENIC_CATALOG_SPEC", "AGENTHOME_CATALOG_SPEC");
  if (catalogSpec) {
    return catalogSpec;
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

// Short label for a catalog spec: "owner/repo" for remotes, the directory
// name for local paths. Preserves the original spelling for display.
export function catalogDisplayName(spec) {
  const { repository } = parseCatalogSpec(spec);
  if (/^(https?:\/\/|ssh:\/\/)/i.test(repository)) {
    const clean = repository.replace(/\.git$/i, "").replace(/\/+$/, "");
    return clean.split("/").slice(-2).join("/");
  }
  if (/^git@/i.test(repository)) {
    return repository.replace(/\.git$/i, "").split(":").at(-1);
  }
  return repository.split(/[\\/]/).filter(Boolean).at(-1) ?? repository;
}

export async function loadKnownCatalogs(environment = process.env) {
  const file = knownCatalogsFile(environment);
  if (!existsSync(file)) {
    return [];
  }
  const config = await readJson(file);
  const catalogs = Array.isArray(config.catalogs) ? config.catalogs : [];
  return catalogs.filter((entry) => typeof entry.spec === "string" && entry.spec.length > 0);
}

// Record a catalog in the registry (most recently used first, deduplicated by
// spec). The registry drives `catalog select`; the current spec stays in the
// default catalog file.
export async function registerKnownCatalog(environment = process.env, spec) {
  const known = await loadKnownCatalogs(environment);
  const next = [{ name: catalogDisplayName(spec), spec }, ...known.filter((entry) => entry.spec !== spec)];
  const file = knownCatalogsFile(environment);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ schemaVersion: 1, catalogs: next }, null, 2)}\n`, "utf8");
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
      "To point Avenic at your own catalog: avenic catalog add <owner/repo>",
    );
  }
}

// Register a catalog: save the default spec and the known-catalog entry
// first, then try to fetch and preview its Packs. The spec stays configured
// even when the preview fails (offline, missing credentials, no Packs yet).
export async function registerCatalog(spec, options = {}) {
  const io = options.io ?? console;
  parseCatalogSpec(spec);
  await setDefaultCatalogSpec(options.environment, spec);
  await registerKnownCatalog(options.environment, spec);
  try {
    const catalogInfo = await ensureCatalog(spec, { environment: options.environment, io });
    const packs = [...(await loadPacks(catalogInfo.catalogRoot)).values()];
    return { spec, catalogInfo, packs, previewFailed: false };
  } catch (error) {
    return { spec, packs: [], previewFailed: true, error };
  }
}
