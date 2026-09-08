import * as vscode from "vscode";
import * as skills from "../services/skills.ts";
import type { Scope } from "../services/skills.ts";
import { defaultSpec as catalogDefaultSpec } from "../services/catalog.ts";
import { MutationQueue, runMutation } from "../ui/mutation-queue.ts";
import { assertIdle, NO_CANDIDATES_WARNING, pickManyOrNotify } from "../ui/flows.ts";
import { showError } from "./errors.ts";
import { withProgress } from "./progress.ts";

export interface SkillsDeps {
  // 决议 1：项目作用域操作须经异步 resolveRoot 引导项目根（多根场景经 pickProjectRoot 选定）；
  // 全局作用域不接触项目根——core 全局上下文无视 cwd，root 即用户主目录。
  resolveRoot: () => Promise<string | null>;
  queue: MutationQueue;
  refresh: () => void;
}

// 决议 2：全局作用域 → cwd undefined（绝不把项目根传给全局操作）；
// 项目作用域 → resolveRoot 项目根。返回 null 表示未选项目（已提示），调用方直接 return。
async function scopeCwd(scope: Scope, deps: SkillsDeps): Promise<string | undefined | null> {
  if (scope === "global") return undefined;
  const root = await deps.resolveRoot();
  if (root === null) { await vscode.window.showWarningMessage("未选择项目文件夹"); return null; }
  return root;
}

// 决议 4：无参 pickScope（brief 原带参/无参混调为类型错误，统一为无参）；
// Esc/关闭 → undefined → null → 静默无操作
async function pickScope(): Promise<Scope | null> {
  const picked = await vscode.window.showQuickPick([
    { label: "项目作用域", description: "当前项目根" },
    { label: "全局作用域", description: "用户配置目录" },
  ]);
  return picked?.label === "全局作用域" ? "global" : picked !== undefined ? "project" : null;
}

export function registerSkillsCommands(context: vscode.ExtensionContext, deps: SkillsDeps): void {
  // 决议 3：try/catch 覆盖整个命令体（交互与队列内拒绝同样经 showError）；
  // 交互在队列外，仅 mutation 服务调用进 deps.queue.run——避免嵌套入队死锁；
  // runMutation 保证成功/失败都 refresh；busy 守卫在命令体最前（spec §6）；
  // 零候选经 pickManyOrNotify 警告并返回，绝不弹空 picker（T9 残余）；directList 只读不排队不刷新。
  const register = (id: string, fn: () => Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, async () => {
      try { await fn(); }
      catch (err) { await showError(err); }
    }));

  const busy = () => !assertIdle(deps.queue, (message) => void vscode.window.showWarningMessage(message));
  const warnNoOptions = () => void vscode.window.showWarningMessage(NO_CANDIDATES_WARNING);

  register("avenic.skills.installPacks", async () => {
    if (busy()) return;
    const scope = await pickScope();
    if (scope === null) return;
    const cwd = await scopeCwd(scope, deps);
    if (cwd === null) return;
    if ((await catalogDefaultSpec()) === null) { await vscode.window.showWarningMessage("尚未选择默认 Catalog，请先执行 Avenic: Catalog 添加"); return; }
    const all = await skills.availablePacks(scope, cwd);
    const installed = await skills.installedPackIds(scope, cwd);
    // 只列举未安装的 Pack；描述兜底 id
    const candidates = Array.from(all.values()).filter((p) => !(installed ?? []).includes(p.id)).map((p) => ({ label: p.name, description: p.description ?? p.id, id: p.id }));
    const chosen = await pickManyOrNotify(candidates, async (items) => vscode.window.showQuickPick(items, { canPickMany: true }), warnNoOptions);
    if (chosen.length === 0) return;
    await runMutation(deps.queue, () => withProgress("安装 Packs", async (report) => { report(`安装 ${chosen.length} 个 Pack…`); return skills.installPacks(scope, chosen.map((c) => c.id), cwd); }), () => deps.refresh());
  });

  register("avenic.skills.uninstallPacks", async () => {
    if (busy()) return;
    const scope = await pickScope();
    if (scope === null) return;
    const cwd = await scopeCwd(scope, deps);
    if (cwd === null) return;
    // common 永驻不可卸（core normalizePackIds 注入、uninstallPacks 跳过 common——与 CLI 语义一致，spec §5.3）
    const installed = ((await skills.installedPackIds(scope, cwd)) ?? []).filter((id) => id !== "common");
    const chosen = await pickManyOrNotify(installed.map((id) => ({ label: id })), async (items) => vscode.window.showQuickPick(items, { canPickMany: true }), warnNoOptions);
    if (chosen.length === 0) return;
    await runMutation(deps.queue, () => withProgress("卸载 Packs", async (report) => { report(`卸载 ${chosen.length} 个 Pack…`); return skills.uninstallPacks(scope, chosen.map((c) => c.label), cwd); }), () => deps.refresh());
  });

  register("avenic.skills.addDirect", async () => {
    if (busy()) return;
    const scope = await pickScope();
    if (scope === null) return;
    const cwd = await scopeCwd(scope, deps);
    if (cwd === null) return;
    const repo = await vscode.window.showInputBox({ prompt: "owner/repo 或仓库 URL" });
    if (repo === undefined || repo.trim() === "") return;
    const result = await runMutation(deps.queue, () => withProgress("添加直装 Skills", async (report) => { report("发现 Skills…"); return skills.addDirect(scope, repo.trim(), [], cwd); }), () => deps.refresh());
    await vscode.window.showInformationMessage(`已添加 ${result.names.length} 个 Skills：${result.names.join(", ")}`);
  });

  register("avenic.skills.removeDirect", async () => {
    if (busy()) return;
    const scope = await pickScope();
    if (scope === null) return;
    const cwd = await scopeCwd(scope, deps);
    if (cwd === null) return;
    const state = await skills.directSkills(scope, cwd);
    const direct = state.directSources.flatMap((s) => s.skills);
    const chosen = await pickManyOrNotify(direct.map((n) => ({ label: n })), async (items) => vscode.window.showQuickPick(items, { canPickMany: true }), warnNoOptions);
    if (chosen.length === 0) return;
    await runMutation(deps.queue, () => withProgress("移除直装 Skills", async (report) => { report(`移除 ${chosen.length} 个 Skill…`); return skills.removeDirect(scope, chosen.map((c) => c.label), cwd); }), () => deps.refresh());
  });

  // 只读命令：直接展示直装来源 → Skill 列表（空时提示），不排队、不 refresh
  register("avenic.skills.directList", async () => {
    const scope = await pickScope();
    if (scope === null) return;
    const cwd = await scopeCwd(scope, deps);
    if (cwd === null) return;
    const state = await skills.directSkills(scope, cwd);
    const lines = state.directSources.map((s) => `${s.id} → ${s.skills.join(", ")}`);
    if (lines.length === 0) { await vscode.window.showInformationMessage("暂无直装 Skills"); return; }
    await vscode.window.showInformationMessage(lines.join("\n"));
  });

  // 托管磁盘上未托管的 Skills（旧版/外部工具安装、手工拷贝）：core 补齐缺失 target 并写入
  // lock.adopted。树的"检测到 N 个 Skill（未托管）"行携带具体 scope 参数；命令面板调用回退
  // 为交互选择。零候选 → 警告而非空操作。
  register("avenic.skills.adopt", async (arg?: unknown) => {
    if (busy()) return;
    // 右键行 → arg 为带 avenicScope 的 TreeItem（provider 挂载）；命令面板调用 → 交互选择
    const scope = (arg as { avenicScope?: Scope } | undefined)?.avenicScope ?? (await pickScope());
    if (scope === null) return;
    const cwd = await scopeCwd(scope, deps);
    if (cwd === null) return;
    const names = await skills.detected(scope, cwd);
    if (names.length === 0) { warnNoOptions(); return; }
    const result = await runMutation(deps.queue, () => withProgress("托管磁盘 Skills", async (report) => { report(`托管 ${names.length} 个 Skill…`); return skills.adopt(scope, names, cwd); }), () => deps.refresh());
    await vscode.window.showInformationMessage(`已托管 ${result.adopted.length} 个 Skills（补齐 ${result.placed} 处目标）`);
  });
}
