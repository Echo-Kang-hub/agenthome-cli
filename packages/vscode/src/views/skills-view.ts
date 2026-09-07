import * as vscode from "vscode";
import { status } from "../services/skills.ts";
import { skillsToViewModels, type SkillsViewItem } from "./view-models.ts";

export class SkillsViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  // 分组节点 → 子节点；每次根级 getChildren 重建，map 同时清空，无跨 refresh 缓存
  private readonly scopeChildren = new Map<vscode.TreeItem, vscode.TreeItem[]>();
  constructor(private readonly projectRoot: () => string | null) {}

  refresh(): void { this.emitter.fire(undefined); }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element !== undefined) return this.scopeChildren.get(element) ?? [];
    this.scopeChildren.clear();
    const root = this.projectRoot();
    if (root === null) return [new vscode.TreeItem("打开项目文件夹", vscode.TreeItemCollapsibleState.None)];
    const [project, global] = await Promise.all([status("project", root), status("global")]);
    const projectNode = new vscode.TreeItem("项目作用域", vscode.TreeItemCollapsibleState.Expanded);
    const globalNode = new vscode.TreeItem("全局作用域", vscode.TreeItemCollapsibleState.Expanded);
    this.scopeChildren.set(projectNode, this.fromViewModels(skillsToViewModels(project)));
    this.scopeChildren.set(globalNode, this.fromViewModels(skillsToViewModels(global)));
    return [projectNode, globalNode];
  }

  private fromViewModels(items: SkillsViewItem[]): vscode.TreeItem[] {
    return items.map((m) => {
      const item = new vscode.TreeItem(m.label, vscode.TreeItemCollapsibleState.None);
      item.description = m.description;
      item.contextValue = m.kind; // T9 命令菜单 when 绑定按 group/pack/skill/direct 分类
      item.iconPath = new vscode.ThemeIcon(m.iconHint);
      return item;
    });
  }
}
