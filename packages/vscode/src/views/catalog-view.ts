import * as vscode from "vscode";
import { defaultSpec, listKnown, packStructure, packsFor } from "../services/catalog.ts";
import { catalogPackSkillsToViewModels, catalogPacksToViewModels, catalogSourceGroupsToViewModels, catalogToViewModels, type CatalogChildItem, type CatalogSourceGroupModel } from "./view-models.ts";

interface PackTreeItem extends vscode.TreeItem {
  packId?: string;
  skillNames?: string[]; // 扁平回退：packStructure 不可用时的 Skill 列表
  packSpec?: string;
  sourceGroups?: CatalogSourceGroupModel[]; // 层次：pack.sources 顺序的 source 分组
}
interface SourceTreeItem extends vscode.TreeItem {
  sourceSkills?: string[];
  sourcePackId?: string;
}
interface CatalogTreeItem extends vscode.TreeItem {
  catalogSpec?: string;
}

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
      if (models.length === 0) return [new vscode.TreeItem("添加或同步 Hub", vscode.TreeItemCollapsibleState.None)];
      return models.map((m) => {
        const item = new vscode.TreeItem(m.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = m.description; // 名称
        item.contextValue = m.kind === "current" ? "catalog-current" : "catalog-entry";
        item.iconPath = new vscode.ThemeIcon(m.kind === "current" ? "milestone" : "repo");
        (item as CatalogTreeItem).catalogSpec = m.label; // 展开时按此 spec 取 Pack
        return item;
      });
    }
    // 判定顺序关键：pack 行同时挂 packId/packSpec，条目行只挂 catalogSpec——先判 packId
    // 再判 catalogSpec（旧版两属性都叫 catalogSpec 导致 pack 行误重列出 packs，子树无限嵌套）
    const packItem = element as PackTreeItem;
    const packId = packItem.packId;
    if (packId !== undefined) {
      const children = this.packSkillChildren(packItem, packId);
      this.scopeChildren.set(element, children);
      return children;
    }
    // source 行（Pack → source 分组）只挂 sourceSkills/sourcePackId，不携 packId
    const sourceItem = element as SourceTreeItem;
    if (sourceItem.sourceSkills !== undefined) {
      const children = sourceItem.sourceSkills.map((name) =>
        this.row({ kind: "skill", label: name, description: `Pack ${sourceItem.sourcePackId}`, iconHint: "file", id: name }));
      this.scopeChildren.set(element, children);
      return children;
    }
    const spec = (element as CatalogTreeItem).catalogSpec;
    if (spec !== undefined) {
      const children = await this.packChildren(spec);
      this.scopeChildren.set(element, children);
      return children;
    }
    return this.scopeChildren.get(element) ?? [];
  }

  // Catalog 行 → Pack 行（cache-first 只读预览；无缓存先尝试 fetch，仍失败给提示行）。
  // 每个 Pack 行同时在 packStructure 成功时挂上 sourceGroups（层次优先）；失败（离线无缓存
  // 等）回退 skillNames 扁平列表。packStructure 只读缓存，异常轻，不阻塞行渲染。
  private async packChildren(spec: string): Promise<vscode.TreeItem[]> {
    const packs = await packsFor(spec);
    if (packs === null) {
      return [this.row({ kind: "hint", label: "Hub 未缓存", description: "同步后可查看 Packs", iconHint: "info" })];
    }
    return Promise.all(catalogPacksToViewModels([...packs.values()]).map(async (model) => {
      const item = this.row(model);
      const stamped = item as PackTreeItem;
      // pack 行挂 packId（展开判名字段）+ packSpec（安装命令校验用），绝不复用条目行的 catalogSpec
      stamped.packId = model.id!;
      stamped.skillNames = [...new Set(packs.get(model.id!)!.sources.flatMap((s) => s.skills))];
      stamped.packSpec = spec; // 安装命令校验：仅默认 Catalog 的 Pack 可直接安装
      const structure = await packStructure(spec, model.id!);
      if (structure !== null) {
        stamped.sourceGroups = catalogSourceGroupsToViewModels(structure);
      }
      return item;
    }));
  }

  // Pack 行子级：有 sourceGroups → 分组行；否则回退扁平 Skill 行（未缓存的降级）
  private packSkillChildren(item: PackTreeItem, packId: string): vscode.TreeItem[] {
    if (item.sourceGroups !== undefined) {
      return item.sourceGroups.map((group) => {
        const row = this.row({ kind: "source", label: group.label, description: group.description, iconHint: "repo" });
        const stamped = row as SourceTreeItem;
        stamped.sourceSkills = group.skills;
        stamped.sourcePackId = packId;
        return row;
      });
    }
    const names = item.skillNames ?? [];
    return names.map((name) => this.row({ kind: "skill", label: name, description: `Pack ${packId}`, iconHint: "file", id: name }));
  }

  private row(model: CatalogChildItem): vscode.TreeItem {
    const item = new vscode.TreeItem(model.label, model.kind === "pack" || model.kind === "source" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.description = model.description;
    // 不用 item.id：同一 Pack id 可出现在多个 Catalog 条目下（树需全局唯一），packId 走自定义挂载属性
    item.contextValue = model.kind === "pack" ? "catalog-pack" : model.kind === "source" ? "catalog-source" : model.kind === "hint" ? "catalog-hint" : "catalog-skill";
    item.iconPath = new vscode.ThemeIcon(model.iconHint);
    return item;
  }
}
