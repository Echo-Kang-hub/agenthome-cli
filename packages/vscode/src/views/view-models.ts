import type { InstallStatus, KnownCatalogEntry, Pack } from "@avenic/core";
import type { AgentStatus } from "../services/agents.ts";

export interface AgentViewItem { id: string; label: string; description: string; tooltip: string; iconHint: string; active: boolean; }

export function agentsToViewModels(statuses: AgentStatus[]): AgentViewItem[] {
  return statuses.map(({ agent, executableAvailable, effective }) => ({
    id: agent.id,
    label: agent.displayName,
    description: effective ? `已初始化 · ${effective.auth} / ${effective.sessions}` : "未初始化",
    tooltip: `${agent.executable} · CLI ${executableAvailable ? "可用" : "不可用"} · ${effective ? `auth: ${effective.auth}, sessions: ${effective.sessions}` : "未初始化"}`,
    iconHint: effective ? "pass-filled" : "circle-outline",
    active: effective !== null,
  }));
}

export interface CatalogViewItem { kind: "current" | "entry"; label: string; description: string; }
export function catalogToViewModels(defaultSpec: string | null, known: KnownCatalogEntry[]): CatalogViewItem[] {
  const current = known.find((k) => k.spec === defaultSpec);
  const first = [] as CatalogViewItem[];
  if (defaultSpec) first.push({ kind: "current", label: defaultSpec, description: current?.name ?? "" });
  return first.concat(known.filter((k) => k.spec !== defaultSpec).map((k) => ({ kind: "entry", label: k.spec, description: k.name })));
}

// Catalog 树子级行：pack（可展开）/ source（分组，可再展开）/ skill / hint（未缓存提示）
export interface CatalogChildItem { kind: "pack" | "source" | "skill" | "hint"; label: string; description: string; iconHint: string; id?: string; }

export function catalogPacksToViewModels(packs: Pack[]): CatalogChildItem[] {
  return [...packs].sort((a, b) => a.id.localeCompare(b.id)).map((pack) => ({
    kind: "pack",
    label: pack.name,
    description: pack.description ?? pack.id,
    iconHint: "package",
    id: pack.id,
  }));
}

// Pack 的源码分组行（层次来自 packStructure 的 resolvePack 结果）：保持 pack.sources 顺序，
// 每来源一行（label 用来源 name，缺省回退 id），描述为该来源下的 Skill 数。
export interface CatalogSourceGroupModel { label: string; description: string; sourceId: string; skills: string[]; }
export function catalogSourceGroupsToViewModels(structure: { groups: Array<{ source: { id: string; name?: string }; skills: Array<{ name: string }> }> }): CatalogSourceGroupModel[] {
  return structure.groups.map((group) => ({
    label: group.source.name ?? group.source.id,
    description: `${group.skills.length} 个 Skill`,
    sourceId: group.source.id,
    skills: group.skills.map((skill) => skill.name),
  }));
}

// Pack → Skill 行（离线/无层次时的扁平回退）：保持 pack.sources 顺序，同名 Skill 只出现一次
export function catalogPackSkillsToViewModels(pack: Pack): CatalogChildItem[] {
  const seen = new Set<string>();
  return pack.sources.flatMap((source) =>
    source.skills
      .filter((name) => (seen.has(name) ? false : (seen.add(name), true)))
      .map((name) => ({ kind: "skill", label: name, description: source.source, iconHint: "file", id: name })),
  );
}

export interface SkillsViewItem {
  kind: "group" | "pack" | "source" | "skill" | "direct" | "adopted" | "detected";
  label: string;
  description: string;
  iconHint: string;
  // 子行（递归）：source 行 → 该来源的 Skill 行；detected/adopted 行无子级（叶子带命令键位）
  children?: SkillsViewItem[];
}
// 树形分组：item 为主行，children 为可展开的子行
export interface SkillsViewGroup { item: SkillsViewItem; children?: SkillsViewItem[]; }
// 空态提示按作用域区分：项目组保留项目味提示；全局组不得含项目根引用（零工作区窗口也成立）
export const PROJECT_EMPTY_HINT = "打开一个新项目根后安装 Pack";
export const GLOBAL_EMPTY_HINT = "全局域 Pack 请从命令面板安装";
export function skillsToViewModels(status: InstallStatus | null, detected: string[] = [], emptyHint: string = PROJECT_EMPTY_HINT): SkillsViewGroup[] {
  // 磁盘检测（core detectedSkillNames）减去托管记录 = 未托管内容（旧版/外部工具安装、手工拷贝）
  const managed = status === null ? [] : status.names;
  const untracked = detected.filter((name) => !managed.includes(name));
  const groups: SkillsViewGroup[] = [];
  if (untracked.length > 0) {
    groups.push({
      item: {
        kind: "detected",
        label: `检测到 ${untracked.length} 个 Skill（未托管）`,
        description: "磁盘存在但无 Avenic 管理记录；重新安装 Packs 或直装 Skill 会接管",
        iconHint: "info",
      },
      children: untracked.map((name) => ({ kind: "detected", label: name, description: "未托管", iconHint: "file" })),
    });
  }
  if (status === null) {
    groups.push({ item: { kind: "group", label: "尚未安装 Skills", description: emptyHint, iconHint: "info" } });
    return groups;
  }
  const complete = status.targets.filter((t) => t.complete).length;
  // Installed Packs 子级按来源分组（层次：Pack → source → Skill，来源名直接可见）；
  // 不在任何 source 分组内、仅由"托管"记录的 Skill（旧版包残留）缀为 adopted 行——
  // 这些正是「识别为 Pack 接管」的候选（行级键位 avenic.skills.adoptPack）。
  const covered = new Set<string>();
  const sourceRows = status.groups.map((group) => {
    group.skills.forEach((skill) => covered.add(skill.name));
    return {
      kind: "source" as const,
      label: group.source.name ?? group.source.id,
      description: `${group.skills.length} 个 Skill`,
      iconHint: "repo" as const,
      children: group.skills.map((skill) => ({
        kind: "skill" as const,
        label: skill.name,
        description: group.source.id,
        iconHint: "file" as const,
      })),
    };
  });
  const adoptedRows = status.names
    .filter((name) => !covered.has(name))
    .map((name) => ({ kind: "adopted" as const, label: name, description: "已托管 · 无 Pack 记录", iconHint: "file" as const }));
  groups.push(
    {
      item: { kind: "group", label: "Installed Packs", description: `${status.names.length} 个 Skill / ${status.packs.length} 个 Pack`, iconHint: "package" },
      children: [...sourceRows, ...adoptedRows],
    },
    { item: { kind: "group", label: "Catalog Packs", description: `${status.packs.length} 个 Pack / ${status.groups.length} 个分组`, iconHint: "repo" } },
    { item: { kind: "group", label: "完整性", description: `${complete}/${status.targets.length} 个 target 完成`, iconHint: "verify" } },
  );
  return groups;
}
