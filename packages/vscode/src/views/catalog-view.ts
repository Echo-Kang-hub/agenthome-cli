import * as vscode from "vscode";
import { defaultSpec, listKnown, packsFor } from "../services/catalog.ts";
import { catalogPackSkillsToViewModels, catalogPacksToViewModels, catalogToViewModels, type CatalogChildItem } from "./view-models.ts";

export class CatalogViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  // 展开行 → 子行；每次根级 getChildren 重建并清空，无跨 refresh 缓存
  private readonly scopeChildren = new Map<vscode.TreeItem, vscode.TreeItem[]>();

  refresh(): void { this.emitter.fire(undefined); }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }

  // Catalog 是 core 全局 / state-dir 域：读取与项目根无关，零工作区窗口同样可用；
  // 只有注册列表与默认 spec 均为空（数据真正为空）时才显示提示行，由数据本身决定。
  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element === undefined) {
      this.scopeChildren.clear();
      const [spec, known] = await Promise.all([defaultSpec(), listKnown()]);
      const models = catalogToViewModels(spec, known);
      if (models.length === 0) return [new vscode.TreeItem("添加或同步 Catalog", vscode.TreeItemCollapsibleState.None)];
      return models.map((m) => {
        const item = new vscode.TreeItem(m.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = m.description; // 名称
        item.contextValue = m.kind === "current" ? "catalog-current" : "catalog-entry";
        item.iconPath = new vscode.ThemeIcon(m.kind === "current" ? "milestone" : "repo");
        (item as vscode.TreeItem & { catalogSpec?: string }).catalogSpec = m.label; // 展开时按此 spec 取 Pack
        return item;
      });
    }
    // 判定顺序关键：pack 行同时挂 packId/packSpec，条目行只挂 catalogSpec——先判 packId
    // 再判 catalogSpec（旧版两属性都叫 catalogSpec 导致 pack 行误重列出 packs，子树无限嵌套）
    const packId = (element as vscode.TreeItem & { packId?: string }).packId;
    if (packId !== undefined) {
      const children = this.skillChildren(element, packId);
      this.scopeChildren.set(element, children);
      return children;
    }
    const spec = (element as vscode.TreeItem & { catalogSpec?: string }).catalogSpec;
    if (spec !== undefined) {
      const children = await this.packChildren(spec);
      this.scopeChildren.set(element, children);
      return children;
    }
    return this.scopeChildren.get(element) ?? [];
  }

  // Catalog 行 → Pack 行（cache-first 只读预览；无缓存先尝试 fetch，仍失败给提示行）
  private async packChildren(spec: string): Promise<vscode.TreeItem[]> {
    const packs = await packsFor(spec);
    if (packs === null) {
      return [this.row({ kind: "hint", label: "Catalog 未缓存", description: "同步后可查看 Packs", iconHint: "info" })];
    }
    return catalogPacksToViewModels([...packs.values()]).map((model) => {
      const item = this.row(model);
      // pack 行挂 packId（展开判名字段）+ packSpec（安装命令校验用），绝不复用条目行的 catalogSpec
      const stamped = item as vscode.TreeItem & { packId?: string; skillNames?: string[]; packSpec?: string };
      stamped.packId = model.id!;
      stamped.skillNames = [...new Set(packs.get(model.id!)!.sources.flatMap((s) => s.skills))];
      stamped.packSpec = spec; // 安装命令校验：仅默认 Catalog 的 Pack 可直接安装
      return item;
    });
  }

  // Pack 行 → Skill 行（skillNames 由 packChildren 挂载在行对象上）
  private skillChildren(element: vscode.TreeItem, packId: string): vscode.TreeItem[] {
    const names = (element as vscode.TreeItem & { skillNames?: string[] }).skillNames ?? [];
    return names.map((name) => this.row({ kind: "skill", label: name, description: `Pack ${packId}`, iconHint: "file", id: name }));
  }

  private row(model: CatalogChildItem): vscode.TreeItem {
    const item = new vscode.TreeItem(model.label, model.kind === "pack" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.description = model.description;
    // 不用 item.id：同一 Pack id 可出现在多个 Catalog 条目下（树需全局唯一），packId 走自定义挂载属性
    item.contextValue = model.kind === "pack" ? "catalog-pack" : model.kind === "hint" ? "catalog-hint" : "catalog-skill";
    item.iconPath = new vscode.ThemeIcon(model.iconHint);
    return item;
  }
}
