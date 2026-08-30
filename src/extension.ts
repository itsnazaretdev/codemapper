import * as vscode from "vscode";
import { analyzeWorkspace } from "./analyzer";

export function activate(context: vscode.ExtensionContext) {
  console.log("🚀 CodeMapper extension activated");
    const command = vscode.commands.registerCommand(
        "codemapper-ai.scanWorkspace",
        async () => {
            try {
                await analyzeWorkspace();

                vscode.window.showInformationMessage(
                    "Codebase analyzed successfully!",
                );
            } catch (error) {
                vscode.window.showErrorMessage(
                    `CodeMapper error: ${error}`,
                );
            }
        },
    );

    context.subscriptions.push(command);

    console.log("✅ CodeMapper command registered");
}

export function deactivate() {}