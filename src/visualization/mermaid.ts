import { CodeGraph } from "../analyzer/types";

export function graphToMermaid(graph: CodeGraph): string {
    let result = "graph TD\n";

    for (const relation of graph.relations) {
        result += `    ${relation.from} --> ${relation.to}\n`;
    }

    return result;
}