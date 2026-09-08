import assert from "node:assert/strict";
import test from "node:test";
import { agentsToViewModels, catalogPackSkillsToViewModels, catalogPacksToViewModels, catalogSourceGroupsToViewModels, catalogToViewModels, GLOBAL_EMPTY_HINT, PROJECT_EMPTY_HINT, skillsToViewModels } from "../src/views/view-models.ts";

test("uninitialized agent renders as 未初始化", () => {
  const items = agentsToViewModels([{ agent: { id: "claude", displayName: "Claude Code", executable: "claude" }, executableAvailable: true, effective: null }]);
  assert.deepEqual(items[0], { id: "claude", label: "Claude Code", description: "未初始化", tooltip: "claude · CLI 可用 · 未初始化", iconHint: "circle-outline", active: false });
});

test("initialized agent is active for state-specific row keys", () => {
  const items = agentsToViewModels([{ agent: { id: "claude", displayName: "Claude Code", executable: "claude" }, executableAvailable: true, effective: { enabled: true, auth: "global", sessions: "project", configuredAuth: "global", localAuth: null } }]);
  assert.equal(items[0].active, true);
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
  const groups = skillsToViewModels(null, [], PROJECT_EMPTY_HINT);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].item.description, "打开一个新项目根后安装 Pack");
  assert.equal(groups[0].item.label, "尚未安装 Skills");
  const global = skillsToViewModels(null, [], GLOBAL_EMPTY_HINT);
  assert.equal(global[0].item.description, "全局域 Pack 请从命令面板安装");
});

test("skills status maps to grouped items", () => {
  const items = skillsToViewModels({ groups: [], names: ["pack-a"], packs: [{ id: "pack-a", name: "Pack A" }], targets: [] });
  assert.ok(items.length >= 1); // 分组（Installed Packs / Catalog Packs / 完整性）
  assert.equal(items[0].item.kind, "group");
  // Installed Packs 组可展开：无 source 分组兜底时，仅托管记录的行按 adopted 呈现（可识别为 Pack）
  assert.deepEqual(items[0].children?.map((c) => c.label), ["pack-a"]);
  assert.equal(items[0].children?.[0].kind, "adopted");
});

test("installed packs children layer by source group (Pack → source → skill)", () => {
  const group = (id: string, name: string, skills: string[]) => {
    const source = { id, name, repository: `https://github.com/${id}`, revision: "a".repeat(40) };
    return { source, skills: skills.map((skill) => ({ name: skill, directory: skill, source })) };
  };
  const items = skillsToViewModels({
    groups: [
      group("superpowers", "Superpowers", ["writing-plans", "debugging"]),
      group("anthropic", "Anthropic", ["docx"]),
    ],
    names: ["writing-plans", "debugging", "docx", "legacy-one"],
    packs: [{ id: "development", name: "Development" }],
    targets: [],
  });
  const children = items[0].children!;
  // 两个 source 分组行 + 一个 adopted 兜底行
  assert.deepEqual(children.map((c) => c.kind), ["source", "source", "adopted"]);
  assert.equal(children[0].label, "Superpowers");
  assert.equal(children[0].description, "2 个 Skill");
  assert.deepEqual(children[0].children?.map((s) => s.label), ["writing-plans", "debugging"]);
  assert.equal(children[0].children?.[1].kind, "skill");
  assert.equal(children[2].label, "legacy-one");
  assert.equal(children[2].kind, "adopted");
  // Catalog Packs 与完整性分组保持为纯信息行
  assert.equal(items[1].item.label, "Catalog Packs");
  assert.equal(items[2].item.label, "完整性");
});

test("skills null with untracked on-disk skills shows detected group (children) above the empty hint", () => {
  const groups = skillsToViewModels(null, ["alpha", "beta"], PROJECT_EMPTY_HINT);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].item.kind, "detected");
  assert.equal(groups[0].item.label, "检测到 2 个 Skill（未托管）");
  assert.deepEqual(groups[0].children?.map((c) => c.label), ["alpha", "beta"]);
  assert.equal(groups[0].children?.[0].kind, "detected");
  assert.equal(groups[1].item.label, "尚未安装 Skills");
});

test("skills status with stray files shows detected-untracked group first", () => {
  const status = { groups: [], names: ["managed-one"], packs: [{ id: "pack-a", name: "Pack A" }], targets: [] };
  const groups = skillsToViewModels(status, ["managed-one", "stray"], PROJECT_EMPTY_HINT);
  assert.equal(groups.length, 4);
  assert.equal(groups[0].item.kind, "detected");
  assert.equal(groups[0].item.label, "检测到 1 个 Skill（未托管）");
  assert.deepEqual(groups[0].children?.map((c) => c.label), ["stray"]);
});

test("fully managed status adds no detected group", () => {
  const status = { groups: [], names: ["managed-one"], packs: [], targets: [] };
  const groups = skillsToViewModels(status, ["managed-one"], PROJECT_EMPTY_HINT);
  assert.equal(groups.length, 3);
  assert.ok(groups.every((g) => g.item.kind === "group"));
});

test("catalog packs map to sorted pack rows with id", () => {
  const rows = catalogPacksToViewModels([
    { id: "extra", name: "Extra", sources: [] },
    { id: "common", name: "Common", sources: [] },
  ]);
  assert.deepEqual(rows.map((r) => r.id), ["common", "extra"]);
  assert.equal(rows[0].kind, "pack");
  assert.equal(rows[0].label, "Common");
});

test("catalog pack expands to deduped skill rows keeping source order", () => {
  const rows = catalogPackSkillsToViewModels({
    id: "common", name: "Common",
    sources: [
      { source: "demo", skills: ["alpha", "beta"] },
      { source: "other", skills: ["beta", "gamma"] },
    ],
  });
  assert.deepEqual(rows.map((r) => r.label), ["alpha", "beta", "gamma"]); // 同名 beta 只出现一次
  assert.equal(rows[2].description, "other"); // 描述标来源 source id
  assert.ok(rows.every((r) => r.kind === "skill"));
});

test("catalog source groups map to layered rows preserving pack.sources order", () => {
  const rows = catalogSourceGroupsToViewModels({
    groups: [
      { source: { id: "superpowers", name: "Superpowers" }, skills: [{ name: "writing-plans" }, { name: "debugging" }] },
      { source: { id: "othmanadi", name: "Othmanadi" }, skills: [{ name: "planning" }] },
    ],
  });
  assert.deepEqual(rows.map((r) => [r.label, r.skills]), [
    ["Superpowers", ["writing-plans", "debugging"]],
    ["Othmanadi", ["planning"]],
  ]);
  assert.equal(rows[0].description, "2 个 Skill");
});
