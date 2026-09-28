import * as vscode from "vscode";
import { CodeFile } from "./types";
import { getAnalyzer } from "../languages";

const INCLUDE_PATTERN = "**/*.{ts,tsx,mts,cts,java}";

const EXCLUDE_PATTERN =
    "**/{node_modules,.git,.vscode-test,dist,out,build,coverage,target,.gradle}/**";

export const MAX_FILES = 5000;

export interface ScanResult {
    folder: vscode.WorkspaceFolder;
    files: CodeFile[];
    truncated: boolean;
}

export async function scanWorkspace(
    folder: vscode.WorkspaceFolder,
): Promise<ScanResult> {
    const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, INCLUDE_PATTERN),
        new vscode.RelativePattern(folder, EXCLUDE_PATTERN),
        MAX_FILES + 1,
    );

    // findFiles returns files in no guaranteed order, and a limit applied to
    // an unordered list picks a different subset each run: sort first.
    const files = uris
        .map((uri) => ({
            path: vscode.workspace.asRelativePath(uri, false),
        }))
        .filter((file) => getAnalyzer(file.path) !== undefined)
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    return {
        folder,
        files: files.slice(0, MAX_FILES),
        truncated: files.length > MAX_FILES,
    };
}
