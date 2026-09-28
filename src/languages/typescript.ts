import * as path from "path";
import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
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

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

const JS_TO_TS: Record<string, string[]> = {
    ".js": [".ts", ".tsx"],
    ".jsx": [".tsx"],
    ".mjs": [".mts"],
    ".cjs": [".cts"],
};

let tsParser: Parser | undefined;
let tsxParser: Parser | undefined;

function getParser(filePath: string): Parser {
    if (filePath.endsWith(".tsx")) {
        if (!tsxParser) {
            tsxParser = new Parser();
            tsxParser.setLanguage(TypeScript.tsx);
        }
        return tsxParser;
    }

    if (!tsParser) {
        tsParser = new Parser();
        tsParser.setLanguage(TypeScript.typescript);
    }
    return tsParser;
}

export function parseTypeScript(
    sourceCode: string,
    filePath = "file.ts",
): Parser.Tree {
    return getParser(filePath).parse(sourceCode);
}

export const typescriptAnalyzer: LanguageAnalyzer = {
    supports(file: CodeFile): boolean {
        return (
            EXTENSIONS.some((ext) => file.path.endsWith(ext)) &&
            !file.path.endsWith(".d.ts")
        );
    },

    analyze(file: CodeFile, sourceCode: string): FileAnalysis {
        const tree = parseTypeScript(sourceCode, file.path);
        return new FileVisitor(file.path).visitProgram(tree.rootNode);
    },

    resolveImport(fromFile: string, specifier: string): string[] {
        if (!specifier.startsWith(".")) {
            return [];
        }

        const base = path.posix.normalize(
            path.posix.join(path.posix.dirname(fromFile), specifier),
        );
        const ext = path.posix.extname(base);

        if (EXTENSIONS.includes(ext)) {
            return [base];
        }

        if (JS_TO_TS[ext]) {
            const stem = base.slice(0, -ext.length);
            return JS_TO_TS[ext].map((tsExt) => stem + tsExt);
        }

        return [
            ...EXTENSIONS.map((e) => base + e),
            ...EXTENSIONS.map((e) => `${base}/index${e}`),
        ];
    },
};

class FileVisitor {
    private readonly symbols: CodeSymbol[] = [];
    private readonly imports: ImportRef[] = [];
    private readonly references: SymbolReference[] = [];
    private defaultExport: string | undefined;

    constructor(private readonly file: string) {}

    visitProgram(root: SyntaxNode): FileAnalysis {
        for (const statement of root.namedChildren) {
            this.visitStatement(statement, false);
        }

        const defaultSymbol = this.symbols.find(
            (symbol) => symbol.name === this.defaultExport,
        );
        if (defaultSymbol) {
            defaultSymbol.isDefault = true;
        }

        return {
            file: this.file,
            symbols: this.symbols,
            imports: this.imports,
            references: this.references,
        };
    }

    private visitStatement(node: SyntaxNode, exported: boolean): void {
        switch (node.type) {
            case "import_statement":
                this.visitImport(node);
                return;

            case "export_statement": {
                const isDefault = hasChild(node, "default");
                const declaration = node.childForFieldName("declaration");
                if (declaration) {
                    const before = this.symbols.length;
                    this.visitStatement(declaration, true);
                    if (isDefault && this.symbols.length > before) {
                        this.symbols[before].isDefault = true;
                    }
                }

                const source = node.childForFieldName("source");
                if (source) {
                    this.visitReexport(node, source);
                }

                for (const child of node.namedChildren) {
                    if (child === declaration) {
                        continue;
                    }
                    if (child.type === "class") {
                        // `export default class {}`
                        this.visitClass(child, "default", true);
                        this.symbols[this.symbols.length - 1].isDefault = true;
                    } else if (isDefault && child.type === "identifier") {
                        // `export default Foo;`
                        this.defaultExport = child.text;
                    }
                }
                return;
            }

            case "class_declaration":
            case "abstract_class_declaration": {
                const name = node.childForFieldName("name")?.text;
                if (name) {
                    this.visitClass(node, name, exported);
                }
                return;
            }

            case "interface_declaration":
                this.visitInterface(node, exported);
                return;

            case "function_declaration":
            case "generator_function_declaration": {
                const name = node.childForFieldName("name")?.text;
                if (name) {
                    this.addSymbol(node, name, "function", exported);
                }
                return;
            }

            case "enum_declaration": {
                const name = node.childForFieldName("name")?.text;
                if (name) {
                    this.addSymbol(node, name, "enum", exported);
                }
                return;
            }

            case "lexical_declaration":
            case "variable_declaration":
                this.visitVariables(node, exported);
                return;
        }
    }

    private visitImport(node: SyntaxNode): void {
        const source = node.childForFieldName("source");
        if (!source) {
            return;
        }

        const names: ImportRef["names"] = [];
        const clause = node.namedChildren.find(
            (child) => child.type === "import_clause",
        );

        for (const part of clause?.namedChildren ?? []) {
            if (part.type === "identifier") {
                names.push({ imported: "default", local: part.text });
            } else if (part.type === "namespace_import") {
                const local = part.namedChildren[0]?.text;
                if (local) {
                    names.push({ imported: "*", local });
                }
            } else if (part.type === "named_imports") {
                for (const spec of part.namedChildren) {
                    const imported = spec.childForFieldName("name")?.text;
                    const alias = spec.childForFieldName("alias")?.text;
                    if (imported) {
                        names.push({ imported, local: alias ?? imported });
                    }
                }
            }
        }

        this.imports.push({ source: stringValue(source), names });
    }

    /** `export * from "./x"` and `export { A, B as C } from "./x"`. */
    private visitReexport(node: SyntaxNode, source: SyntaxNode): void {
        const names: ImportRef["names"] = [];
        const clause = node.namedChildren.find(
            (child) => child.type === "export_clause",
        );

        if (!clause) {
            // `export * as ns from` exposes a namespace, not the names.
            if (!hasChild(node, "namespace_export")) {
                names.push({ imported: "*", local: "*" });
            }
        } else {
            for (const spec of clause.namedChildren) {
                const imported = spec.childForFieldName("name")?.text;
                const alias = spec.childForFieldName("alias")?.text;
                if (imported) {
                    names.push({ imported, local: alias ?? imported });
                }
            }
        }

        this.imports.push({ source: stringValue(source), names, reexport: true });
    }

    private visitVariables(node: SyntaxNode, exported: boolean): void {
        for (const declarator of node.namedChildren) {
            if (declarator.type !== "variable_declarator") {
                continue;
            }

            const name = declarator.childForFieldName("name");
            const value = declarator.childForFieldName("value");
            if (!name || name.type !== "identifier" || !value) {
                continue;
            }

            if (value.type === "class") {
                this.visitClass(value, name.text, exported);
            } else if (
                value.type === "arrow_function" ||
                value.type === "function_expression" ||
                value.type === "function"
            ) {
                this.addSymbol(declarator, name.text, "function", exported);
            }
        }
    }

    private visitClass(
        node: SyntaxNode,
        name: string,
        exported: boolean,
    ): void {
        const symbol = this.addSymbol(node, name, "class", exported);
        symbol.isAbstract = node.type === "abstract_class_declaration";
        symbol.members = [];

        const heritage = node.namedChildren.find(
            (child) => child.type === "class_heritage",
        );

        for (const clause of heritage?.namedChildren ?? []) {
            if (clause.type === "extends_clause") {
                for (const value of clause.childrenForFieldName("value")) {
                    this.addReference(symbol, value.text, "inherits");
                }
            } else if (clause.type === "implements_clause") {
                for (const type of clause.namedChildren) {
                    this.addReference(symbol, typeName(type), "implements");
                }
            }
        }

        const body = node.childForFieldName("body");
        if (!body) {
            return;
        }

        for (const member of body.namedChildren) {
            this.visitClassMember(member, symbol.members);
        }

        const ignored = new Set([name, ...typeParameters(node)]);
        for (const used of collectUsedNames(body)) {
            if (!ignored.has(used)) {
                this.addReference(symbol, used, "uses");
            }
        }
    }

    private visitClassMember(member: SyntaxNode, members: CodeMember[]): void {
        const name = member.childForFieldName("name");

        switch (member.type) {
            case "method_definition":
            case "abstract_method_signature":
            case "method_signature": {
                if (!name) {
                    return;
                }

                if (name.text === "constructor") {
                    // Parameter properties: `constructor(private svc: Service)`
                    const params = member.childForFieldName("parameters");
                    for (const param of params?.namedChildren ?? []) {
                        const pattern = param.childForFieldName("pattern");
                        if (pattern && hasChild(param, "accessibility_modifier")) {
                            members.push({
                                name: pattern.text,
                                kind: "property",
                                visibility: visibilityOf(param, pattern),
                                isStatic: false,
                                type: annotation(param, "type"),
                            });
                        }
                    }
                    return;
                }

                members.push({
                    name: name.text,
                    kind: "method",
                    visibility: visibilityOf(member, name),
                    isStatic: hasChild(member, "static"),
                    type: annotation(member, "return_type"),
                });
                return;
            }

            case "public_field_definition":
                if (name) {
                    members.push({
                        name: name.text,
                        kind: "property",
                        visibility: visibilityOf(member, name),
                        isStatic: hasChild(member, "static"),
                        type: annotation(member, "type"),
                    });
                }
                return;
        }
    }

    private visitInterface(node: SyntaxNode, exported: boolean): void {
        const name = node.childForFieldName("name")?.text;
        if (!name) {
            return;
        }

        const symbol = this.addSymbol(node, name, "interface", exported);
        symbol.members = [];

        const heritage = node.namedChildren.find(
            (child) => child.type === "extends_type_clause",
        );
        for (const type of heritage?.childrenForFieldName("type") ?? []) {
            this.addReference(symbol, typeName(type), "inherits");
        }

        const body = node.childForFieldName("body");
        if (!body) {
            return;
        }

        for (const member of body.namedChildren) {
            const memberName = member.childForFieldName("name")?.text;
            if (!memberName) {
                continue;
            }

            if (member.type === "method_signature") {
                symbol.members.push({
                    name: memberName,
                    kind: "method",
                    visibility: "public",
                    isStatic: false,
                    type: annotation(member, "return_type"),
                });
            } else if (member.type === "property_signature") {
                symbol.members.push({
                    name: memberName,
                    kind: "property",
                    visibility: "public",
                    isStatic: false,
                    type: annotation(member, "type"),
                });
            }
        }

        const ignored = new Set([name, ...typeParameters(node)]);
        for (const used of collectUsedNames(body)) {
            if (!ignored.has(used)) {
                this.addReference(symbol, used, "uses");
            }
        }
    }

    private addSymbol(
        node: SyntaxNode,
        name: string,
        kind: CodeSymbol["kind"],
        exported: boolean,
    ): CodeSymbol {
        const symbol: CodeSymbol = {
            id: `${this.file}#${name}`,
            name,
            kind,
            file: this.file,
            line: node.startPosition.row + 1,
            exported,
        };
        this.symbols.push(symbol);
        return symbol;
    }

    private addReference(
        from: CodeSymbol,
        name: string,
        type: SymbolReference["type"],
    ): void {
        if (name) {
            this.references.push({ from: from.id, name, type });
        }
    }
}

function stringValue(node: SyntaxNode): string {
    return node.text.slice(1, -1);
}

/** `Foo`, `Foo<T>` and `ns.Foo` -> "Foo" / "ns.Foo". */
function typeName(node: SyntaxNode): string {
    if (node.type === "generic_type") {
        const name = node.childForFieldName("name");
        return name ? typeName(name) : "";
    }
    return node.text;
}

function typeParameters(node: SyntaxNode): string[] {
    const params = node.childForFieldName("type_parameters");
    return (params?.namedChildren ?? [])
        .map((param) => param.childForFieldName("name")?.text ?? "")
        .filter(Boolean);
}

/** Type names and `new X()` constructors referenced inside a body. */
function collectUsedNames(root: SyntaxNode): Set<string> {
    const names = new Set<string>();
    const cursor = root.walk();

    // Iterative walk: deep ASTs must not blow the stack.
    let done = false;
    while (!done) {
        const node = cursor.currentNode;
        let descend = true;

        if (node.type === "type_identifier") {
            names.add(node.text);
        } else if (node.type === "nested_type_identifier") {
            names.add(node.text);
            descend = false;
        } else if (node.type === "new_expression") {
            const ctor = node.childForFieldName("constructor");
            if (ctor?.type === "identifier" || ctor?.type === "member_expression") {
                names.add(ctor.text);
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

    return names;
}

/** Text of a `: Type` annotation field, without the colon. */
function annotation(node: SyntaxNode, field: string): string | undefined {
    const text = node
        .childForFieldName(field)
        ?.text.replace(/^:\s*/, "")
        .replace(/\s+/g, " ");
    return text || undefined;
}

function hasChild(node: SyntaxNode, type: string): boolean {
    return node.children.some((child) => child.type === type);
}

function visibilityOf(node: SyntaxNode, name: SyntaxNode): Visibility {
    if (name.type === "private_property_identifier") {
        return "private";
    }

    const modifier = node.children.find(
        (child) => child.type === "accessibility_modifier",
    )?.text;

    return modifier === "private" || modifier === "protected"
        ? modifier
        : "public";
}
