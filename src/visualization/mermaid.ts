import { CodeGraph, CodeMember, CodeSymbol } from "../analyzer/types";

export interface DiagramTarget {
    file: string;
    line: number;
}

export interface Diagram {
    code: string;
    /** Mermaid node id -> source location, for click-to-open. */
    targets: Record<string, DiagramTarget>;
    nodeCount: number;
    edgeCount: number;
}

/** Keeps huge classes readable; the full list is one click away. */
const MAX_MEMBERS_PER_KIND = 12;

/** Name of the function the webview exposes for node clicks. */
export const CLICK_CALLBACK = "codemapperOpen";

/**
 * Stable, collision-free Mermaid ids. Ids are derived from the symbol id
 * (not from an index), so adding a file does not rename unrelated nodes.
 */
class IdRegistry {
    private readonly ids = new Map<string, string>();
    private readonly used = new Set<string>();

    get(key: string, prefix: string): string {
        const existing = this.ids.get(key);
        if (existing) {
            return existing;
        }

        const base = prefix + key.replace(/[^A-Za-z0-9]/g, "_");
        let id = base;
        for (let n = 2; this.used.has(id); n++) {
            id = `${base}_${n}`;
        }

        this.ids.set(key, id);
        this.used.add(id);
        return id;
    }
}

/** Files grouped by folder, with import edges between files. */
export function graphToModuleDiagram(graph: CodeGraph): Diagram {
    const ids = new IdRegistry();
    const targets: Record<string, DiagramTarget> = {};
    const modules = graph.symbols.filter((symbol) => symbol.kind === "module");

    const byFolder = new Map<string, CodeSymbol[]>();
    for (const module of modules) {
        const slash = module.file.lastIndexOf("/");
        const folder = slash === -1 ? "" : module.file.slice(0, slash);
        byFolder.set(folder, [...(byFolder.get(folder) ?? []), module]);
    }

    const lines = ["flowchart LR"];

    for (const folder of [...byFolder.keys()].sort()) {
        const indent = folder ? "        " : "    ";
        if (folder) {
            lines.push(
                `    subgraph ${ids.get(`dir:${folder}`, "d_")}["${label(folder + "/")}"]`,
            );
        }

        for (const module of byFolder.get(folder) ?? []) {
            const id = ids.get(module.id, "m_");
            targets[id] = { file: module.file, line: 1 };
            lines.push(`${indent}${id}["${label(module.name)}"]`);
        }

        if (folder) {
            lines.push("    end");
        }
    }

    const edges = graph.relations.filter((relation) => relation.type === "imports");
    for (const edge of edges) {
        lines.push(`    ${ids.get(edge.from, "m_")} --> ${ids.get(edge.to, "m_")}`);
    }

    for (const id of Object.keys(targets)) {
        lines.push(`    click ${id} ${CLICK_CALLBACK}`);
    }

    return {
        code: lines.join("\n"),
        targets,
        nodeCount: modules.length,
        edgeCount: edges.length,
    };
}

/** Classes, interfaces and enums with inheritance and usage edges. */
export function graphToClassDiagram(graph: CodeGraph): Diagram {
    const ids = new IdRegistry();
    const targets: Record<string, DiagramTarget> = {};
    const types = graph.symbols.filter(
        (symbol) =>
            symbol.kind === "class" ||
            symbol.kind === "interface" ||
            symbol.kind === "enum",
    );
    const typeIds = new Set(types.map((symbol) => symbol.id));

    const lines = ["classDiagram"];

    for (const symbol of types) {
        const id = ids.get(symbol.id, "c_");
        targets[id] = { file: symbol.file, line: symbol.line };

        lines.push(`    class ${id}["${label(symbol.name)}"] {`);

        const annotation =
            symbol.kind === "interface"
                ? "interface"
                : symbol.kind === "enum"
                  ? "enumeration"
                  : symbol.isAbstract
                    ? "abstract"
                    : undefined;
        if (annotation) {
            lines.push(`        <<${annotation}>>`);
        }

        for (const kind of ["property", "method"] as const) {
            const members = (symbol.members ?? []).filter((m) => m.kind === kind);
            for (const member of members.slice(0, MAX_MEMBERS_PER_KIND)) {
                lines.push(`        ${formatMember(member)}`);
            }
            if (members.length > MAX_MEMBERS_PER_KIND) {
                const hidden = members.length - MAX_MEMBERS_PER_KIND;
                lines.push(
                    kind === "method"
                        ? `        …${hidden} métodos más()`
                        : `        …${hidden} propiedades más`,
                );
            }
        }

        lines.push("    }");
    }

    const edges = graph.relations.filter(
        (relation) =>
            relation.type !== "imports" &&
            typeIds.has(relation.from) &&
            typeIds.has(relation.to),
    );

    for (const edge of edges) {
        const from = ids.get(edge.from, "c_");
        const to = ids.get(edge.to, "c_");

        if (edge.type === "inherits") {
            lines.push(`    ${to} <|-- ${from}`);
        } else if (edge.type === "implements") {
            lines.push(`    ${to} <|.. ${from}`);
        } else {
            lines.push(`    ${from} ..> ${to}`);
        }
    }

    for (const id of Object.keys(targets)) {
        lines.push(`    callback ${id} "${CLICK_CALLBACK}"`);
    }

    return {
        code: lines.join("\n"),
        targets,
        nodeCount: types.length,
        edgeCount: edges.length,
    };
}

const VISIBILITY_SYMBOLS: Record<CodeMember["visibility"], string> = {
    public: "+",
    private: "-",
    protected: "#",
    package: "~",
};

function formatMember(member: CodeMember): string {
    const visibility = VISIBILITY_SYMBOLS[member.visibility];
    const name = member.name
        .replace(/^#|^["']|["']$/g, "")
        .replace(/[^A-Za-z0-9_$]/g, "_");
    const type = memberType(member.type);
    const isStatic = member.isStatic ? "$" : "";

    // Mermaid syntax: `+Type name` for fields, `+name() Type` for methods.
    return member.kind === "method"
        ? `${visibility}${name}()${isStatic}${type ? ` ${type}` : ""}`
        : `${visibility}${type ? `${type} ` : ""}${name}${isStatic}`;
}

/**
 * Simple types are shown (`string`, `Foo[]`, `Map<K, V>`); anything that
 * could break the class body syntax (object literals, functions) is hidden.
 */
function memberType(type: string | undefined): string | undefined {
    if (!type || type.length > 40) {
        return undefined;
    }

    const converted = type.replace(/[<>]/g, "~");
    return /^[\w$.~[\], |]+$/.test(converted) ? converted : undefined;
}

/** Text safe inside a Mermaid `["..."]` label. */
function label(text: string): string {
    return text.replace(/"/g, "#quot;").replace(/[<>]/g, (c) =>
        c === "<" ? "#lt;" : "#gt;",
    );
}
