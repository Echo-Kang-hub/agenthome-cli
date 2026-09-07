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

export interface CatalogViewItem { kind: "current" | "entry"; label: string; description: string; tooltip: string; }
export function catalogToViewModels(defaultSpec: string | null, known: KnownCatalogEntry[]): CatalogViewItem[] {
  const current = known.find((k) => k.spec === defaultSpec);
  const first = [] as CatalogViewItem[];
  if (defaultSpec) first.push({ kind: "current", label: defaultSpec, description: current?.name ?? "", tooltip: `当前默认 Catalog · revision 见 sync` });
  return first.concat(known.filter((k) => k.spec !== defaultSpec).map((k) => ({ kind: "entry", label: k.spec, description: k.name, tooltip: k.spec })));
}

export interface SkillsViewItem { kind: "group" | "pack" | "skill" | "direct"; label: string; description: string; iconHint: string; }
export function skillsToViewModels(status: InstallStatus | null): SkillsViewItem[] {
  if (status === null) return [{ kind: "group", label: "尚未安装 Skills", description: "打开一个新项目根后安装 Pack", iconHint: "info" }];
  const complete = status.targets.filter((t) => t.complete).length;
  return [
    { kind: "group", label: "Installed Packs", description: status.names.length > 0 ? status.names.join(", ") : "无", iconHint: "package" },
    { kind: "group", label: "Catalog Packs", description: `${status.packs.length} 个 Pack / ${status.groups.length} 个分组`, iconHint: "repo" },
    { kind: "group", label: "完整性", description: `${complete}/${status.targets.length} 个 target 完成`, iconHint: "verify" },
  ];
}
