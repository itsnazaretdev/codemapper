import Parser from "tree-sitter";
import PHP from "tree-sitter-php";
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
    trait_declaration: "class",
    interface_declaration: "interface",
    enum_declaration: "enum",
};

/** Keywords that look like type names but refer to the class itself. */
const SELF_NAMES = new Set(["self", "static", "parent"]);

let parser: Parser | undefined;

function getParser(): Parser {
    if (!parser) {
        parser = new Parser();
        // `php` (not `php_only`): files may mix HTML and PHP.
        parser.setLanguage(PHP.php);
    }
    return parser;
}

export const phpAnalyzer: LanguageAnalyzer = {
    supports(file: CodeFile): boolean {
        // Compiled Blade views are not source code.
        return file.path.endsWith(".php") && !file.path.endsWith(".blade.php");
    },

    analyze(file: CodeFile, sourceCode: string): FileAnalysis {
        const tree = getParser().parse(sourceCode);
        return new FileVisitor(file.path).visitProgram(tree.rootNode);
    },

    // `use` names namespaces, not files: resolved through the namespace.
    resolveImport(): string[] {
        return [];
    },
};

/** `\App\Models\User` -> "App.Models.User" (the graph splits on dots). */
function normalize(name: string): string {
    return name.replace(/^\\/, "").replace(/\\/g, ".");
}

class FileVisitor {
    private readonly symbols: CodeSymbol[] = [];
    private readonly imports: ImportRef[] = [];
    private readonly references: SymbolReference[] = [];
    private namespace = "";

    constructor(private readonly file: string) {}

    visitProgram(root: SyntaxNode): FileAnalysis {
        this.visitStatements(root.namedChildren);

        return {
            file: this.file,
            namespace: this.namespace,
            symbols: this.symbols,
            imports: this.imports,
            references: this.references,
        };
    }

    private visitStatements(nodes: SyntaxNode[]): void {
        for (const node of nodes) {
            if (node.type === "namespace_definition") {
                // A file with several namespaces is rare: the first one wins.
                const name = node.childForFieldName("name")?.text;
                if (name && !this.namespace) {
                    this.namespace = normalize(name);
                }
                const body = node.childForFieldName("body");
                if (body) {
                    this.visitStatements(body.namedChildren);
                }
            } else if (node.type === "namespace_use_declaration") {
                this.visitUse(node);
            } else if (TYPE_DECLARATIONS[node.type]) {
                this.visitType(node);
            } else if (node.type === "function_definition") {
                const name = node.childForFieldName("name")?.text;
                if (name) {
                    this.symbols.push({
                        id: `${this.file}#${name}`,
                        name,
                        kind: "function",
                        file: this.file,
                        line: node.startPosition.row + 1,
                        exported: true,
                    });
                }
            }
        }
    }

    /**
     * `use App\Models\User;` / `use App\Models\{Role, Team as T};` /
     * `use App\Repo as R;`. `use function` and `use const` import no types.
     */
    private visitUse(node: SyntaxNode): void {
        if (hasChild(node, "function") || hasChild(node, "const")) {
            return;
        }

        const group = node.childForFieldName("body");
        const prefix = group
            ? normalize(node.namedChildren.find((c) => c.type === "namespace_name")?.text ?? "")
            : "";

        const clauses = (group ?? node).namedChildren.filter(
            (child) => child.type === "namespace_use_clause",
        );

        for (const clause of clauses) {
            if (hasChild(clause, "function") || hasChild(clause, "const")) {
                continue;
            }

            const alias = clause.childForFieldName("alias")?.text;
            const target = clause.namedChildren.find(
                (child) =>
                    child !== clause.childForFieldName("alias") &&
                    (child.type === "qualified_name" || child.type === "name"),
            );
            if (!target) {
                continue;
            }

            const full = [prefix, normalize(target.text)].filter(Boolean).join(".");
            const dot = full.lastIndexOf(".");
            const imported = full.slice(dot + 1);
            this.imports.push({
                source: dot === -1 ? "" : full.slice(0, dot),
                names: [{ imported, local: alias ?? imported }],
                byNamespace: true,
            });
        }
    }

    private visitType(node: SyntaxNode): void {
        const name = node.childForFieldName("name")?.text;
        if (!name) {
            return;
        }

        const symbol: CodeSymbol = {
            id: `${this.file}#${name}`,
            name,
            kind: TYPE_DECLARATIONS[node.type],
            file: this.file,
            line: node.startPosition.row + 1,
            exported: true,
            isAbstract: hasChild(node, "abstract_modifier"),
            stereotype: node.type === "trait_declaration" ? "trait" : undefined,
            members: [],
        };
        this.symbols.push(symbol);

        for (const child of node.namedChildren) {
            if (child.type === "base_clause") {
                for (const base of child.namedChildren) {
                    this.addReference(symbol, normalize(base.text), "inherits");
                }
            } else if (child.type === "class_interface_clause") {
                for (const iface of child.namedChildren) {
                    this.addReference(symbol, normalize(iface.text), "implements");
                }
            }
        }

        const body = node.childForFieldName("body");
        for (const member of body?.namedChildren ?? []) {
            this.visitMember(member, symbol);
        }
        this.addUsedTypes(symbol, body);
    }

    private visitMember(member: SyntaxNode, symbol: CodeSymbol): void {
        const members = symbol.members as CodeMember[];
        const visibility = visibilityOf(member);
        const isStatic = hasChild(member, "static_modifier");

        switch (member.type) {
            // `use SomeTrait;` inside a class.
            case "use_declaration":
                for (const trait of member.namedChildren) {
                    if (trait.type === "name" || trait.type === "qualified_name") {
                        this.addReference(symbol, normalize(trait.text), "uses");
                    }
                }
                return;

            case "enum_case": {
                const name = member.childForFieldName("name")?.text;
                if (name) {
                    members.push({ name, kind: "property", visibility: "public", isStatic: true });
                }
                return;
            }

            case "const_declaration":
                for (const element of member.namedChildren) {
                    const name = element.type === "const_element"
                        ? element.namedChildren.find((c) => c.type === "name")?.text
                        : undefined;
                    if (name) {
                        members.push({ name, kind: "property", visibility, isStatic: true });
                    }
                }
                return;

            case "property_declaration": {
                const type = member.childForFieldName("type")?.text;
                for (const element of member.namedChildren) {
                    const name = element.type === "property_element"
                        ? element.childForFieldName("name")?.text.replace(/^\$/, "")
                        : undefined;
                    if (name) {
                        members.push({ name, kind: "property", visibility, isStatic, type });
                    }
                }
                return;
            }

            case "method_declaration": {
                const name = member.childForFieldName("name")?.text;
                if (!name) {
                    return;
                }

                if (name === "__construct") {
                    // Promoted properties: `__construct(private Repo $repo)`.
                    const params = member.childForFieldName("parameters");
                    for (const param of params?.namedChildren ?? []) {
                        if (param.type !== "property_promotion_parameter") {
                            continue;
                        }
                        const paramName = param.childForFieldName("name")?.text.replace(/^\$/, "");
                        if (paramName) {
                            members.push({
                                name: paramName,
                                kind: "property",
                                visibility: visibilityOf(param),
                                isStatic: false,
                                type: param.childForFieldName("type")?.text,
                            });
                        }
                    }
                    return;
                }

                if (name.startsWith("__")) {
                    return; // Magic methods (__toString, __get...) are noise.
                }

                members.push({
                    name,
                    kind: "method",
                    visibility,
                    isStatic,
                    type: member.childForFieldName("return_type")?.text,
                });
                return;
            }
        }
    }

    /** Type hints, `new X()` and static calls `X::method()`. */
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

            if (node.type === "named_type") {
                this.addReference(symbol, normalize(node.text), "uses");
                descend = false;
            } else if (node.type === "object_creation_expression") {
                const created = node.namedChildren.find(
                    (c) => c.type === "name" || c.type === "qualified_name",
                );
                if (created) {
                    this.addReference(symbol, normalize(created.text), "uses");
                }
            } else if (
                node.type === "scoped_call_expression" ||
                node.type === "class_constant_access_expression"
            ) {
                const scope = node.childForFieldName("scope") ?? node.namedChildren[0];
                if (scope?.type === "name" || scope?.type === "qualified_name") {
                    this.addReference(symbol, normalize(scope.text), "uses");
                }
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
        if (name && name !== from.name && !SELF_NAMES.has(name)) {
            this.references.push({ from: from.id, name, type });
        }
    }
}

function visibilityOf(node: SyntaxNode): Visibility {
    const modifier = node.namedChildren.find(
        (child) => child.type === "visibility_modifier",
    )?.text;
    return modifier === "private" || modifier === "protected" ? modifier : "public";
}

function hasChild(node: SyntaxNode, type: string): boolean {
    return node.children.some((child) => child.type === type);
}
