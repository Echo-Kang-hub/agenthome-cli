import * as vscode from "vscode";
import type { Scope } from "../services/skills.ts";

// 决议 2：全局作用域 → cwd undefined（绝不把项目根传给全局操作）；
// 项目作用域 → resolveRoot 项目根。返回 null 表示未选项目（已提示），调用方直接 return。
export async function scopeCwd(scope: Scope, resolveRoot: () => Promise<string | null>): Promise<string | undefined | null> {
  if (scope === "global") return undefined;
  const root = await resolveRoot();
  if (root === null) { await vscode.window.showWarningMessage("未选择项目文件夹"); return null; }
  return root;
}

// 决议 4：无参 pickScope（brief 原带参/无参混调为类型错误，统一为无参）；
// Esc/关闭 → undefined → null → 静默无操作
export async function pickScope(): Promise<Scope | null> {
  const picked = await vscode.window.showQuickPick([
    { label: "项目作用域", description: "当前项目根" },
    { label: "全局作用域", description: "用户配置目录" },
  ]);
  return picked?.label === "全局作用域" ? "global" : picked !== undefined ? "project" : null;
}
