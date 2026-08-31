import * as vscode from "vscode";
import { scanWorkspace } from "./scanner";
import { buildGraph } from "./graph";
import { CodeSymbol, CodeRelation } from "./types";
import { parseTypeScript } from "../languages/typescript";

export async function analyzeWorkspace() {
    const files = await scanWorkspace();

    const symbols: CodeSymbol[] = [];
    const relations: CodeRelation[] = [];

    console.log("CodeMapper - files found:");

    for (const file of files) {
        const uri = vscode.Uri.joinPath(
            vscode.workspace.workspaceFolders![0].uri,
            file.path,
        );

        const document =
            await vscode.workspace.openTextDocument(uri);

        console.log(`CodeMapper: analyzing ${file.path}`);

        const tree = parseTypeScript(document.getText());

        console.log(tree.rootNode.toString());
    }

    return buildGraph(symbols, relations);
}