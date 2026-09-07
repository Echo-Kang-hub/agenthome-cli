import type { InstallStatus, KnownCatalogEntry } from "@avenic/core";
import type { AgentStatus } from "../services/agents.ts";

export interface AgentViewItem { id: string; label: string; description: string; tooltip: string; iconHint: string; }

export function agentsToViewModels(statuses: AgentStatus[]): AgentViewItem[] {
  return statuses.map(({ agent, executableAvailable, effective }) => ({
    id: agent.id,
    label: agent.displayName,
    description: effective ? `已初始化 · ${effective.auth} / ${effective.sessions}` : "未初始化",
    tooltip: `${agent.executable} · CLI ${executableAvailable ? "可用" : "不可用"} · ${effective ? `auth: ${effective.auth}, sessions: ${effective.sessions}` : "未初始化"}`,
    iconHint: effective ? "pass-filled" : "circle-outline",
  }));
}

export interface CatalogViewItem { kind: "current" | "entry"; label: string; description: string; }
export function catalogToViewModels(defaultSpec: string | null, known: KnownCatalogEntry[]): CatalogViewItem[] {
  const current = known.find((k) => k.spec === defaultSpec);
  const first = [] as CatalogViewItem[];
  if (defaultSpec) first.push({ kind: "current", label: defaultSpec, description: current?.name ?? "" });
  return first.concat(known.filter((k) => k.spec !== defaultSpec).map((k) => ({ kind: "entry", label: k.spec, description: k.name })));
}

export interface SkillsViewItem { kind: "group" | "pack" | "skill" | "direct"; label: string; description: string; iconHint: string; }
// 空态提示按作用域区分：项目组保留项目味提示；全局组不得含项目根引用（零工作区窗口也成立）
export const PROJECT_EMPTY_HINT = "打开一个新项目根后安装 Pack";
export const GLOBAL_EMPTY_HINT = "全局域 Pack 请从命令面板安装";
export function skillsToViewModels(status: InstallStatus | null, emptyHint: string = PROJECT_EMPTY_HINT): SkillsViewItem[] {
  if (status === null) return [{ kind: "group", label: "尚未安装 Skills", description: emptyHint, iconHint: "info" }];
  const complete = status.targets.filter((t) => t.complete).length;
  return [
    { kind: "group", label: "Installed Packs", description: status.names.length > 0 ? status.names.join(", ") : "无", iconHint: "package" },
    { kind: "group", label: "Catalog Packs", description: `${status.packs.length} 个 Pack / ${status.groups.length} 个分组`, iconHint: "repo" },
    { kind: "group", label: "完整性", description: `${complete}/${status.targets.length} 个 target 完成`, iconHint: "verify" },
  ];
}
