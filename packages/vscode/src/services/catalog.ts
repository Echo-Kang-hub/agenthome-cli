import { existsSync } from "node:fs";
import { defaultCatalogFile, ensureCatalog, loadDefaultCatalogSpec, loadKnownCatalogs, registerCatalog, setDefaultCatalogSpec } from "@avenic/core";
import type { CatalogInfo, KnownCatalogEntry } from "@avenic/core";

export async function defaultSpec(environment = process.env): Promise<string | null> {
  const explicitEnvSpec = environment.AVENIC_CATALOG_SPEC ?? environment.AGENTHOME_CATALOG_SPEC;
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
