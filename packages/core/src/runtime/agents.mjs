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
