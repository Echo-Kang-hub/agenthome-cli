import * as vscode from "vscode";
import { detected, status } from "../services/skills.ts";
import { GLOBAL_EMPTY_HINT, PROJECT_EMPTY_HINT, skillsToViewModels, type SkillsViewGroup, type SkillsViewItem } from "./view-models.ts";

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
    // 全局作用域组与项目根无关（零工作区窗口仍有全局 Skills）；项目组无根时不读项目状态（避免落到 process.cwd 域），直接显示提示行
    // 未托管检测（detected）同样只读磁盘：项目组无根时跳过扫描，全局组恒扫描
    const [project, global, projectDetected, globalDetected] = await Promise.all([
      root === null ? null : status("project", root),
      status("global"),
      root === null ? [] : detected("project", root),
      detected("global"),
    ]);
    const projectNode = new vscode.TreeItem("项目作用域", vscode.TreeItemCollapsibleState.Expanded);
    const globalNode = new vscode.TreeItem("全局作用域", vscode.TreeItemCollapsibleState.Expanded);
    this.scopeChildren.set(projectNode, this.fromViewModels(skillsToViewModels(project, projectDetected, PROJECT_EMPTY_HINT), "project"));
    this.scopeChildren.set(globalNode, this.fromViewModels(skillsToViewModels(global, globalDetected, GLOBAL_EMPTY_HINT), "global"));
    return [projectNode, globalNode];
  }

  private fromViewModels(groups: SkillsViewGroup[], scope: "project" | "global"): vscode.TreeItem[] {
    return groups.map((group) => {
      const item = new vscode.TreeItem(
        group.item.label,
        group.children !== undefined ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
      );
      item.description = group.item.description;
      item.contextValue = group.item.kind; // T9 命令菜单 when 绑定按 group/pack/skill/direct 分类
      item.iconPath = new vscode.ThemeIcon(group.item.iconHint);
      this.attachScope(item, scope); // 检测行携带所属作用域：菜单键直传 scoop，免再问
      if (group.children !== undefined) {
        this.scopeChildren.set(item, group.children.map((child) => this.leaf(child, scope)));
      }
      return item;
    });
  }

  private leaf(model: SkillsViewItem, scope: "project" | "global"): vscode.TreeItem {
    const item = new vscode.TreeItem(model.label, vscode.TreeItemCollapsibleState.None);
    item.description = model.description;
    item.contextValue = model.kind;
    item.iconPath = new vscode.ThemeIcon(model.iconHint);
    this.attachScope(item, scope);
    return item;
  }

  // TreeItem.scope 是 VS Code 保留 API 属性（TreeItemScope），选 avanicScope 自定义名承载
  private attachScope(item: vscode.TreeItem, scope: "project" | "global"): void {
    if (item.contextValue === "detected") {
      (item as vscode.TreeItem & { avenicScope?: string }).avenicScope = scope;
    }
  }
}
