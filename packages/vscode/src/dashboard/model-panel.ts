import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import { isModelViewMessage, type ModelSenderMessage } from "../model/protocol.ts";
import { panelData, parseJson, parseText } from "../services/model.ts";

export interface ModelPanelDeps {
  projectRoot: () => string | null;
  resolveRoot: () => Promise<string | null>;
  onMutation: () => void;
}

// 模板缺失/面板销毁时的降级：无脚本、无远程内容（照 dashboard/overview.ts 的静态提示）。
const FALLBACK_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8" /><meta http-equiv="Content-Security-Policy" content="default-src 'none'" /></head><body><p>模型配置面板初始化失败：视图资源缺失。</p></body></html>`;

// 本仓库第一个编辑器标签页 WebviewPanel（现有 webview 只有侧边栏 Overview）。
// 薄壳：模板注入（CSP nonce + webview Uri）、消息白名单、数据单向。
export class ModelPanel {
  static current: ModelPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly deps: ModelPanelDeps,
  ) {
    panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!isModelViewMessage(message)) return;
      void this.handle(message).catch((error: unknown) => {
        this.post({ type: "error", message: error instanceof Error ? error.message : String(error) });
      });
    }, undefined, this.disposables);
  }

  static show(extensionUri: vscode.Uri, deps: ModelPanelDeps): ModelPanel {
    if (ModelPanel.current) {
      ModelPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return ModelPanel.current;
    }
    const panel = vscode.window.createWebviewPanel("avenic.model", "Avenic 模型配置", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    });
    ModelPanel.current = new ModelPanel(panel, extensionUri, deps);
    void ModelPanel.current.render().catch(() => { /* 面板已销毁 */ });
    return ModelPanel.current;
  }

  refresh(): void {
    void this.sendData();
  }

  // 标签页关闭：清空单例（否则下次打开会对已销毁的面板 reveal 而抛错），
  // 逐个释放监听并清空数组；幂等（onDidDispose 与显式调用可能都到达）。
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (ModelPanel.current === this) ModelPanel.current = undefined;
    for (const item of this.disposables.splice(0)) item.dispose();
  }

  private async handle(message: import("../model/protocol.ts").ModelViewMessage): Promise<void> {
    if (message.type === "ready" || message.type === "refresh") return this.sendData();
    if (message.type === "openLibraryFile") return void vscode.commands.executeCommand("avenic.model.openLibraryFile");
    if (message.type === "openSettingsFile") return void vscode.commands.executeCommand("avenic.model.openSettingsFile");
    if (message.type === "parseJson") return void this.post({ type: "parsed", payload: { json: safeParse(() => parseJson(message.text)) } });
    if (message.type === "parseText") return void this.post({ type: "parsed", payload: { text: safeParse(() => parseText(message.text)) } });
    // 其余（保存/删除/复制/绑定/解绑/测试/预览）都转发到命令层，保证 MutationQueue 串行与刷新一致
    const forwarded: Record<string, string> = {
      saveProfile: "avenic.model.saveProfile",
      deleteProfile: "avenic.model.deleteProfile",
      duplicateProfile: "avenic.model.duplicateProfile",
      bindProject: "avenic.model.bindProject",
      clearProject: "avenic.model.clearProject",
      testConnection: "avenic.model.testConnection",
      preview: "avenic.model.preview",
    };
    const command = forwarded[message.type];
    if (!command) return;
    const result = await vscode.commands.executeCommand(command, message);
    if (message.type === "testConnection" && result !== undefined) {
      this.post({ type: "testResult", payload: result });
    }
    // 编辑区的实时预览：投影/请求地址/定位问题全部由 core 判定，面板只渲染回包（§9.7）。
    if (message.type === "preview" && result !== undefined) {
      // executeCommand 的返回类型是 {} | null，实际由 avenic.model.preview 决定。
      this.post({ type: "projection", payload: result as import("../model/protocol.ts").DraftPreview });
    }
  }

  private async render(): Promise<void> {
    try {
      await this.setHtml();
    } catch {
      try {
        this.panel.webview.html = FALLBACK_HTML;
      } catch { /* 面板已销毁 */ }
    }
    void this.sendData();
  }

  private async setHtml(): Promise<void> {
    const { webview } = this.panel;
    const htmlPath = vscode.Uri.joinPath(this.extensionUri, "media", "model", "view.html");
    const template = await readFile(htmlPath.fsPath, "utf8");
    const nonce = randomUUID();
    const mainJs = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "model", "main.js")).toString();
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "model", "style.css")).toString();
    webview.html = template
      .replaceAll("{{nonce}}", nonce)
      .replaceAll("{{cspSource}}", webview.cspSource)
      .replaceAll("{{mainJs}}", mainJs)
      .replaceAll("{{style}}", style);
  }

  private async sendData(): Promise<void> {
    if (this.disposed) return; // 面板已销毁：不做任何状态构建
    try {
      const data = await panelData(this.deps.projectRoot());
      this.post({ type: "data", payload: data });
    } catch (error) {
      this.post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  private post(message: ModelSenderMessage): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage(message).then(undefined, () => { /* 面板销毁后 postMessage 拒绝：静默 */ });
  }
}

function safeParse(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
