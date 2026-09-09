import path from "node:path";
import {
  AGENTS,
  acquireSessionLease,
  agentExecutableAvailable as coreAgentExecutableAvailable,
  clearLocalAuth,
  deinitializeAgent,
  effectiveAgentConfig,
  getAgent,
  getSessionAdapter,
  initializeAgent,
  loadRuntime,
  projectAuthEnvironment,
  sessionLeasePath,
  setLocalAuth,
  type Agent,
  type EffectiveAgentConfig,
} from "@avenic/core";
import { cliVersionStatus, type CliVersionStatus } from "./agent-versions.ts";

export interface AgentStatus {
  agent: Agent;
  executableAvailable: boolean;
  effective: EffectiveAgentConfig | null;
  // 本机已装版本与 npm registry 最新版（10 分钟缓存，失败容错为 null）
  cli: CliVersionStatus;
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
  const agent = getAgent(agentId);
  // 探测并行化：本机 --version 与 npm registry 查询互不依赖；单次失败容错为 null
  const [executableAvailable, cli] = await Promise.all([
    Promise.resolve(coreAgentExecutableAvailable(agentId)),
    cliVersionStatus(agentId, agent),
  ]);
  return { agent, executableAvailable, effective: effectiveAgentConfig(state, agentId), cli };
}

export { invalidateCliVersionCache, npmPackage } from "./agent-versions.ts";

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

// ---- 启动运行（免 @avenic/cli npm 包：插件直接复用 core 运行时原语） ----
// 等价于 `avenic <agent>` 的一次启动：项目认证环境注入（project auth）、便携会话
// 快照/恢复/回收（project sessions——与 CLI 共用同一 lease 文件与快照目录，交叉启动互不冲突）。
// 官方 CLI 交互在集成终端进行；终端关闭时由命令层调用 finishRun 收官。

export interface AgentLaunchDefinition {
  name: string;
  cwd: string;
  environment: Record<string, string>;
  command: string; // 终端内执行的官方 CLI 命令（executable 名，端子按 PATH 解析）
}

export interface PreparedLaunch {
  definition: AgentLaunchDefinition;
  // 收官：捕获本次运行会话进项目并偿还 lease（最后成员恢复原生存储）；幂等。
  finishRun: () => Promise<void>;
}

export async function prepareAgentLaunch(projectRoot: string, agentId: string): Promise<PreparedLaunch> {
  const agent = getAgent(agentId);
  const state = await loadRuntime(projectRoot);
  const config = effectiveAgentConfig(state, agentId);
  if (!config) {
    throw new Error(`${agent.displayName} 尚未初始化，请先执行「Avenic: 初始化 Agent」`);
  }
  const environment: Record<string, string> = { ...process.env } as Record<string, string>;
  if (config.auth === "project") {
    Object.assign(environment, projectAuthEnvironment(agentId, projectRoot));
  }
  const adapter = getSessionAdapter(agentId);
  const portableSessions = config.sessions === "project";
  const { snapshotNative, revertNative } = adapter;
  let leaveLaunchGroup: (() => Promise<unknown>) | null = null;
  if (portableSessions && snapshotNative && revertNative) {
    const snapshotRoot = path.join(sessionLeasePath(agentId, projectRoot), "snapshot");
    const lease = await acquireSessionLease(agentId, projectRoot, {
      onFirst: async (recovering) => {
        // 上次启动组未能正常收官（终端/窗口被杀）：先收回运行产物进项目，再还原启动前原生存储
        if (recovering) {
          await adapter.capture(projectRoot, { environment });
          await revertNative(snapshotRoot, projectRoot, { environment });
        }
        await snapshotNative(projectRoot, snapshotRoot, { environment });
      },
      onLast: async () => {
        await revertNative(snapshotRoot, projectRoot, { environment });
      },
    });
    leaveLaunchGroup = lease.release;
  }
  try {
    if (portableSessions) {
      // 项目会话记录优先：启动前把项目里的会话合并进原生存储供 CLI 使用
      await adapter.restore(projectRoot, { environment });
    }
  } catch (error) {
    if (leaveLaunchGroup) {
      try { await leaveLaunchGroup(); } catch {}
    }
    throw error;
  }
  let done = false;
  const finishRun = async (): Promise<void> => {
    if (done) return;
    done = true;
    try {
      if (portableSessions) {
        await adapter.capture(projectRoot, { environment });
      }
    } finally {
      if (leaveLaunchGroup) {
        try { await leaveLaunchGroup(); } catch {}
      }
    }
  };
  return {
    definition: {
      name: `Avenic · ${agent.displayName}`,
      cwd: projectRoot,
      environment,
      command: agent.executable,
    },
    finishRun,
  };
}
