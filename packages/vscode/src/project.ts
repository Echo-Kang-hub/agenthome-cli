export const PROJECT_ROOT_STATE_KEY = "avenic.projectRoot";

export interface WorkspaceFolderLike {
  uri: { fsPath: string };
}

export interface StateLike {
  get(key: string): unknown;
  update(key: string, value: unknown): Thenable<unknown>;
}

export function resolveProjectRoot(folders: readonly WorkspaceFolderLike[]): string | null {
  if (folders.length === 1) return folders[0].uri.fsPath;
  // 0 个或多根：交给调用方（多根走 QuickPick；无根时命令提示打开文件夹）
  return null;
}

export function rememberProjectRoot(state: StateLike, root: string): void {
  void state.update(PROJECT_ROOT_STATE_KEY, root);
}

export function lastProjectRoot(state: StateLike): string | null {
  const value = state.get(PROJECT_ROOT_STATE_KEY);
  return typeof value === "string" && value.length > 0 ? value : null;
}
