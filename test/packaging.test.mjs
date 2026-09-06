import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// pacote's git-dependency preparation (pacote/lib/git.js, #prepareDir) runs a nested
// `npm install` inside the freshly extracted clone whenever the installed manifest has
// a `workspaces` field or any install-lifecycle script. On Windows that nested reify
// renames the clone directory while the global install links to it, racing away files
// and leaving `npm install -g <owner/repo>` broken (agent: MODULE_NOT_FOUND). This
// package has zero runtime dependencies, so the nested install is never needed.
const PREPARE_TRIGGERS = ["postinstall", "build", "preinstall", "install", "prepack", "prepare"];

test("root manifest must not trigger pacote git-dependency preparation", async () => {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.workspaces, undefined, "a workspaces field triggers a nested npm install during git installs");
  for (const script of PREPARE_TRIGGERS) {
    assert.equal(
      manifest.scripts?.[script],
      undefined,
      `a "${script}" script triggers a nested npm install during git installs`,
    );
  }
});

// Short bins must not collide with shell builtins or aliases: `ac` is PowerShell's
// built-in alias for Add-Content, so `ac init` was executed as `Add-Content -Path init`
// and prompted interactively for a missing -Value. `ahc`/`ahx`/`aho` are free in
// PowerShell, cmd.exe, Git Bash, bash, and zsh.
test("published bin names avoid shell collisions", async () => {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "packages", "cli", "package.json"), "utf8"));
  assert.deepEqual(
    Object.keys(manifest.bin).sort(),
    ["agent", "agent-skills", "agenthome", "ahc", "aho", "ahx"],
  );
});
