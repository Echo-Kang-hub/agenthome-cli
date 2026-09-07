import * as vscode from "vscode";
import { defaultSpec, listKnown } from "../services/catalog.ts";
import { catalogToViewModels } from "./view-models.ts";

export class CatalogViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(): void { this.emitter.fire(undefined); }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }

  // Catalog 是 core 全局 / state-dir 域：读取与项目根无关，零工作区窗口同样可用；
  // 只有注册列表与默认 spec 均为空（数据真正为空）时才显示提示行，由数据本身决定。
  async getChildren(): Promise<vscode.TreeItem[]> {
    const [spec, known] = await Promise.all([defaultSpec(), listKnown()]);
    const models = catalogToViewModels(spec, known);
    if (models.length === 0) return [new vscode.TreeItem("添加或同步 Catalog", vscode.TreeItemCollapsibleState.None)];
    return models.map((m) => {
      const item = new vscode.TreeItem(m.label, vscode.TreeItemCollapsibleState.None);
      item.description = m.description; // 名称
      item.contextValue = m.kind === "current" ? "catalog-current" : "catalog-entry";
      item.iconPath = new vscode.ThemeIcon(m.kind === "current" ? "milestone" : "repo");
      return item;
    });
  }
}
