import assert from "node:assert/strict";
import test from "node:test";
import { agentsToViewModels, catalogToViewModels, GLOBAL_EMPTY_HINT, PROJECT_EMPTY_HINT, skillsToViewModels } from "../src/views/view-models.ts";

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
  // 模型无 dead tooltip 字段：规则守源码观感，TreeItem 只展示 label
  assert.deepEqual(items[0], { kind: "current", label: "Echo-Kang-hub/avenic-catalog#main", description: "Avenic Catalog" });
  assert.equal(items[1].kind, "entry");
});

test("catalog model renders entries without a project root (global/state-dir domain)", () => {
  // 无项目根 + 无默认 spec：仅凭注册列表即可渲染数据（W1 根门禁移除）
  const items = catalogToViewModels(null, [{ name: "Avenic Catalog", spec: "Echo-Kang-hub/avenic-catalog#main" }]);
  assert.deepEqual(items, [{ kind: "entry", label: "Echo-Kang-hub/avenic-catalog#main", description: "Avenic Catalog" }]);
});

test("catalog model is empty only when genuinely nothing to show", () => {
  assert.deepEqual(catalogToViewModels(null, []), []); // 无默认 spec 且无注册 → 视图显示提示行
  assert.equal(catalogToViewModels("Echo-Kang-hub/avenic-catalog#main", []).length, 1); // 有默认 spec → 仍有数据
});

test("skills empty-state copy is scope-aware", () => {
  assert.equal(skillsToViewModels(null, PROJECT_EMPTY_HINT)[0].description, "打开一个新项目根后安装 Pack");
  assert.equal(skillsToViewModels(null, GLOBAL_EMPTY_HINT)[0].description, "全局域 Pack 请从命令面板安装");
});

test("skills status maps to grouped items", () => {
  const items = skillsToViewModels({ groups: [], names: ["pack-a"], packs: [{ id: "pack-a", name: "Pack A" }], targets: [] });
  assert.ok(items.length >= 1); // 分组（Installed Packs / Catalog Packs / Direct Skills）
  assert.equal(items[0].kind, "group");
});
