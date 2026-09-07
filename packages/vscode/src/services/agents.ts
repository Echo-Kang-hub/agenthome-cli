import {
  AGENTS,
  agentExecutableAvailable as coreAgentExecutableAvailable,
  clearLocalAuth,
  deinitializeAgent,
  effectiveAgentConfig,
  getAgent,
  getSessionAdapter,
  initializeAgent,
  loadRuntime,
  setLocalAuth,
  type Agent,
  type EffectiveAgentConfig,
} from "@avenic/core";

export interface AgentStatus {
  agent: Agent;
  executableAvailable: boolean;
  effective: EffectiveAgentConfig | null;
}

export function listAgents(): Agent[] {
  return Object.keys(AGENTS).map((id) => getAgent(id)); // AGENTS 值不含 id，getAgent 补齐
}

// dashboard 专用薄包装（cwd 域，无 environment 参数——与 agentStatus 一致）
export function agentExecutableAvailable(agentId: string): boolean {
  return coreAgentExecutableAvailable(agentId);
}

export async function agentStatus(projectRoot: string, agentId: string): Promise<AgentStatus> {
  const state = await loadRuntime(projectRoot);
  return {
    agent: getAgent(agentId),
    executableAvailable: coreAgentExecutableAvailable(agentId),
    effective: effectiveAgentConfig(state, agentId),
  };
}

export function initialize(projectRoot: string, agentId: string, authMode: "global" | "project", sessionsMode: "global" | "project") {
  return initializeAgent(projectRoot, agentId, authMode, sessionsMode);
}

export function deinitialize(projectRoot: string, agentId: string, purge?: boolean) {
  return deinitializeAgent(projectRoot, agentId, purge ? { purge: true } : undefined);
}

export async function setAuthMode(projectRoot: string, agentId: string, mode: "global" | "project" | "reset") {
  if (mode === "reset") return clearLocalAuth(projectRoot, agentId);
  return setLocalAuth(projectRoot, agentId, mode);
}

export async function setSessionsMode(projectRoot: string, agentId: string, mode: "global" | "project") {
  const state = await loadRuntime(projectRoot);
  const effective = effectiveAgentConfig(state, agentId);
  const auth = effective?.auth ?? "global";
  return initializeAgent(projectRoot, agentId, auth, mode);
}

export function importSessions(projectRoot: string, agentId: string) {
  return getSessionAdapter(agentId).restore(projectRoot);
}

export function writebackSessions(projectRoot: string, agentId: string) {
  return getSessionAdapter(agentId).capture(projectRoot);
}
