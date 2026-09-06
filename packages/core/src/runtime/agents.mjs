import process from "node:process";
import { spawnExecutableSync } from "./process.mjs";

export const AGENTS = {
  claude: {
    displayName: "Claude Code",
    executable: "claude",
  },
  codex: {
    displayName: "Codex",
    executable: "codex",
  },
  opencode: {
    displayName: "OpenCode",
    executable: "opencode",
  },
};

export function getAgent(agentId) {
  const agent = AGENTS[agentId];
  if (!agent) {
    throw new Error(`Unknown Agent: ${agentId}`);
  }
  return { id: agentId, ...agent };
}

export function agentExecutableAvailable(agentId, environment = process.env) {
  const agent = getAgent(agentId);
  try {
    const result = spawnExecutableSync(agent.executable, ["--version"], {
      env: environment,
      stdio: "pipe",
      windowsHide: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}
