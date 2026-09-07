import * as vscode from "vscode";
import { resolveProjectRoot } from "./project.ts";
import { AgentsViewProvider } from "./views/agents-view.ts";
import { CatalogViewProvider } from "./views/catalog-view.ts";
import { SkillsViewProvider } from "./views/skills-view.ts";

export function activate(context: vscode.ExtensionContext): void {
  const folders = vscode.workspace.workspaceFolders;
  const root = () => resolveProjectRoot(folders ?? []);
  const agents = new AgentsViewProvider(root);
  const catalog = new CatalogViewProvider(root);
  const skills = new SkillsViewProvider(root);
  context.subscriptions.push(
    vscode.window.createTreeView("avenic.agents", { treeDataProvider: agents }),
    vscode.window.createTreeView("avenic.catalog", { treeDataProvider: catalog }),
    vscode.window.createTreeView("avenic.skills", { treeDataProvider: skills }),
  );
}

export function deactivate(): void {}
