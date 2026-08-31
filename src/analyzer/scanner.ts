import * as vscode from "vscode";
import { CodeFile } from "./types";

export async function scanWorkspace(): Promise<CodeFile[]> {
    const excludePattern =
    "{**/node_modules/**,**/.git/**,**/.vscode-test/**,**/dist/**}";

   const files = await vscode.workspace.findFiles("**/*.ts");

    return files
        .map((file) => ({
            path: vscode.workspace.asRelativePath(file),
        }))
        .sort((a, b) => a.path.localeCompare(b.path));
}