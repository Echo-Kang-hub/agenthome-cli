export type WebviewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "command"; command: "catalog.sync" | "skills.installPacks" | "skills.addDirect" | "agents.init" | "agents.sessionsImport" }
  | { type: "report"; message: string };

export type SenderMessage =
  | { type: "data"; payload: DashboardData }
  | { type: "error"; message: string };

export interface DashboardData {
  projectRoot: string | null;
  agents: Array<{ id: string; label: string; statusText: string; executableAvailable: boolean; iconHint: string }>;
  catalog: { spec: string; revision: string } | null;
  skillsHealth: Array<{ label: string; ok: boolean; details: string }>;
}

// 与 commands/* 注册的命令一一对应（均已在 T7–T9 注册）——webview 只能转发白名单命令，
// 不可直达任意命令或 shell 能力。
const ALLOWED_COMMANDS: ReadonlyArray<string> = [
  "catalog.sync",
  "skills.installPacks",
  "skills.addDirect",
  "agents.init",
  "agents.sessionsImport",
];

export function isWebviewMessage(value: unknown): value is WebviewMessage {
  if (typeof value !== "object" || value === null) return false;
  const msg = value as Record<string, unknown>;
  if (msg.type === "ready" || msg.type === "refresh") return true;
  if (msg.type === "report") return typeof msg.message === "string";
  if (msg.type === "command") return typeof msg.command === "string" && ALLOWED_COMMANDS.includes(msg.command);
  return false;
}
