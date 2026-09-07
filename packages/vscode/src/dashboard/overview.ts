import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import { isWebviewMessage, type SenderMessage } from "./protocol.ts";
import { buildDashboardData } from "./state.ts";

// Dashboard webview 薄壳：模板注入（CSP nonce + webview Uri）、消息守卫、command 白名单转发。
// 数据单向：任何变更后由 extension.ts 的 refresh() 重新拉取真实状态（设计 §3）。
export class OverviewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "avenic.overview";
  private view: vscode.WebviewView | undefined;

  constructor(private readonly projectRoot: () => string | null, private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const { webview } = webviewView;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    void this.setHtml(webview).catch(() => {
      // 模板缺失等致命错误：降级为无脚本静态提示（同样无远程内容）
      try {
        webview.html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8" /><meta http-equiv="Content-Security-Policy" content="default-src 'none'" /></head><body><p>Dashboard 初始化失败：视图资源缺失。</p></body></html>`;
      } catch { /* 视图已销毁 */ }
    });
    webview.onDidReceiveMessage((msg: unknown) => {
      if (!isWebviewMessage(msg)) return;
      // ready：webview 脚本就绪后请求立即数据；refresh：webview 内按钮触发重载
      if (msg.type === "ready" || msg.type === "refresh") void this.sendData();
      if (msg.type === "command") void vscode.commands.executeCommand(`avenic.${msg.command}`);
    });
    webviewView.onDidDispose(() => { if (this.view === webviewView) this.view = undefined; });
    // resolve 时立即发送一次：加载完成的 ready 消息可能晚于首次渲染到达，届时再补发
    void this.sendData();
  }

  refresh(): void { void this.sendData(); }

  private async setHtml(webview: vscode.Webview): Promise<void> {
    const htmlPath = vscode.Uri.joinPath(this.extensionUri, "media", "dashboard", "view.html");
    const template = await readFile(htmlPath.fsPath, "utf8");
    const nonce = randomUUID();
    const mainJs = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "dashboard", "main.js")).toString();
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "dashboard", "style.css")).toString();
    webview.html = template
      .replaceAll("{{nonce}}", nonce)
      .replaceAll("{{cspSource}}", webview.cspSource)
      .replaceAll("{{mainJs}}", mainJs)
      .replaceAll("{{style}}", style);
  }

  private async sendData(): Promise<void> {
    if (this.view === undefined) return; // 视图未打开：不做任何状态构建，避免每个 mutation 触发 spawnSync 探测
    try {
      const data = await buildDashboardData(this.projectRoot());
      this.post({ type: "data", payload: data });
    } catch (error) {
      this.post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  private post(message: SenderMessage): void {
    const view = this.view;
    if (view === undefined) return;
    void view.webview.postMessage(message).then(undefined, () => { /* 视图销毁后 postMessage 拒绝：静默 */ });
  }
}
