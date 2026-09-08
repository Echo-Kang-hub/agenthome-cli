import { existsSync } from "node:fs";
import path from "node:path";
import { catalogCacheRoot, defaultCatalogFile, ensureCatalog, loadDefaultCatalogSpec, loadKnownCatalogs, loadPacks, parseCatalogSpec, registerCatalog, repositoryIdentity, resolveInstallSource, setDefaultCatalogSpec } from "@avenic/core";
import type { CatalogInfo, KnownCatalogEntry, Pack, ProcessEnvLike } from "@avenic/core";

export async function defaultSpec(environment = process.env): Promise<string | null> {
  const explicitEnvSpec = environment.AVENIC_CATALOG_SPEC || environment.AGENTHOME_CATALOG_SPEC;
  if (!explicitEnvSpec && !existsSync(defaultCatalogFile(environment))) {
    return null; // 未配置默认 → null（视图显示「未选择」）
  }
  try { return await loadDefaultCatalogSpec(environment); }
  catch { return null; }
}

export function listKnown(environment = process.env): Promise<KnownCatalogEntry[]> {
  return loadKnownCatalogs(environment);
}

export function add(spec: string, environment = process.env) {
  return registerCatalog(spec, { environment }); // previewFailed 或 catalogInfo + packs
}

export function select(spec: string, environment = process.env): Promise<unknown> {
  return setDefaultCatalogSpec(environment, spec);
}

export function sync(spec: string, environment = process.env): Promise<CatalogInfo> {
  return ensureCatalog(spec, { environment });
}

// 读取当前锁定的 catalog revision（Dashboard「修订」）：refresh:false 走项目 lock 的 pinned spec，
// 不绕过 pin 去拉最新；任何错误（未配置/无缓存/解析失败）返回 null，调用方降级为「—」占位符。
export function pinnedRevision(cwd: string, environment: ProcessEnvLike = process.env): Promise<string | null> {
  return resolveInstallSource({ global: false, cwd, environment }, { refresh: false })
    .then((info) => info.revision)
    .catch(() => null);
}

// core skill/catalog.mjs cacheDirectory 的算法镜像（cacheDirectory 非导出）：slug 规则与
// repositoryIdentity 完全一致，仅借用公开的 catalogCacheRoot/repositoryIdentity，不改 core。
function catalogCacheDirectory(spec: string, environment: ProcessEnvLike): string {
  const { repository } = parseCatalogSpec(spec);
  const identity = repositoryIdentity(repository).replace(/\\/g, "/");
  const parts = identity.split("/").filter(Boolean);
  const owner = parts.at(-2) ?? "catalog";
  const name = parts.at(-1) ?? "catalog";
  const slug = `${owner}-${name}`
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  return path.join(catalogCacheRoot(environment), slug);
}

// Catalog 树的只读预览：优先读本地缓存（无网络，离线/国内直连可用）；缓存缺失时才经
// ensureCatalog（git fetch）——语义等同「展开即同步一次」。装好后返回 Pack 映射，失败返回 null。
export async function packsFor(spec: string, environment = process.env): Promise<Map<string, Pack> | null> {
  const cached = path.join(catalogCacheDirectory(spec, environment), "packs");
  if (existsSync(cached)) {
    try { return await loadPacks(catalogCacheDirectory(spec, environment)); }
    catch { /* 缓存损坏 → 走同步路径重试 */ }
  }
  try {
    const info = await ensureCatalog(spec, { environment });
    return await loadPacks(info.catalogRoot);
  } catch {
    return null;
  }
}
