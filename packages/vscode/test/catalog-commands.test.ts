import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { add, defaultSpec, listKnown, select, sync } from "../src/services/catalog.ts";
import { makeCatalogFixture, testEnv } from "./helpers.ts";

test("catalog add → select → sync round-trip with local fixture", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-catalog-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const env = testEnv(path.join(root, "state"));
    await makeCatalogFixture(catalogDir);
    const added = await add(catalogDir, env);
    assert.equal(added.previewFailed, false);
    assert.equal(added.packs.some((p) => p.id === "common"), true);
    const known = await listKnown(env);
    assert.equal(known.filter((k) => k.spec === catalogDir).length, 1);
    await select(catalogDir, env);
    // select 后默认 Catalog 指向 fixture（core 原样持久化 spec，本地路径不做 URL 化）
    assert.equal(await defaultSpec(env), catalogDir);
    const info = await sync(catalogDir, env);
    assert.match(info.revision, /^[0-9a-f]{40}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest registers the four catalog command ids", async () => {
  const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  const ids = manifest.contributes?.commands ?? [];
  for (const id of ["avenic.catalog.add", "avenic.catalog.select", "avenic.catalog.default", "avenic.catalog.sync"]) {
    assert.ok(ids.some((c: { command: string }) => c.command === id), id);
  }
});
