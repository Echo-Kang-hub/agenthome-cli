import * as vscode from "vscode";
import { agentStatus, listAgents } from "../services/agents.ts";
import { agentsToViewModels } from "./view-models.ts";

export class AgentsViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly projectRoot: () => string | null) {}

  refresh(): void { this.emitter.fire(undefined); }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }

  async getChildren(): Promise<vscode.TreeItem[]> {
    const root = this.projectRoot();
    if (root === null) return [new vscode.TreeItem("打开一个项目文件夹", vscode.TreeItemCollapsibleState.None)];
    const statuses = await Promise.all(listAgents().map((a) => agentStatus(root, a.id)));
    return agentsToViewModels(statuses).map((m) => {
      const item = new vscode.TreeItem(m.label, vscode.TreeItemCollapsibleState.None);
      item.id = m.id; // T7 上下文菜单命令经 treeItem.id 取 agent
      item.description = m.description;
      item.tooltip = m.tooltip;
      item.contextValue = "agent";
      item.iconPath = new vscode.ThemeIcon(m.iconHint);
      return item;
    });
  }
}
