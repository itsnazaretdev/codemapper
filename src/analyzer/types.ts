export type SymbolKind =
    | "class"
    | "interface"
    | "function"
    | "enum"
    | "module";

export type RelationType =
    | "imports"
    | "inherits"
    | "implements"
    | "uses";

export type Visibility = "public" | "private" | "protected" | "package";

export interface CodeMember {
    name: string;
    kind: "method" | "property";
    visibility: Visibility;
    isStatic: boolean;
    /** Declared type (property) or return type (method), as written. */
    type?: string;
}

export interface CodeSymbol {
    id: string;
    name: string;
    kind: SymbolKind;
    file: string;
    line: number;
    exported: boolean;
    isDefault?: boolean;
    isAbstract?: boolean;
    /** Extra label shown in the class diagram, e.g. "trait". */
    stereotype?: string;
    members?: CodeMember[];
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

/**
 * An import statement as written in the source, before resolving
 * the specifier to a real file of the workspace.
 */
export interface ImportRef {
    source: string;
    /** Imported name -> local name. "default" and "*" are special. */
    names: { imported: string; local: string }[];
    /**
     * `export ... from` statement. `local` is then the exported name;
     * `export * from` is a single `{ imported: "*", local: "*" }`.
     */
    reexport?: boolean;
    /**
     * `source` is a namespace (e.g. Java package `com.app.model`) instead of
     * a file path. `{ imported: "*", local: "*" }` imports the whole package.
     */
    byNamespace?: boolean;
}

/**
 * A reference from a declared symbol to another name
 * (e.g. `class A extends B`), resolved later by the graph builder.
 */
export interface SymbolReference {
    from: string;
    /** Local name as written in the file, e.g. "Base" or "ns.Base". */
    name: string;
    type: Exclude<RelationType, "imports">;
}

export interface FileAnalysis {
    file: string;
    /**
     * Package the file belongs to (Java). Files in the same namespace see
     * each other's symbols without imports.
     */
    namespace?: string;
    /**
     * Imported names are visible to importers of this file too (Python:
     * `from .user import User` in `__init__.py` re-exports User).
     */
    importsAreExports?: boolean;
    symbols: CodeSymbol[];
    imports: ImportRef[];
    references: SymbolReference[];
}
