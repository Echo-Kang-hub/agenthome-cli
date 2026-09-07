import * as vscode from "vscode";
import * as agents from "../services/agents.ts";
import { MutationQueue, runMutation } from "../ui/mutation-queue.ts";
import { assertIdle, pickOne } from "../ui/flows.ts";
import { showError } from "./errors.ts";
import { withProgress } from "./progress.ts";

export interface AgentDeps {
  // 同步根解析：单根直接返回，多根/未选时经 T6 pickProjectRoot 引导用户选择（决议 1）
  resolveRoot: () => Promise<string | null>;
  queue: MutationQueue;
  refresh: () => void;
}

export function registerAgentsCommands(context: vscode.ExtensionContext, deps: AgentDeps): void {
  // 决议 1：交互（resolveRoot / 选择）在队列外，仅 mutation 服务调用进 queue.run；
  // 决议 2：busy 守卫在命令体最前（spec §6 进行中时相关命令禁用），提示并返回不入队；
  // runMutation 保证成功/失败都 refresh（T8 Minor A）。
  const register = (id: string, fn: (treeItem?: vscode.TreeItem) => Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, async (treeItem?: vscode.TreeItem) => {
      try {
        // try/catch 覆盖整个命令体：resolveRoot / QuickPick 的拒绝同样经 showError 呈现
        await fn(treeItem);
      } catch (err) { await showError(err); }
    }));

  const busy = () => !assertIdle(deps.queue, (message) => void vscode.window.showWarningMessage(message));

  // 树节点触发时 args[0] 是 T5 的 TreeItem（item.id 已设为 agent id）；命令面板触发时走 QuickPick
  const agentTarget = async (treeItem?: vscode.TreeItem): Promise<{ root: string; id: string } | null> => {
    const root = await deps.resolveRoot();
    if (root === null) { await vscode.window.showWarningMessage("未选择项目文件夹"); return null; }
    const id = treeItem?.id ?? (await vscode.window.showQuickPick(agents.listAgents().map((a) => ({ label: a.displayName, id: a.id }))))?.id;
    return id === undefined ? null : { root, id };
  };

  register("avenic.agents.init", async (treeItem) => {
    if (busy()) return;
    const target = await agentTarget(treeItem);
    if (target === null) return;
    // 交互（auth/sessions 选择）在队列外完成；仅 initialize 突变进队列（W2a）
    const auth = await pickOne([{ label: "global" }, { label: "project" }], async (items) => vscode.window.showQuickPick(items));
    if (auth === undefined) return;
    const sessions = await pickOne([{ label: "global" }, { label: "project" }], async (items) => vscode.window.showQuickPick(items));
    if (sessions === undefined) return;
    await runMutation(deps.queue, () => withProgress("Avenic Agent 操作", (report) => agents.initialize(target.root, target.id, auth.label as "global" | "project", sessions.label as "global" | "project").then(() => { report("完成"); })), () => deps.refresh());
  });

  register("avenic.agents.deinit", async (treeItem) => {
    if (busy()) return;
    const target = await agentTarget(treeItem);
    if (target === null) return;
    await runMutation(deps.queue, () => withProgress("Avenic Agent 操作", (report) => agents.deinitialize(target.root, target.id).then(() => { report("完成"); })), () => deps.refresh());
  });

  register("avenic.agents.switchAuth", async (treeItem) => {
    if (busy()) return;
    const target = await agentTarget(treeItem);
    if (target === null) return;
    const status = await agents.agentStatus(target.root, target.id);
    const currentLabel = status.effective?.auth ?? "未配置";
    const chosen = await vscode.window.showQuickPick([{ label: currentLabel, description: "当前" }, { label: "global" }, { label: "project" }, { label: "reset" }]);
    if (chosen === undefined || chosen.label === currentLabel) return;
    await runMutation(deps.queue, () => withProgress("Avenic Agent 操作", (report) => agents.setAuthMode(target.root, target.id, chosen.label as "global" | "project" | "reset").then(() => { report("完成"); })), () => deps.refresh());
  });

  register("avenic.agents.switchSessions", async (treeItem) => {
    if (busy()) return;
    const target = await agentTarget(treeItem);
    if (target === null) return;
    const status = await agents.agentStatus(target.root, target.id);
    const currentLabel = status.effective?.sessions ?? "未配置";
    const chosen = await pickOne([{ label: currentLabel, description: "当前" }, { label: "global" }, { label: "project" }], async (items) => vscode.window.showQuickPick(items));
    if (chosen === undefined || chosen.label === currentLabel) return;
    await runMutation(deps.queue, () => withProgress("Avenic Agent 操作", (report) => agents.setSessionsMode(target.root, target.id, chosen.label as "global" | "project").then(() => { report("完成"); })), () => deps.refresh());
  });

  register("avenic.agents.sessionsImport", async (treeItem) => {
    if (busy()) return;
    const target = await agentTarget(treeItem);
    if (target === null) return;
    const result = await runMutation(deps.queue, () => withProgress("Avenic Agent 操作", (report) => agents.importSessions(target.root, target.id).then((r) => { report("完成"); return r; })), () => deps.refresh());
    await vscode.window.showInformationMessage(`已导入 ${result.count} 个会话`);
  });

  register("avenic.agents.sessionsWriteback", async (treeItem) => {
    if (busy()) return;
    const target = await agentTarget(treeItem);
    if (target === null) return;
    const result = await runMutation(deps.queue, () => withProgress("Avenic Agent 操作", (report) => agents.writebackSessions(target.root, target.id).then((r) => { report("完成"); return r; })), () => deps.refresh());
    await vscode.window.showInformationMessage(`已写回 ${result.count} 个会话`);
  });
}
