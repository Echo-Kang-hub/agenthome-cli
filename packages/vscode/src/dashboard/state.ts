import { agentExecutableAvailable, agentStatus, listAgents } from "../services/agents.ts";
import { defaultSpec } from "../services/catalog.ts";
import { status as skillsStatus } from "../services/skills.ts";
import type { DashboardData } from "./protocol.ts";

// 纯数据组装（无 vscode import）：所有可执行/网络/状态读取都走 services 层 + 注入的 environment，
// 使测试可以经 testEnv 隔离宿主配置；revision 在 sync 前保持 "—"（打开 Dashboard 不做隐式网络拉取）。
export async function buildDashboardData(projectRoot: string | null, environment: NodeJS.ProcessEnv = process.env): Promise<DashboardData> {
  if (projectRoot === null) {
    return {
      projectRoot: null,
      agents: listAgents().map((a) => ({
        id: a.id,
        label: a.displayName,
        statusText: "未打开项目",
        executableAvailable: agentExecutableAvailable(a.id),
        iconHint: "circle-outline",
      })),
      catalog: null,
      skillsHealth: [{ label: "Skills", ok: false, details: "未打开项目" }],
    };
  }
  const agents = await Promise.all(
    listAgents().map(async (a) => {
      const s = await agentStatus(projectRoot, a.id);
      return {
        id: s.agent.id,
        label: s.agent.displayName,
        statusText: s.effective ? `已初始化 · ${s.effective.auth} / ${s.effective.sessions}` : "未初始化",
        executableAvailable: s.executableAvailable,
        iconHint: s.effective ? "pass-filled" : "circle-outline",
      };
    }),
  );
  const spec = await defaultSpec(environment);
  const skills = await skillsStatus("project", projectRoot, environment).catch(() => null);
  return {
    projectRoot,
    agents,
    catalog: spec === null ? null : { spec, revision: "—" },
    skillsHealth: skills === null
      ? [{ label: "Skills", ok: false, details: "尚未安装" }]
      : skills.targets.map((t) => ({ label: t.label, ok: t.complete, details: `${t.present}/${t.total}` })),
  };
}
