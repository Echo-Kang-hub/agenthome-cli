import assert from "node:assert/strict";
import test from "node:test";
import { agentsToViewModels, catalogToViewModels, skillsToViewModels } from "../src/views/view-models.ts";

test("uninitialized agent renders as 未初始化", () => {
  const items = agentsToViewModels([{ agent: { id: "claude", displayName: "Claude Code", executable: "claude" }, executableAvailable: true, effective: null }]);
  assert.deepEqual(items[0], { id: "claude", label: "Claude Code", description: "未初始化", tooltip: "claude · CLI 可用 · 未初始化", iconHint: "circle-outline" });
});

test("initialized agent shows auth/sessions", () => {
  const items = agentsToViewModels([{ agent: { id: "claude", displayName: "Claude Code", executable: "claude" }, executableAvailable: true, effective: { enabled: true, auth: "global", sessions: "project", configuredAuth: "global", localAuth: null } }]);
  assert.equal(items[0].description, "已初始化 · global / project");
  assert.equal(items[0].tooltip, "claude · CLI 可用 · auth: global, sessions: project");
});

test("catalog list marks current default", () => {
  const items = catalogToViewModels("Echo-Kang-hub/avenic-catalog#main", [
    { name: "Avenic Catalog", spec: "Echo-Kang-hub/avenic-catalog#main" },
    { name: "Other", spec: "Echo-Kang-hub/other#main" },
  ]);
  assert.equal(items[0].kind, "current");
  assert.equal(items[0].label, "Echo-Kang-hub/avenic-catalog#main");
  assert.equal(items[0].description, "Avenic Catalog");
  assert.equal(items[1].kind, "entry");
});

test("skills status maps to grouped items", () => {
  const items = skillsToViewModels({ groups: [], names: ["pack-a"], packs: [{ id: "pack-a", name: "Pack A" }], targets: [] });
  assert.ok(items.length >= 1); // 分组（Installed Packs / Catalog Packs / Direct Skills）
  assert.equal(items[0].kind, "group");
});
