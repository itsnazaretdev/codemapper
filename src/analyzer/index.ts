import * as vscode from "vscode";
import { scanWorkspace } from "./scanner";
import { buildGraph } from "./graph";
import { CodeSymbol, CodeRelation } from "./types";

export async function analyzeWorkspace() {
    const files = await scanWorkspace();

    const symbols: CodeSymbol[] = [];
    const relations: CodeRelation[] = [];

    console.log("CodeMapper - files found:");

    for (const file of files) {
        console.log(`- ${file.path}`);
    }

    return buildGraph(symbols, relations);
}