import { buildGraph } from "./graph";
import { CodeGraph, FileAnalysis } from "./types";
import { getAnalyzer } from "../languages";

export interface SourceFile {
    path: string;
    content: string;
}

/**
 * Pure analysis step (no VS Code API): source files in, graph out.
 * Kept separate so it can be tested and reused outside the editor.
 */
export function analyzeSources(sources: SourceFile[]): {
    graph: CodeGraph;
    failedFiles: string[];
} {
    const analyses: FileAnalysis[] = [];
    const failedFiles: string[] = [];

    for (const source of sources) {
        const analyzer = getAnalyzer(source.path);
        if (!analyzer) {
            continue;
        }

        try {
            analyses.push(analyzer.analyze({ path: source.path }, source.content));
        } catch (error) {
            console.error(`CodeMapper: failed to analyze ${source.path}`, error);
            failedFiles.push(source.path);
        }
    }

    const graph = buildGraph(analyses, (fromFile, specifier) =>
        getAnalyzer(fromFile)?.resolveImport(fromFile, specifier) ?? [],
    );

    return { graph, failedFiles };
}
