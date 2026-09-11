// 面板消息白名单（仿 dashboard/protocol.ts）：webview 永远不能指定路径或命令，
// 只能提交结构化的 profile 草稿与 id。apiKey === null 表示"不修改现有密钥"。
export interface ProfileDraft {
  id: string;
  name: string;
  baseUrl: string;
  api: "anthropic" | "openai-chat" | "openai-responses";
  apiKey: string | null;
  mainModel?: string;
  passthrough?: Record<string, unknown>;
}

export type ModelViewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "saveProfile"; profile: ProfileDraft }
  | { type: "deleteProfile"; id: string }
  | { type: "bindProject"; id: string }
  | { type: "clearProject" }
  | { type: "testConnection"; id: string }
  | { type: "parseJson"; text: string }
  | { type: "parseText"; text: string }
  | { type: "openLibraryFile" }
  | { type: "openSettingsFile" };

export interface ModelCardData {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKeyMasked: string;
  mainModel: string;
  current: boolean;
  compatibility: { claude: { ok: boolean; reason?: string }; codex: { ok: boolean; reason?: string }; opencode: { ok: boolean; reason?: string } };
}

export interface ModelPanelData {
  libraryPath: string;
  libraryExists: boolean;
  libraryBroken: string | null;
  projectRoot: string | null;
  cards: ModelCardData[];
  binding: { profileId: string; name: string } | null;
  projection: { file: string; keys: number; fingerprintMatches: boolean } | null;
  notes: string[];
  message: string | null;
}

export type ModelSenderMessage =
  | { type: "data"; payload: ModelPanelData }
  | { type: "parsed"; payload: unknown }
  | { type: "testResult"; payload: unknown }
  | { type: "error"; message: string };

const MAX_TEXT = 20_000;
const APIS = ["anthropic", "openai-chat", "openai-responses"];

function isShortString(value: unknown, max = 200): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isDraft(value: unknown): value is ProfileDraft {
  if (typeof value !== "object" || value === null) return false;
  const draft = value as Record<string, unknown>;
  if (!isShortString(draft.id, 32) || !isShortString(draft.name, 200)) return false;
  if (!isShortString(draft.baseUrl, 2000)) return false;
  if (typeof draft.api !== "string" || !APIS.includes(draft.api)) return false;
  if (draft.apiKey !== null && !isShortString(draft.apiKey, 1000)) return false;
  if (draft.mainModel !== undefined && !isShortString(draft.mainModel, 128)) return false;
  return true;
}

export function isModelViewMessage(value: unknown): value is ModelViewMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "ready":
    case "refresh":
    case "clearProject":
    case "openLibraryFile":
    case "openSettingsFile":
      return true;
    case "deleteProfile":
    case "bindProject":
    case "testConnection":
      return isShortString(message.id, 32);
    case "parseJson":
    case "parseText":
      return typeof message.text === "string" && message.text.length <= MAX_TEXT;
    case "saveProfile":
      return isDraft(message.profile);
    default:
      return false;
  }
}
