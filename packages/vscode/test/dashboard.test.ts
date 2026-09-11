import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildDashboardData } from "../src/dashboard/state.ts";
import { isWebviewMessage } from "../src/dashboard/protocol.ts";
import { select, sync } from "../src/services/catalog.ts";
import { installPacks } from "../src/services/skills.ts";
import { makeCatalogFixture, testEnv } from "./helpers.ts";

test("buildDashboardData includes all sections on fresh project", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    // testEnv 注入隔离 STATE_DIR 并剥离宿主 Avenic 变量（机器无关）
    const data = await buildDashboardData(dir, testEnv(dir));
    assert.equal(data.projectRoot, dir, "projectRoot 为传入的项目根（null 分支由 UI 层呈现未打开状态）");
    assert.equal(data.agents.length, 3);
    assert.ok(data.agents.every((a) => a.statusText === "未初始化")); // 全新项目无 .avenic.json → 全部未初始化
    assert.equal(data.catalog, null); // 隔离 env 下无默认 Catalog → null
    assert.ok(Array.isArray(data.skillsHealth));
    assert.equal(data.skillsHealth.length, 1);
    assert.equal(data.skillsHealth[0].ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildDashboardData renders the not-opened state for null root", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    const data = await buildDashboardData(null, testEnv(dir));
    assert.equal(data.projectRoot, null);
    assert.equal(data.catalog, null);
    assert.equal(data.agents.length, 3);
    for (const agent of data.agents) {
      assert.equal(agent.statusText, "未打开项目");
      assert.equal(typeof agent.executableAvailable, "boolean"); // 仅类型断言：可执行文件依赖宿主 PATH，不断言值
    }
    assert.equal(data.skillsHealth.length, 1);
    assert.equal(data.skillsHealth[0].ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildDashboardData reads the cached catalog revision (not the placeholder '—')", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const project = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(project, { recursive: true });
    await makeCatalogFixture(catalogDir);
    await select(catalogDir, env); // 注册并设为默认（本地 git fixture，无网络）
    await sync(catalogDir, env); // 同步一次 → 本地缓存就绪（cachedRevision 只读缓存，绝不 fetch）
    const data = await buildDashboardData(project, env);
    assert.ok(data.catalog !== null);
    assert.equal(data.catalog.spec, catalogDir);
    assert.match(data.catalog.revision, /^[0-9a-f]{40}$/, "revision 读取缓存 fixture 的真实 commit，而非 '—'");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildDashboardData degrades to '—' when the catalog has no local cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const project = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(project, { recursive: true });
    await makeCatalogFixture(catalogDir);
    await select(catalogDir, env); // 已登记默认，但从未同步 → 无缓存目录
    const data = await buildDashboardData(project, env);
    assert.ok(data.catalog !== null);
    assert.equal(data.catalog.revision, "—", "无缓存时占位符，而不是触发网络/显示空白");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skillsHealth reports untracked on-disk skills when no install metadata", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    await mkdir(path.join(dir, ".agents", "skills", "alpha"), { recursive: true });
    await writeFile(path.join(dir, ".agents", "skills", "alpha", "SKILL.md"), "# alpha");
    await mkdir(path.join(dir, ".agents", "skills", "bravo"), { recursive: true });
    await writeFile(path.join(dir, ".agents", "skills", "bravo", "SKILL.md"), "# bravo");
    const data = await buildDashboardData(dir, testEnv(dir));
    assert.equal(data.skillsHealth.length, 1);
    assert.equal(data.skillsHealth[0].ok, false);
    assert.equal(data.skillsHealth[0].details, "2 个 Skill 未托管");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("skillsHealth splits shared targets into four per-agent rows with sharing state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const project = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(project, { recursive: true });
    await makeCatalogFixture(catalogDir);
    await select(catalogDir, env);
    await installPacks("project", ["common"], project, env); // alpha 装入两个 target
    const data = await buildDashboardData(project, env);
    // Claude Code 与 Codex / OpenCode / universal agents 平级分行，不再合并成两行
    assert.deepEqual(data.skillsHealth.map((r) => r.label), ["Claude Code", "Codex", "OpenCode", "universal agents"]);
    assert.ok(data.skillsHealth.every((r) => r.ok));
    // 共享语义：claude 是 share 目标（state=linked）→ "shared"；canonical 目标按 present/total
    assert.deepEqual(data.skillsHealth.map((r) => r.details), ["shared", "1/1", "1/1", "1/1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skillsHealth reports missing shared links per state, not a fixed string", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const project = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(project, { recursive: true });
    await makeCatalogFixture(catalogDir);
    await select(catalogDir, env);
    await installPacks("project", ["common"], project, env);
    await rm(path.join(project, ".claude", "skills", "alpha"), { recursive: true, force: true }); // share 目标缺失
    const data = await buildDashboardData(project, env);
    assert.deepEqual(data.skillsHealth.map((r) => r.details), ["links missing", "1/1", "1/1", "1/1"]);
    assert.deepEqual(data.skillsHealth.map((r) => r.ok), [false, true, true, true], "share 目标缺失 → 该行不 ok");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("protocol guard accepts valid webview messages", () => {
  assert.ok(isWebviewMessage({ type: "ready" }));
  assert.ok(isWebviewMessage({ type: "refresh" }));
  for (const command of ["catalog.sync", "skills.installPacks", "skills.addDirect", "agents.init", "agents.sessionsImport"]) {
    assert.ok(isWebviewMessage({ type: "command", command }));
  }
  assert.ok(!isWebviewMessage({ type: "report", message: "all good" })); // report 类型已删除：一律拒绝
  assert.ok(!isWebviewMessage({ type: "boom" }));
  assert.ok(!isWebviewMessage(null));
});

test("protocol guard rejects report messages (dead type removed, sender and handler gone)", () => {
  assert.ok(!isWebviewMessage({ type: "report" })); // 缺 message → 拒
  assert.ok(!isWebviewMessage({ type: "report", message: 42 })); // 非字符串 → 拒
  assert.ok(!isWebviewMessage({ type: "report", message: "all good" })); // 完整载荷同样拒绝
});

test("protocol guard rejects command not in allowlist", () => {
  assert.ok(!isWebviewMessage({ type: "command", command: "shell.open" }));
  assert.ok(!isWebviewMessage({ type: "command", command: 42 }));
});
