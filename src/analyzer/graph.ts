import {
    CodeGraph,
    CodeRelation,
    CodeSymbol,
} from "./types";

export function buildGraph(
    symbols: CodeSymbol[],
    relations: CodeRelation[],
): CodeGraph {
    return {
        symbols: [...symbols],
        relations: [...relations],
    };
}