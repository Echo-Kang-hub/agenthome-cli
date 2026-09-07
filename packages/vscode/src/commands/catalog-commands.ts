import * as vscode from "vscode";
import * as catalog from "../services/catalog.ts";
import { MutationQueue } from "../ui/mutation-queue.ts";
import { pickOne } from "../ui/flows.ts";
import { showError } from "./errors.ts";
import { withProgress } from "./progress.ts";

export interface CatalogDeps {
  // 决议 1：交互（InputBox/QuickPick/消息）在队列外，变更（add/select/sync）在队列内；
  // catalog 操作为 core 全局 / state-dir 域，与项目根无关，故无 resolveRoot/projectRoot。
  queue: MutationQueue;
  refresh: () => void;
}

export function registerCatalogCommands(context: vscode.ExtensionContext, deps: CatalogDeps): void {
  const register = (id: string, fn: () => Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, async () => {
      try {
        // try/catch 覆盖整个命令体：交互与队列内的拒绝同样经 showError 呈现
        await fn();
      } catch (err) { await showError(err); }
    }));

  register("avenic.catalog.add", async () => {
    const spec = await vscode.window.showInputBox({ prompt: "Catalog spec（owner/repo、URL 或本地路径）", value: "Echo-Kang-hub/avenic-catalog#main" });
    if (spec === undefined || spec.trim() === "") return;
    const result = await deps.queue.run(() => withProgress("添加 Catalog", async (report) => { report("保存并预览…"); return catalog.add(spec.trim()); }));
    if (result.previewFailed) await vscode.window.showWarningMessage("已保存，可 sync 重试（Preview 失败不致命）");
    else await vscode.window.showInformationMessage(`Catalog 已添加并预览 ${result.packs.length} 个 Pack`);
    deps.refresh();
  });

  register("avenic.catalog.select", async () => {
    const known = await catalog.listKnown();
    if (known.length === 0) { await vscode.window.showInformationMessage("暂无已注册 Catalog，先执行 Avenic: Catalog 添加"); return; }
    const picked = await pickOne(known.map((k) => ({ label: k.spec, description: k.name })), async (items) => vscode.window.showQuickPick(items));
    if (picked === undefined) return;
    await deps.queue.run(() => catalog.select(picked.label));
    deps.refresh();
  });

  // 只读命令（仅读 defaultSpec + 提示），不排队；「修改」内联触发 select（select 自行排队，无嵌套等待）
  register("avenic.catalog.default", async () => {
    const current = await catalog.defaultSpec();
    const info = await vscode.window.showInformationMessage(`当前默认 Catalog：${current ?? "未设置"}`, "修改");
    if (info === undefined) return;
    await vscode.commands.executeCommand("avenic.catalog.select");
  });

  register("avenic.catalog.sync", async () => {
    const spec = await catalog.defaultSpec();
    if (spec === null) { await vscode.window.showWarningMessage("未选择默认 Catalog"); return; }
    const info = await deps.queue.run(() => withProgress("同步 Catalog", async (report) => { report("拉取并解析…"); return catalog.sync(spec); }));
    await vscode.window.showInformationMessage(`已同步 ${spec} → revision ${info.revision}`);
    deps.refresh();
  });
}
