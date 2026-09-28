import * as path from "path";
import Parser from "tree-sitter";
import Python from "tree-sitter-python";
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

const ENUM_BASES = new Set(["Enum", "IntEnum", "StrEnum", "Flag", "IntFlag"]);
const INTERFACE_BASES = new Set(["Protocol", "ABC"]);

let parser: Parser | undefined;

function getParser(): Parser {
    if (!parser) {
        parser = new Parser();
        parser.setLanguage(Python);
    }
    return parser;
}

export const pythonAnalyzer: LanguageAnalyzer = {
    supports(file: CodeFile): boolean {
        return file.path.endsWith(".py") || file.path.endsWith(".pyi");
    },

    analyze(file: CodeFile, sourceCode: string): FileAnalysis {
        const tree = getParser().parse(sourceCode);
        return new FileVisitor(file.path).visitModule(tree.rootNode);
    },

    /**
     * `.base` / `..pkg.mod` are relative to the file; `app.models.user` is
     * relative to a source root we don't know, so it matches by suffix.
     */
    resolveImport(fromFile: string, specifier: string): string[] {
        const dots = specifier.match(/^\.*/)?.[0].length ?? 0;
        const modulePath = specifier.slice(dots).split(".").filter(Boolean).join("/");

        if (dots === 0) {
            return modulePath
                ? [`*/${modulePath}.py`, `*/${modulePath}.pyi`, `*/${modulePath}/__init__.py`]
                : [];
        }

        let dir = path.posix.dirname(fromFile);
        for (let i = 1; i < dots; i++) {
            dir = path.posix.dirname(dir);
        }
        const base = path.posix.normalize(
            modulePath ? path.posix.join(dir, modulePath) : dir,
        );

        return modulePath
            ? [`${base}.py`, `${base}.pyi`, `${base}/__init__.py`]
            : [`${base}/__init__.py`];
    },
};

class FileVisitor {
    private readonly symbols: CodeSymbol[] = [];
    private readonly imports: ImportRef[] = [];
    private readonly references: SymbolReference[] = [];

    constructor(private readonly file: string) {}

    visitModule(root: SyntaxNode): FileAnalysis {
        for (const statement of root.namedChildren) {
            this.visitStatement(statement);
        }

        return {
            file: this.file,
            symbols: this.symbols,
            imports: this.imports,
            references: this.references,
            importsAreExports: true,
        };
    }

    private visitStatement(node: SyntaxNode): void {
        const definition = unwrapDecorated(node);

        switch (definition.type) {
            case "import_statement":
                this.visitImport(definition);
                return;

            case "import_from_statement":
                this.visitImportFrom(definition);
                return;

            case "class_definition":
                this.visitClass(definition);
                return;

            case "function_definition": {
                const name = definition.childForFieldName("name")?.text;
                if (name) {
                    this.symbols.push({
                        id: `${this.file}#${name}`,
                        name,
                        kind: "function",
                        file: this.file,
                        line: node.startPosition.row + 1,
                        exported: !name.startsWith("_"),
                    });
                }
                return;
            }

            // `if TYPE_CHECKING:` / `try: import x` blocks still import.
            case "if_statement":
            case "try_statement":
                for (const inner of definition.descendantsOfType([
                    "import_statement",
                    "import_from_statement",
                ])) {
                    this.visitStatement(inner);
                }
                return;
        }
    }

    /** `import a.b` / `import a.b as c`: the module becomes a namespace. */
    private visitImport(node: SyntaxNode): void {
        for (const name of node.childrenForFieldName("name")) {
            if (name.type === "aliased_import") {
                const module = name.childForFieldName("name")?.text;
                const alias = name.childForFieldName("alias")?.text;
                if (module && alias) {
                    this.imports.push({
                        source: module,
                        names: [{ imported: "*", local: alias }],
                    });
                }
            } else {
                this.imports.push({
                    source: name.text,
                    names: [{ imported: "*", local: name.text }],
                });
            }
        }
    }

    /** `from x import A, B as C` / `from x import *` / `from . import mod`. */
    private visitImportFrom(node: SyntaxNode): void {
        const moduleName = node.childForFieldName("module_name")?.text;
        if (moduleName === undefined) {
            return;
        }

        if (node.namedChildren.some((child) => child.type === "wildcard_import")) {
            this.imports.push({
                source: moduleName,
                names: [{ imported: "*", local: "*" }],
            });
            return;
        }

        const names: ImportRef["names"] = [];
        for (const name of node.childrenForFieldName("name")) {
            const imported =
                name.type === "aliased_import"
                    ? name.childForFieldName("name")?.text
                    : name.text;
            const local =
                name.type === "aliased_import"
                    ? name.childForFieldName("alias")?.text
                    : name.text;
            if (!imported || !local) {
                continue;
            }

            names.push({ imported, local });

            // The name may also be a submodule: `from app import models`.
            const separator = moduleName.endsWith(".") ? "" : ".";
            this.imports.push({
                source: `${moduleName}${separator}${imported}`,
                names: [{ imported: "*", local }],
            });
        }

        this.imports.push({ source: moduleName, names });
    }

    private visitClass(node: SyntaxNode): void {
        const name = node.childForFieldName("name")?.text;
        if (!name) {
            return;
        }

        const bases = (node.childForFieldName("superclasses")?.namedChildren ?? [])
            .filter((base) => base.type === "identifier" || base.type === "attribute")
            .map((base) => base.text);
        const baseNames = bases.map((base) => base.slice(base.lastIndexOf(".") + 1));

        const symbol: CodeSymbol = {
            id: `${this.file}#${name}`,
            name,
            kind: baseNames.some((base) => ENUM_BASES.has(base))
                ? "enum"
                : baseNames.some((base) => INTERFACE_BASES.has(base))
                  ? "interface"
                  : "class",
            file: this.file,
            line: node.startPosition.row + 1,
            exported: !name.startsWith("_"),
            members: [],
        };
        this.symbols.push(symbol);

        for (const base of bases) {
            this.addReference(symbol, base, "inherits");
        }

        const body = node.childForFieldName("body");
        for (const statement of body?.namedChildren ?? []) {
            this.visitClassStatement(statement, symbol);
        }

        for (const used of collectUsedNames(body)) {
            this.addReference(symbol, used, "uses");
        }
    }

    private visitClassStatement(statement: SyntaxNode, symbol: CodeSymbol): void {
        const members = symbol.members as CodeMember[];
        const definition = unwrapDecorated(statement);

        if (definition.type === "function_definition") {
            const name = definition.childForFieldName("name")?.text;
            if (!name) {
                return;
            }

            if (name === "__init__") {
                members.push(...selfAssignments(definition.childForFieldName("body")));
                return;
            }
            if (isDunder(name)) {
                return;
            }

            const decorators = decoratorNames(statement);
            if (decorators.has("property")) {
                members.push({
                    name,
                    kind: "property",
                    visibility: visibilityOf(name),
                    isStatic: false,
                    type: typeText(definition.childForFieldName("return_type")),
                });
                return;
            }

            members.push({
                name,
                kind: "method",
                visibility: visibilityOf(name),
                isStatic: decorators.has("staticmethod") || decorators.has("classmethod"),
                type: typeText(definition.childForFieldName("return_type")),
            });
            return;
        }

        if (definition.type === "class_definition") {
            return; // Nested classes are rare in diagrams; skip.
        }

        // Class attributes: `count: int = 0` / `name = "x"`.
        const assignment = statement.type === "expression_statement"
            ? statement.namedChildren[0]
            : undefined;
        const left = assignment?.type === "assignment"
            ? assignment.childForFieldName("left")
            : undefined;
        if (left?.type === "identifier" && !isDunder(left.text)) {
            members.push({
                name: left.text,
                kind: "property",
                visibility: visibilityOf(left.text),
                isStatic: false,
                type: typeText(assignment?.childForFieldName("type") ?? null),
            });
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

function unwrapDecorated(node: SyntaxNode): SyntaxNode {
    return node.type === "decorated_definition"
        ? node.childForFieldName("definition") ?? node
        : node;
}

function decoratorNames(node: SyntaxNode): Set<string> {
    if (node.type !== "decorated_definition") {
        return new Set();
    }
    return new Set(
        node.namedChildren
            .filter((child) => child.type === "decorator")
            .map((decorator) => decorator.text.replace(/^@/, "").split("(")[0]),
    );
}

function isDunder(name: string): boolean {
    return name.startsWith("__") && name.endsWith("__");
}

/** Python convention: `__x` private, `_x` protected. */
function visibilityOf(name: string): Visibility {
    if (name.startsWith("__")) {
        return "private";
    }
    return name.startsWith("_") ? "protected" : "public";
}

function typeText(node: SyntaxNode | null): string | undefined {
    const text = node?.text.replace(/\s+/g, " ").replace(/^["']|["']$/g, "");
    return text || undefined;
}

/** Attributes created with `self.name = ...` in `__init__`. */
function selfAssignments(body: SyntaxNode | null): CodeMember[] {
    const members: CodeMember[] = [];

    for (const statement of body?.namedChildren ?? []) {
        const assignment = statement.namedChildren[0];
        const left = assignment?.childForFieldName("left");
        if (
            statement.type === "expression_statement" &&
            assignment?.type === "assignment" &&
            left?.type === "attribute" &&
            left.childForFieldName("object")?.text === "self"
        ) {
            const name = left.childForFieldName("attribute")?.text;
            if (name) {
                members.push({
                    name,
                    kind: "property",
                    visibility: visibilityOf(name),
                    isStatic: false,
                    type: typeText(assignment.childForFieldName("type")),
                });
            }
        }
    }

    return members;
}

/**
 * Names that may refer to classes: type annotations and calls
 * (`Repo()` / `models.Repo()`). Unknown names are dropped by the graph.
 */
function collectUsedNames(root: SyntaxNode | null): Set<string> {
    const names = new Set<string>();
    if (!root) {
        return names;
    }

    const cursor = root.walk();
    let done = false;

    // Iterative walk: deep ASTs must not blow the stack.
    while (!done) {
        const node = cursor.currentNode;

        if (node.type === "type") {
            for (const id of node.descendantsOfType(["identifier", "attribute"])) {
                if (id.parent?.type !== "attribute") {
                    names.add(id.text);
                }
            }
            // String annotations: `-> "User"`.
            const quoted = node.text.match(/^["']([\w.]+)["']$/);
            if (quoted) {
                names.add(quoted[1]);
            }
        } else if (node.type === "call") {
            const fn = node.childForFieldName("function");
            if (fn?.type === "identifier" || fn?.type === "attribute") {
                names.add(fn.text);
            }
        }

        if (cursor.gotoFirstChild()) {
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
