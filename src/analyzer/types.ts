export type SymbolKind =
    | "class"
    | "interface"
    | "function"
    | "method"
    | "variable"
    | "module"
    | "unknown";

export type RelationType =
    | "imports"
    | "inherits"
    | "implements"
    | "calls"
    | "contains"
    | "depends-on";

export interface CodeSymbol {
    id: string;
    name: string;
    kind: SymbolKind;
    file: string;
}

export interface CodeRelation {
    from: string;
    to: string;
    type: RelationType;
}

export interface CodeGraph {
    symbols: CodeSymbol[];
    relations: CodeRelation[];
}

export interface CodeFile {
    path: string;
    language?: string;
}