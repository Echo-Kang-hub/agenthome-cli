import * as vscode from "vscode";
import { registerAgentsCommands } from "./commands/agents-commands.ts";
import { registerCatalogCommands } from "./commands/catalog-commands.ts";
import { registerSkillsCommands } from "./commands/skills-commands.ts";
import { rememberedProjectRoot, resolveProjectRoot } from "./project.ts";
import { pickProjectRoot } from "./ui/flows.ts";
import { MutationQueue } from "./ui/mutation-queue.ts";
import { OverviewProvider } from "./dashboard/overview.ts";
import { AgentsViewProvider } from "./views/agents-view.ts";
import { CatalogViewProvider } from "./views/catalog-view.ts";
import { SkillsViewProvider } from "./views/skills-view.ts";

export function activate(context: vscode.ExtensionContext): void {
  // 多根：resolveProjectRoot 返回 null，此时回退到记忆根（经当前文件夹列表校验）；无记忆则 null → 视图提示行
  const root = () => {
    const live = vscode.workspace.workspaceFolders ?? [];
    return resolveProjectRoot(live) ?? rememberedProjectRoot(live, context.workspaceState);
  };
  const agents = new AgentsViewProvider(root);
  const catalog = new CatalogViewProvider();
  const skills = new SkillsViewProvider(root);
  const overview = new OverviewProvider(root, context.extensionUri);
  const queue = new MutationQueue();
  // 数据单向：任何变更后视图/仪表盘重读真实状态（设计 §3），不反向写 core
  const refresh = () => { agents.refresh(); catalog.refresh(); skills.refresh(); overview.refresh(); };
  // 同步根解析：单根直接返回；多根/null 时经 T6 pickProjectRoot 引导用户选定（workspaceFolders 实时读取，避免激活期闭包过期）
  const resolveRoot = async (): Promise<string | null> => {
    const r = root();
    if (r !== null) return r;
    const picked = await pickProjectRoot([...(vscode.workspace.workspaceFolders ?? [])], context.workspaceState, async (candidates) => vscode.window.showQuickPick(candidates));
    if (picked !== null) refresh(); // 选定后让 TreeView 从「打开项目文件夹」提示行刷新为真实数据
    return picked;
  };
  context.subscriptions.push(
    vscode.window.createTreeView("avenic.agents", { treeDataProvider: agents }),
    vscode.window.createTreeView("avenic.catalog", { treeDataProvider: catalog }),
    vscode.window.createTreeView("avenic.skills", { treeDataProvider: skills }),
    vscode.window.registerWebviewViewProvider(OverviewProvider.viewType, overview),
  );
  registerAgentsCommands(context, { queue, resolveRoot, refresh });
  registerCatalogCommands(context, { queue, refresh, resolveRoot });
  registerSkillsCommands(context, { queue, resolveRoot, refresh });
}

export function deactivate(): void {}
