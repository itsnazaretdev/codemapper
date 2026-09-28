import Parser from "tree-sitter";
import CSharp from "tree-sitter-c-sharp";
import { LanguageAnalyzer } from "./languageAnalyzer";
import {
    CodeFile,
    CodeMember,
    CodeSymbol,
    FileAnalysis,
    ImportRef,
    SymbolReference,
    Visibility,
} from "../analyzer/types";

type SyntaxNode = Parser.SyntaxNode;

const TYPE_DECLARATIONS: Record<string, CodeSymbol["kind"]> = {
    class_declaration: "class",
    struct_declaration: "class",
    record_declaration: "class",
    record_struct_declaration: "class",
    interface_declaration: "interface",
    enum_declaration: "enum",
};

/** Fields whose subtree is a type: `int x`, `List<User> Find()`, `new X()`. */
const TYPE_FIELDS = new Set(["type", "returns"]);

let parser: Parser | undefined;

function getParser(): Parser {
    if (!parser) {
        parser = new Parser();
        parser.setLanguage(CSharp);
    }
    return parser;
}

export const csharpAnalyzer: LanguageAnalyzer = {
    supports(file: CodeFile): boolean {
        return file.path.endsWith(".cs");
    },

    analyze(file: CodeFile, sourceCode: string): FileAnalysis {
        const tree = getParser().parse(sourceCode);
        return new FileVisitor(file.path).visitCompilationUnit(tree.rootNode);
    },

    // `using` names namespaces, not files: resolved through the namespace.
    resolveImport(): string[] {
        return [];
    },
};

class FileVisitor {
    private readonly symbols: CodeSymbol[] = [];
    private readonly imports: ImportRef[] = [];
    private readonly references: SymbolReference[] = [];
    private namespace: string | undefined;

    constructor(private readonly file: string) {}

    visitCompilationUnit(root: SyntaxNode): FileAnalysis {
        this.visitDeclarations(root.namedChildren);

        // Code inside `App.Services` sees the types of `App` without `using`.
        const parts = (this.namespace ?? "").split(".").filter(Boolean);
        for (let i = 1; i < parts.length; i++) {
            this.imports.push({
                source: parts.slice(0, i).join("."),
                names: [{ imported: "*", local: "*" }],
                byNamespace: true,
            });
        }

        return {
            file: this.file,
            namespace: this.namespace ?? "",
            symbols: this.symbols,
            imports: this.imports,
            references: this.references,
        };
    }

    private visitDeclarations(nodes: SyntaxNode[]): void {
        for (const node of nodes) {
            if (node.type === "using_directive") {
                this.visitUsing(node);
            } else if (
                node.type === "namespace_declaration" ||
                node.type === "file_scoped_namespace_declaration"
            ) {
                // A file with several namespaces is rare: the first one wins.
                this.namespace ??= node.childForFieldName("name")?.text;
                const body = node.childForFieldName("body");
                if (body) {
                    this.visitDeclarations(body.namedChildren);
                }
            } else if (TYPE_DECLARATIONS[node.type]) {
                this.visitType(node, undefined);
            }
        }
    }

    /** `using App.Models;` / `using M = App.Models.Other;`. */
    private visitUsing(node: SyntaxNode): void {
        if (hasChild(node, "static")) {
            return;
        }

        const alias = node.childForFieldName("name")?.text;
        const target = node.namedChildren.find(
            (child) =>
                child !== node.childForFieldName("name") &&
                (child.type === "identifier" || child.type === "qualified_name"),
        )?.text;
        if (!target) {
            return;
        }

        if (alias) {
            const dot = target.lastIndexOf(".");
            this.imports.push({
                source: dot === -1 ? "" : target.slice(0, dot),
                names: [{ imported: target.slice(dot + 1), local: alias }],
                byNamespace: true,
            });
            return;
        }

        this.imports.push({
            source: target,
            names: [{ imported: "*", local: "*" }],
            byNamespace: true,
        });
    }

    private visitType(node: SyntaxNode, outer: CodeSymbol | undefined): void {
        const name = node.childForFieldName("name")?.text;
        if (!name) {
            return;
        }

        const modifiers = modifiersOf(node);
        const kind = TYPE_DECLARATIONS[node.type];
        const symbol: CodeSymbol = {
            id: `${this.file}#${outer ? `${outer.id.split("#")[1]}.` : ""}${name}`,
            name,
            kind,
            file: this.file,
            line: node.startPosition.row + 1,
            exported: modifiers.has("public"),
            isAbstract: modifiers.has("abstract"),
            members: [],
        };
        this.symbols.push(symbol);

        // `class A : Base, IThing`: which one is the class is decided by the
        // graph once the targets are known.
        const bases = node.namedChildren.find((child) => child.type === "base_list");
        for (const base of bases?.namedChildren ?? []) {
            this.addReference(symbol, typeName(base), "inherits");
        }

        // Positional records: `record Point(int X, int Y)`.
        const parameters = node.namedChildren.find(
            (child) => child.type === "parameter_list",
        );
        for (const param of parameters?.namedChildren ?? []) {
            const paramName = param.childForFieldName("name")?.text;
            if (paramName) {
                symbol.members?.push({
                    name: paramName,
                    kind: "property",
                    visibility: "public",
                    isStatic: false,
                    type: param.childForFieldName("type")?.text,
                });
            }
        }
        this.addUsedTypes(symbol, parameters);

        const body = node.childForFieldName("body");
        const defaultVisibility: Visibility =
            kind === "interface" ? "public" : "private";

        for (const member of body?.namedChildren ?? []) {
            this.visitMember(member, symbol, defaultVisibility);
        }
    }

    private visitMember(
        member: SyntaxNode,
        symbol: CodeSymbol,
        defaultVisibility: Visibility,
    ): void {
        const members = symbol.members as CodeMember[];

        if (TYPE_DECLARATIONS[member.type]) {
            this.visitType(member, symbol);
            return;
        }

        const modifiers = modifiersOf(member);
        const visibility = visibilityOf(modifiers, defaultVisibility);
        const isStatic = modifiers.has("static") || modifiers.has("const");

        switch (member.type) {
            case "enum_member_declaration": {
                const name = member.childForFieldName("name")?.text;
                if (name) {
                    members.push({ name, kind: "property", visibility: "public", isStatic: true });
                }
                return;
            }

            case "field_declaration":
            case "event_field_declaration": {
                const declaration = member.namedChildren.find(
                    (child) => child.type === "variable_declaration",
                );
                const type = declaration?.childForFieldName("type")?.text;
                for (const declarator of declaration?.namedChildren ?? []) {
                    const name = declarator.type === "variable_declarator"
                        ? declarator.childForFieldName("name")?.text
                        : undefined;
                    if (name) {
                        members.push({ name, kind: "property", visibility, isStatic, type });
                    }
                }
                break;
            }

            case "property_declaration": {
                const name = member.childForFieldName("name")?.text;
                if (name) {
                    members.push({
                        name,
                        kind: "property",
                        visibility,
                        isStatic,
                        type: member.childForFieldName("type")?.text,
                    });
                }
                break;
            }

            case "method_declaration": {
                const name = member.childForFieldName("name")?.text;
                if (name) {
                    members.push({
                        name,
                        kind: "method",
                        visibility,
                        isStatic,
                        type: member.childForFieldName("returns")?.text,
                    });
                }
                break;
            }

            case "constructor_declaration":
                break;

            default:
                return;
        }

        this.addUsedTypes(symbol, member);
    }

    /** Names in type positions (fields, signatures, `new X()`). */
    private addUsedTypes(symbol: CodeSymbol, root: SyntaxNode | null | undefined): void {
        if (!root) {
            return;
        }

        const cursor = root.walk();
        let done = false;

        // Iterative walk: deep ASTs must not blow the stack.
        while (!done) {
            const node = cursor.currentNode;
            let descend = true;

            if (TYPE_FIELDS.has(cursor.currentFieldName ?? "")) {
                for (const name of typeNames(node)) {
                    this.addReference(symbol, name, "uses");
                }
                descend = false;
            } else if (TYPE_DECLARATIONS[node.type] && node.id !== root.id) {
                descend = false;
            }

            if (descend && cursor.gotoFirstChild()) {
                continue;
            }

            while (!cursor.gotoNextSibling()) {
                if (!cursor.gotoParent() || cursor.currentNode.id === root.id) {
                    done = true;
                    break;
                }
            }
        }
    }

    private addReference(
        from: CodeSymbol,
        name: string,
        type: SymbolReference["type"],
    ): void {
        if (name && name !== from.name) {
            this.references.push({ from: from.id, name, type });
        }
    }
}

/** `Foo`, `Foo<T>`, `App.Core.Foo`, `Foo?` -> "Foo" / "App.Core.Foo". */
function typeName(node: SyntaxNode): string {
    if (node.type === "generic_name") {
        return node.namedChildren.find((child) => child.type === "identifier")?.text ?? "";
    }
    if (node.type === "qualified_name" || node.type === "identifier") {
        return node.text;
    }
    return "";
}

/** Every named type inside a type expression: `Dictionary<string, List<User>>`. */
function typeNames(node: SyntaxNode): string[] {
    if (node.type === "identifier" || node.type === "qualified_name") {
        return [node.text];
    }

    const names: string[] = [];
    if (node.type === "generic_name") {
        names.push(typeName(node));
    }
    for (const child of node.namedChildren) {
        if (node.type === "generic_name" && child.type === "identifier") {
            continue;
        }
        names.push(...typeNames(child));
    }
    return names;
}

function modifiersOf(node: SyntaxNode): Set<string> {
    return new Set(
        node.namedChildren
            .filter((child) => child.type === "modifier")
            .map((child) => child.text),
    );
}

function visibilityOf(modifiers: Set<string>, fallback: Visibility): Visibility {
    if (modifiers.has("public")) {
        return "public";
    }
    if (modifiers.has("internal")) {
        return "package";
    }
    if (modifiers.has("private")) {
        return "private";
    }
    if (modifiers.has("protected")) {
        return "protected";
    }
    return fallback;
}

function hasChild(node: SyntaxNode, type: string): boolean {
    return node.children.some((child) => child.type === type);
}
