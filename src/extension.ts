import * as vscode from "vscode";
import { analyzeWorkspace } from "./analyzer";
import { DiagramPanel } from "./visualization";

export function activate(context: vscode.ExtensionContext) {
    let running: vscode.CancellationTokenSource | undefined;
    let lastFolder: vscode.WorkspaceFolder | undefined;

    const generate = async (folder?: vscode.WorkspaceFolder) => {
        folder ??= await pickFolder();
        if (!folder) {
            return;
        }
        lastFolder = folder;

        // A new run replaces the one in progress.
        running?.cancel();
        const cancellation = new vscode.CancellationTokenSource();
        running = cancellation;

        const panel = DiagramPanel.show(context.extensionUri, () =>
            generate(lastFolder),
        );
        panel.showLoading(`Analizando ${folder.name}…`);

        try {
            const analysis = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Window,
                    title: "CodeMapper: analizando proyecto",
                },
                () => analyzeWorkspace(folder, cancellation.token),
            );

            if (!cancellation.token.isCancellationRequested) {
                panel.showAnalysis(analysis);
            }
        } catch (error) {
            if (error instanceof vscode.CancellationError) {
                return;
            }
            console.error("CodeMapper:", error);
            panel.showError(`Error al analizar el proyecto:\n${error}`);
        } finally {
            cancellation.dispose();
            if (running === cancellation) {
                running = undefined;
            }
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand("codemapper-ai.scanWorkspace", () =>
            generate(),
        ),
    );
}

async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];

    if (folders.length === 0) {
        vscode.window.showErrorMessage(
            "CodeMapper: abre una carpeta o un proyecto primero.",
        );
        return undefined;
    }

    if (folders.length === 1) {
        return folders[0];
    }

    return vscode.window.showWorkspaceFolderPick({
        placeHolder: "¿Qué proyecto quieres analizar?",
    });
}

export function deactivate() {}
