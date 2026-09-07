import { lastProjectRoot, rememberProjectRoot } from "../project.ts";

export async function pickOne<T extends { label: string }>(
  options: T[],
  quickPick: (items: T[]) => Promise<T | undefined>,
): Promise<T | undefined> {
  if (options.length === 0) return undefined;
  return quickPick(options);
}

export async function pickMany<T extends { label: string }>(options: T[], multi: (items: T[]) => Promise<T[] | undefined>): Promise<T[]> {
  if (options.length === 0) return [];
  return (await multi(options)) ?? [];
}

export async function pickProjectRoot(
  folders: Array<{ uri: { fsPath: string } }>,
  state: { get(key: string): unknown; update(key: string, value: unknown): Thenable<unknown> },
  pick: (candidates: Array<{ label: string; fsPath: string }>) => Promise<{ label: string; fsPath: string } | undefined>,
): Promise<string | null> {
  if (folders.length === 0) return null;
  if (folders.length === 1) return folders[0].uri.fsPath;
  const last = lastProjectRoot(state);
  if (last !== null && folders.some((f) => f.uri.fsPath === last)) return last; // 记忆命中且仍在工作区 → 直接使用
  const chosen = await pick(folders.map((f) => ({ label: f.uri.fsPath, fsPath: f.uri.fsPath })));
  if (chosen === undefined) return null;
  rememberProjectRoot(state, chosen.fsPath);
  return chosen.fsPath;
}
