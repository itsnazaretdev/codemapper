import * as vscode from "vscode";
import { scanWorkspace } from "./scanner";
import { analyzeSources } from "./core";
import { CodeGraph } from "./types";

const MAX_FILE_BYTES = 1_000_000;

export interface WorkspaceAnalysis {
    folder: vscode.WorkspaceFolder;
    graph: CodeGraph;
    fileCount: number;
    failedFiles: string[];
    truncated: boolean;
}

export async function analyzeWorkspace(
    folder: vscode.WorkspaceFolder,
    token?: vscode.CancellationToken,
): Promise<WorkspaceAnalysis> {
    const { files, truncated } = await scanWorkspace(folder);
    const decoder = new TextDecoder();

    const sources: { path: string; content: string }[] = [];
    const failedFiles: string[] = [];

    for (const file of files) {
        if (token?.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        try {
            const bytes = await vscode.workspace.fs.readFile(
                vscode.Uri.joinPath(folder.uri, file.path),
            );
            // Files this big are generated (bundles, data), not hand-written.
            if (bytes.byteLength > MAX_FILE_BYTES) {
                failedFiles.push(file.path);
                continue;
            }
            sources.push({ path: file.path, content: decoder.decode(bytes) });
        } catch {
            failedFiles.push(file.path);
        }
    }

    const result = analyzeSources(sources);

    return {
        folder,
        graph: result.graph,
        fileCount: files.length,
        failedFiles: [...failedFiles, ...result.failedFiles].sort(),
        truncated,
    };
}
