import { existsSync } from "node:fs";
import { defaultCatalogFile, ensureCatalog, loadDefaultCatalogSpec, loadKnownCatalogs, registerCatalog, resolveInstallSource, setDefaultCatalogSpec } from "@avenic/core";
import type { CatalogInfo, KnownCatalogEntry, ProcessEnvLike } from "@avenic/core";

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
