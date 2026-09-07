import { rememberProjectRoot, rememberedProjectRoot } from "../project.ts";
import type { MutationQueue } from "./mutation-queue.ts";

// busy 守卫提示（spec §6 进行中时相关命令禁用）；消息经 notify 注入使守卫可脱离 vscode 单测
export const BUSY_WARNING = "Avenic：操作进行中，请稍候。";
export const NO_CANDIDATES_WARNING = "Avenic：没有可操作的选项。";

// 命令体最前的守卫：mutation 进行中提示并返回 false（调用方直接 return 不入队）；
// MutationQueue 本身仍是守卫之后的安全网（串行化顺序执行）。
export function assertIdle(queue: MutationQueue, notify: (message: string) => void = () => {}): boolean {
  if (!queue.busy) return true;
  notify(BUSY_WARNING);
  return false;
}

export async function pickOne<T extends { label: string }>(
  options: T[],
  quickPick: (items: T[]) => Promise<T | undefined>,
): Promise<T | undefined> {
  if (options.length === 0) return undefined;
  return quickPick(options);
}

export async function pickManyOrNotify<T extends { label: string }>(
  options: T[],
  multi: (items: T[]) => Promise<T[] | undefined>,
  notify: () => void,
): Promise<T[]> {
  if (options.length === 0) { notify(); return []; } // 零候选：警告并返回，绝不弹空 picker 逼 Esc
  return (await multi(options)) ?? [];
}

export async function pickProjectRoot(
  folders: Array<{ uri: { fsPath: string } }>,
  state: { get(key: string): unknown; update(key: string, value: unknown): Thenable<unknown> },
  pick: (candidates: Array<{ label: string; fsPath: string }>) => Promise<{ label: string; fsPath: string } | undefined>,
): Promise<string | null> {
  if (folders.length === 0) return null;
  if (folders.length === 1) return folders[0].uri.fsPath;
  const last = rememberedProjectRoot(folders, state); // 记忆命中且仍在工作区 → 直接使用（校验逻辑与 project.ts 单一来源）
  if (last !== null) return last;
  const chosen = await pick(folders.map((f) => ({ label: f.uri.fsPath, fsPath: f.uri.fsPath })));
  if (chosen === undefined) return null;
  rememberProjectRoot(state, chosen.fsPath);
  return chosen.fsPath;
}
