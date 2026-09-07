import * as vscode from "vscode";

export async function withProgress<T>(title: string, fn: (report: (msg: string) => void) => Promise<T>): Promise<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, (progress) =>
    fn((message) => progress.report({ message })),
  );
}
