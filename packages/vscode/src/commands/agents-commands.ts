import * as vscode from "vscode";
import * as agents from "../services/agents.ts";
import { MutationQueue } from "../ui/mutation-queue.ts";
import { pickOne } from "../ui/flows.ts";
import { showError } from "./errors.ts";
import { withProgress } from "./progress.ts";

export interface AgentDeps {
  // 同步根解析：单根直接返回，多根/未选时经 T6 pickProjectRoot 引导用户选择（决议 1）
  resolveRoot: () => Promise<string | null>;
  queue: MutationQueue;
  refresh: () => void;
}

export function registerAgentsCommands(context: vscode.ExtensionContext, deps: AgentDeps): void {
  const register = (id: string, fn: (root: string, agentId: string) => Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, async (treeItem?: vscode.TreeItem) => {
      const root = await deps.resolveRoot();
      if (root === null) { await vscode.window.showWarningMessage("请先打开一个项目文件夹"); return; }
      // 树节点触发时 args[0] 是 T5 的 TreeItem（item.id 已设为 agent id）；命令面板触发时走 QuickPick
      const chosen = treeItem?.id ?? (await vscode.window.showQuickPick(agents.listAgents().map((a) => ({ label: a.displayName, id: a.id }))))?.id;
      if (chosen === undefined) return;
      try {
        await deps.queue.run(async () => {
          await withProgress("Avenic Agent 操作", (report) => fn(root, chosen).then(() => { report("完成"); }));
          deps.refresh();
        });
      } catch (err) { await showError(err); }
    }));

  register("avenic.agents.init", async (root, id) => {
    const auth = await pickOne([{ label: "global" }, { label: "project" }], async (items) => vscode.window.showQuickPick(items));
    if (auth === undefined) return;
    const sessions = await pickOne([{ label: "global" }, { label: "project" }], async (items) => vscode.window.showQuickPick(items));
    if (sessions === undefined) return;
    await agents.initialize(root, id, auth.label as "global" | "project", sessions.label as "global" | "project");
  });
  register("avenic.agents.deinit", async (root, id) => { await agents.deinitialize(root, id); });
  register("avenic.agents.switchAuth", async (root, id) => {
    const status = await agents.agentStatus(root, id);
    const currentLabel = status.effective?.auth ?? "未配置";
    const chosen = await vscode.window.showQuickPick([{ label: currentLabel, description: "当前" }, { label: "global" }, { label: "project" }, { label: "reset" }]);
    if (chosen === undefined || chosen.label === currentLabel) return;
    await agents.setAuthMode(root, id, chosen.label as "global" | "project" | "reset");
  });
  register("avenic.agents.switchSessions", async (root, id) => {
    const status = await agents.agentStatus(root, id);
    const currentLabel = status.effective?.sessions ?? "未配置";
    const chosen = await pickOne([{ label: currentLabel, description: "当前" }, { label: "global" }, { label: "project" }], async (items) => vscode.window.showQuickPick(items));
    if (chosen === undefined || chosen.label === currentLabel) return;
    await agents.setSessionsMode(root, id, chosen.label as "global" | "project");
  });
  register("avenic.agents.sessionsImport", async (root, id) => {
    const result = await agents.importSessions(root, id);
    vscode.window.showInformationMessage(`已导入 ${(result as { count: number }).count} 个会话`);
  });
  register("avenic.agents.sessionsWriteback", async (root, id) => {
    const result = await agents.writebackSessions(root, id);
    vscode.window.showInformationMessage(`已写回 ${(result as { count: number }).count} 个会话`);
  });
}
