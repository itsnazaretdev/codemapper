import Parser from "tree-sitter";
import Java from "tree-sitter-java";
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
    record_declaration: "class",
    interface_declaration: "interface",
    annotation_type_declaration: "interface",
    enum_declaration: "enum",
};

let parser: Parser | undefined;

function getParser(): Parser {
    if (!parser) {
        parser = new Parser();
        parser.setLanguage(Java);
    }
    return parser;
}

export const javaAnalyzer: LanguageAnalyzer = {
    supports(file: CodeFile): boolean {
        // package-info / module-info only hold metadata, no types.
        return (
            file.path.endsWith(".java") &&
            !/(^|\/)(package|module)-info\.java$/.test(file.path)
        );
    },

    analyze(file: CodeFile, sourceCode: string): FileAnalysis {
        const tree = getParser().parse(sourceCode);
        return new FileVisitor(file.path).visitProgram(tree.rootNode);
    },

    // Java imports name packages and classes, not files: they are resolved
    // through `FileAnalysis.namespace` instead.
    resolveImport(): string[] {
        return [];
    },
};

class FileVisitor {
    private readonly symbols: CodeSymbol[] = [];
    private readonly imports: ImportRef[] = [];
    private readonly references: SymbolReference[] = [];
    private namespace = "";

    constructor(private readonly file: string) {}

    visitProgram(root: SyntaxNode): FileAnalysis {
        for (const node of root.namedChildren) {
            if (node.type === "package_declaration") {
                this.namespace = node.namedChildren.find(isName)?.text ?? "";
            } else if (node.type === "import_declaration") {
                this.visitImport(node);
            } else if (TYPE_DECLARATIONS[node.type]) {
                this.visitType(node, undefined);
            }
        }

        return {
            file: this.file,
            namespace: this.namespace,
            symbols: this.symbols,
            imports: this.imports,
            references: this.references,
        };
    }

    private visitImport(node: SyntaxNode): void {
        // `import static a.B.c;` imports members, not types.
        if (hasChild(node, "static")) {
            return;
        }

        const name = node.namedChildren.find(isName)?.text;
        if (!name) {
            return;
        }

        if (hasChild(node, "asterisk")) {
            this.imports.push({
                source: name,
                names: [{ imported: "*", local: "*" }],
                byNamespace: true,
            });
            return;
        }

        const dot = name.lastIndexOf(".");
        const type = name.slice(dot + 1);
        this.imports.push({
            source: dot === -1 ? "" : name.slice(0, dot),
            names: [{ imported: type, local: type }],
            byNamespace: true,
        });
    }

    private visitType(node: SyntaxNode, outer: CodeSymbol | undefined): void {
        const name = node.childForFieldName("name")?.text;
        if (!name) {
            return;
        }

        const modifiers = modifiersOf(node);
        const symbol: CodeSymbol = {
            id: `${this.file}#${outer ? `${outer.id.split("#")[1]}.` : ""}${name}`,
            name,
            kind: TYPE_DECLARATIONS[node.type],
            file: this.file,
            line: node.startPosition.row + 1,
            exported: modifiers.has("public"),
            isAbstract: modifiers.has("abstract"),
            members: [],
        };
        this.symbols.push(symbol);

        const superclass = node.childForFieldName("superclass");
        for (const type of superclass?.namedChildren ?? []) {
            this.addReference(symbol, typeName(type), "inherits");
        }

        const interfaces =
            node.childForFieldName("interfaces") ??
            node.namedChildren.find((child) => child.type === "extends_interfaces");
        const typeList = interfaces?.namedChildren.find(
            (child) => child.type === "type_list",
        );
        for (const type of typeList?.namedChildren ?? []) {
            this.addReference(
                symbol,
                typeName(type),
                // `interface A extends B`: inheritance between interfaces.
                symbol.kind === "interface" ? "inherits" : "implements",
            );
        }

        // Record components are its properties: `record Point(int x, int y)`.
        if (node.type === "record_declaration") {
            for (const param of node.childForFieldName("parameters")?.namedChildren ?? []) {
                const paramName = param.childForFieldName("name")?.text;
                if (paramName) {
                    symbol.members?.push({
                        name: paramName,
                        kind: "property",
                        visibility: "private",
                        isStatic: false,
                        type: param.childForFieldName("type")?.text,
                    });
                }
            }
            this.addUsedTypes(symbol, node.childForFieldName("parameters"));
        }

        const body = node.childForFieldName("body");
        if (!body) {
            return;
        }

        const defaultVisibility: Visibility =
            symbol.kind === "interface" ? "public" : "package";

        for (const member of body.namedChildren) {
            if (member.type === "enum_body_declarations") {
                for (const inner of member.namedChildren) {
                    this.visitMember(inner, symbol, defaultVisibility);
                }
            } else if (member.type === "enum_constant") {
                const constant = member.childForFieldName("name")?.text;
                if (constant) {
                    symbol.members?.push({
                        name: constant,
                        kind: "property",
                        visibility: "public",
                        isStatic: true,
                    });
                }
            } else {
                this.visitMember(member, symbol, defaultVisibility);
            }
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
        const isStatic = modifiers.has("static");

        switch (member.type) {
            case "field_declaration":
            case "constant_declaration": {
                const type = member.childForFieldName("type")?.text;
                for (const declarator of member.childrenForFieldName("declarator")) {
                    const name = declarator.childForFieldName("name")?.text;
                    if (name) {
                        members.push({
                            name,
                            kind: "property",
                            visibility,
                            isStatic: isStatic || member.type === "constant_declaration",
                            type,
                        });
                    }
                }
                this.addUsedTypes(symbol, member);
                return;
            }

            case "method_declaration": {
                const name = member.childForFieldName("name")?.text;
                if (name) {
                    members.push({
                        name,
                        kind: "method",
                        visibility,
                        isStatic,
                        type: member.childForFieldName("type")?.text,
                    });
                }
                this.addUsedTypes(symbol, member);
                return;
            }

            case "constructor_declaration":
            case "compact_constructor_declaration":
            case "static_initializer":
            case "block":
                this.addUsedTypes(symbol, member);
                return;
        }
    }

    /** Types mentioned in signatures, fields and `new X()` expressions. */
    private addUsedTypes(symbol: CodeSymbol, root: SyntaxNode | null): void {
        if (!root) {
            return;
        }

        const cursor = root.walk();
        let done = false;

        // Iterative walk: deep ASTs must not blow the stack.
        while (!done) {
            const node = cursor.currentNode;
            let descend = true;

            if (node.type === "type_identifier") {
                this.addReference(symbol, node.text, "uses");
            } else if (node.type === "scoped_type_identifier") {
                this.addReference(symbol, node.text, "uses");
                descend = false;
            } else if (TYPE_DECLARATIONS[node.type] && node.id !== root.id) {
                // Local / anonymous classes are analyzed on their own.
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

function isName(node: SyntaxNode): boolean {
    return node.type === "identifier" || node.type === "scoped_identifier";
}

/** `Foo`, `Foo<T>` and `a.b.Foo` -> "Foo" / "a.b.Foo". */
function typeName(node: SyntaxNode): string {
    if (node.type === "generic_type") {
        const inner = node.namedChildren.find(
            (child) =>
                child.type === "type_identifier" ||
                child.type === "scoped_type_identifier",
        );
        return inner?.text ?? "";
    }
    return node.text;
}

function modifiersOf(node: SyntaxNode): Set<string> {
    const modifiers = node.namedChildren.find(
        (child) => child.type === "modifiers",
    );
    return new Set(
        (modifiers?.children ?? [])
            .filter((child) => !child.isNamed)
            .map((child) => child.type),
    );
}

function visibilityOf(
    modifiers: Set<string>,
    fallback: Visibility,
): Visibility {
    if (modifiers.has("public")) {
        return "public";
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
