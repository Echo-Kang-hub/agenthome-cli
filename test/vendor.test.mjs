import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { replaceStagedFiles } from "../packages/core/src/index.mjs";

async function withTempDirectory(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// 复刻安装路径的布局：staged 与 target 同卷，target 已有旧内容。
// files: [[relativePath, oldContent, newContent], ...]
async function setup(root, files) {
  const targets = path.join(root, "targets");
  const tempDirectory = path.join(root, "temp");
  await mkdir(targets, { recursive: true });
  const replacements = [];
  for (const [name, oldContent, newContent] of files) {
    const target = path.join(targets, name);
    const staged = path.join(tempDirectory, "staged", name);
    await mkdir(path.dirname(staged), { recursive: true });
    await writeFile(target, oldContent);
    await writeFile(staged, newContent);
    replacements.push({ relativePath: name, staged, target });
  }
  return { replacements, tempDirectory, targets };
}

test("replaceStagedFiles replaces every target and keeps the old content in backup/", async () => {
  await withTempDirectory("avenic-vendor-", async (root) => {
    const files = [
      ["a.json", "old-a", "new-a"],
      ["b.json", "old-b", "new-b"],
    ];
    const { replacements, tempDirectory, targets } = await setup(root, files);
    await replaceStagedFiles(replacements, tempDirectory);
    for (const [name, oldContent, newContent] of files) {
      assert.equal(await readFile(path.join(targets, name), "utf8"), newContent);
      assert.equal(await readFile(path.join(tempDirectory, "backup", name), "utf8"), oldContent);
    }
  });
});

test("an injected rename is used for every replacement instead of the fs default", async () => {
  await withTempDirectory("avenic-vendor-inject-", async (root) => {
    const { replacements, tempDirectory, targets } = await setup(root, [["a.json", "old-a", "new-a"]]);
    const calls = [];
    const injectedRename = async (from, to) => {
      calls.push([from, to]);
      const { rename } = await import("node:fs/promises");
      return rename(from, to);
    };
    await replaceStagedFiles(replacements, tempDirectory, { rename: injectedRename });
    assert.deepEqual(calls, [
      [path.join(targets, "a.json"), path.join(tempDirectory, "backup", "a.json")],
      [path.join(tempDirectory, "staged", "a.json"), path.join(targets, "a.json")],
    ]);
    assert.equal(await readFile(path.join(targets, "a.json"), "utf8"), "new-a");
  });
});

test("replaceStagedFiles restores both targets when the second staged→target rename fails", async () => {
  await withTempDirectory("avenic-vendor-rollback-", async (root) => {
    const { replacements, tempDirectory, targets } = await setup(root, [
      ["a.json", "old-a", "new-a"],
      ["b.json", "old-b", "new-b"],
    ]);
    let renames = 0;
    const injectedRename = async (from, to) => {
      renames += 1;
      if (renames === 4) throw new Error("disk full"); // 第 2 个文件的 staged→target
      const { rename } = await import("node:fs/promises");
      return rename(from, to);
    };
    await assert.rejects(
      () => replaceStagedFiles(replacements, tempDirectory, { rename: injectedRename }),
      /disk full/,
    );
    // 6 次调用 = a 备份 + a 替换 + b 备份 + b 替换(抛错) + b 内层回滚 + a 外层回滚
    assert.equal(renames, 6);
    assert.equal(await readFile(path.join(targets, "a.json"), "utf8"), "old-a");
    assert.equal(await readFile(path.join(targets, "b.json"), "utf8"), "old-b");
  });
});

test("a failing replacement with no previous target keeps the original error and never touches the target", async () => {
  await withTempDirectory("avenic-vendor-fresh-", async (root) => {
    const target = path.join(root, "targets", "new.json");
    const staged = path.join(root, "temp", "staged", "new.json");
    await mkdir(path.dirname(target), { recursive: true });
    await mkdir(path.dirname(staged), { recursive: true });
    await writeFile(staged, "new");
    const sentinel = Object.assign(new Error("sentinel-boom"), { marker: "staged-to-target" });
    const calls = [];
    const injectedRename = async (from, to) => {
      calls.push([from, to]);
      if (from === staged && to === target) throw sentinel;
      const { rename } = await import("node:fs/promises");
      return rename(from, to);
    };
    await assert.rejects(
      () => replaceStagedFiles([{ relativePath: "new.json", staged, target }], path.join(root, "temp"), { rename: injectedRename }),
      (error) => error.marker === "staged-to-target",
    );
    // 没有旧 target 就没有可恢复的备份：不得多出一次 backup→target 尝试（那会以 ENOENT 掩盖原始错误）
    assert.deepEqual(calls, [[staged, target]]);
    assert.equal(existsSync(target), false);
  });
});
