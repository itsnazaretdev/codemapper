import * as vscode from "vscode";
import { CodeFile } from "./types";

export async function scanWorkspace(): Promise<CodeFile[]> {
    const excludePattern =
        "**/{node_modules,.git,dist,out,build,.vscode}/**";

    const files = await vscode.workspace.findFiles(
        "**/*",
        excludePattern,
    );

    return files
        .map((file) => ({
            path: vscode.workspace.asRelativePath(file),
        }))
        .sort((a, b) => a.path.localeCompare(b.path));
}