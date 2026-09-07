import * as vscode from "vscode";

export async function showError(err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await vscode.window.showErrorMessage(message);
}
