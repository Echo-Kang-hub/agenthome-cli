import * as claude from "./claude.mjs";
import * as codex from "./codex.mjs";
import * as opencode from "./opencode.mjs";

const ADAPTERS = { claude, codex, opencode };

export function getSessionAdapter(agentId) {
  return ADAPTERS[agentId];
}
