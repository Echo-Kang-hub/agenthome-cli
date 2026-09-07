import * as vscode from "vscode";
import { defaultSpec, listKnown } from "../services/catalog.ts";
import { catalogToViewModels } from "./view-models.ts";

export class CatalogViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly projectRoot: () => string | null) {}

  refresh(): void { this.emitter.fire(undefined); }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }

  async getChildren(): Promise<vscode.TreeItem[]> {
    const root = this.projectRoot();
    if (root === null) return [new vscode.TreeItem("打开项目文件夹", vscode.TreeItemCollapsibleState.None)];
    const [spec, known] = await Promise.all([defaultSpec(), listKnown()]);
    return catalogToViewModels(spec, known).map((m) => {
      const item = new vscode.TreeItem(m.label, vscode.TreeItemCollapsibleState.None);
      item.description = m.description; // 名称
      item.tooltip = m.label; // spec
      item.contextValue = m.kind === "current" ? "catalog-current" : "catalog-entry";
      item.iconPath = new vscode.ThemeIcon(m.kind === "current" ? "milestone" : "repo");
      return item;
    });
  }
}
