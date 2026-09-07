import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildDashboardData } from "../src/dashboard/state.ts";
import { isWebviewMessage } from "../src/dashboard/protocol.ts";
import { select } from "../src/services/catalog.ts";
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

test("buildDashboardData reads the pinned catalog revision (not the placeholder '—')", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const project = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(project, { recursive: true });
    await makeCatalogFixture(catalogDir);
    await select(catalogDir, env); // 注册并设为默认（本地 git fixture，无网络）
    const data = await buildDashboardData(project, env);
    assert.ok(data.catalog !== null);
    assert.equal(data.catalog.spec, catalogDir);
    assert.match(data.catalog.revision, /^[0-9a-f]{40}$/, "revision 读取缓存 fixture 的真实 commit，而非 '—'");
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
