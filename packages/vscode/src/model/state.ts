import {
  agentCompatibility,
  getProfile,
  listProfiles,
  maskSecret,
  modelsFile,
  projectModelStatus,
  readLibrary,
} from "@avenic/core";
import type { ModelCardData, ModelPanelData } from "./protocol.ts";

// vscode-free：面板数据组装在纯模块里（插件测试没有 vscode stub），
// 且只输出掩码——完整密钥永不进入 webview。
export async function buildModelPanelData(input: { projectRoot: string | null; environment: NodeJS.ProcessEnv }): Promise<ModelPanelData> {
  const { projectRoot, environment } = input;
  const libraryPath = modelsFile(environment);
  const base: ModelPanelData = {
    libraryPath,
    libraryExists: false,
    libraryBroken: null,
    projectRoot,
    cards: [],
    binding: null,
    projection: null,
    notes: [],
    message: null,
  };
  try {
    const library = await readLibrary(environment);
    base.libraryExists = library.exists;
    const status = projectRoot === null ? null : await projectModelStatus(projectRoot, environment);
    base.message = status?.message ?? null;
    base.cards = Object.values(library.profiles)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((profile) => ({
        id: profile.id,
        name: profile.name,
        baseUrl: profile.endpoint.baseUrl,
        api: profile.endpoint.api,
        apiKeyMasked: maskSecret(profile.endpoint.apiKey),
        mainModel: profile.models?.main?.id ?? "",
        current: status?.binding.activeProfileId === profile.id,
        compatibility: agentCompatibility(profile),
      }));
    if (status?.profile) {
      base.binding = { profileId: status.profile.id, name: status.profile.name };
      base.projection = status.projection;
      base.notes.push("Codex：启动时注入 -c model_provider / -m（不写项目文件）");
      base.notes.push("OpenCode：启动时注入 OPENCODE_CONFIG_CONTENT（不写项目文件）");
      if (status.projection && !status.projection.fingerprintMatches) {
        base.notes.push("投影指纹不一致：下次启动会重新生成");
      }
    }
  } catch (error) {
    base.libraryBroken = error instanceof Error ? error.message : String(error);
  }
  if (projectRoot === null) {
    base.notes.push("未打开项目文件夹：「用于当前项目」不可用");
  }
  return base;
}
