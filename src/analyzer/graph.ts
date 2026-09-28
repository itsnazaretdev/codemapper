import {
    CodeGraph,
    CodeRelation,
    CodeSymbol,
    FileAnalysis,
} from "./types";

/**
 * Candidate files an import may point to, in priority order. A candidate
 * starting with `*\/` matches any file ending with that path (languages
 * like Python import from a source root that is not known in advance).
 */
export type ImportResolver = (fromFile: string, specifier: string) => string[];

/**
 * Builds the project graph from the per-file analyses.
 *
 * The output only depends on the input content (never on the order files
 * were found or parsed): everything is deduplicated and sorted, so the same
 * code always produces exactly the same graph and the same diagram.
 */
export function buildGraph(
    analyses: FileAnalysis[],
    resolveImport: ImportResolver,
): CodeGraph {
    const sorted = [...analyses].sort((a, b) => compare(a.file, b.file));
    const knownFiles = new Set(sorted.map((analysis) => analysis.file));

    const symbolsById = new Map<string, CodeSymbol>();
    const symbolsByFile = new Map<string, Map<string, CodeSymbol>>();

    for (const analysis of sorted) {
        const moduleId = analysis.file;
        symbolsById.set(moduleId, {
            id: moduleId,
            name: analysis.file.split("/").pop() ?? analysis.file,
            kind: "module",
            file: analysis.file,
            line: 1,
            exported: true,
        });

        const byName = new Map<string, CodeSymbol>();
        for (const symbol of analysis.symbols) {
            // Declaration merging / overloads: keep the first declaration.
            if (!symbolsById.has(symbol.id)) {
                symbolsById.set(symbol.id, symbol);
                byName.set(symbol.name, symbol);
            }
        }
        symbolsByFile.set(analysis.file, byName);
    }

    const relations = new Map<string, CodeRelation>();
    const addRelation = (relation: CodeRelation) => {
        if (relation.from === relation.to) {
            return;
        }
        relations.set(
            `${relation.type}|${relation.from}|${relation.to}`,
            relation,
        );
    };

    const analysisByFile = new Map(sorted.map((a) => [a.file, a]));

    /** File name -> files with that name (sorted), for suffix candidates. */
    const filesByName = new Map<string, string[]>();
    for (const file of knownFiles) {
        const name = file.slice(file.lastIndexOf("/") + 1);
        filesByName.set(name, [...(filesByName.get(name) ?? []), file]);
    }

    const matchCandidate = (candidate: string): string | undefined => {
        if (!candidate.startsWith("*/")) {
            return knownFiles.has(candidate) ? candidate : undefined;
        }

        // Shortest match wins (closest to a source root), then alphabetical.
        const suffix = candidate.slice(2);
        const name = suffix.slice(suffix.lastIndexOf("/") + 1);
        return (filesByName.get(name) ?? [])
            .filter((file) => file === suffix || file.endsWith(`/${suffix}`))
            .sort((a, b) => a.length - b.length || compare(a, b))[0];
    };

    const resolveTarget = (fromFile: string, specifier: string) => {
        for (const candidate of resolveImport(fromFile, specifier)) {
            const match = matchCandidate(candidate);
            if (match) {
                return match;
            }
        }
        return undefined;
    };

    /** Follows `export ... from` chains (barrel files) to the declaration. */
    const resolveExport = (
        file: string,
        name: string,
        seen = new Set<string>(),
    ): CodeSymbol | undefined => {
        const key = `${file}|${name}`;
        if (seen.has(key)) {
            return undefined;
        }
        seen.add(key);

        const own = symbolsByFile.get(file);
        const direct =
            name === "default"
                ? [...(own?.values() ?? [])].find((symbol) => symbol.isDefault)
                : own?.get(name);
        if (direct) {
            return direct;
        }

        const analysis = analysisByFile.get(file);
        for (const ref of analysis?.imports ?? []) {
            if (!ref.reexport && !analysis?.importsAreExports) {
                continue;
            }
            const target = resolveTarget(file, ref.source);
            if (!target) {
                continue;
            }

            for (const { imported, local } of ref.names) {
                const found =
                    imported === "*"
                        ? local === "*" &&
                          name !== "default" &&
                          resolveExport(target, name, seen)
                        : local === name && resolveExport(target, imported, seen);
                if (found) {
                    return found;
                }
            }
        }

        return undefined;
    };

    /** Namespace (Java package) -> symbols declared in it. */
    const packages = new Map<string, Map<string, CodeSymbol>>();
    for (const analysis of sorted) {
        if (analysis.namespace === undefined) {
            continue;
        }
        const members = packages.get(analysis.namespace) ?? new Map();
        for (const [name, symbol] of symbolsByFile.get(analysis.file) ?? []) {
            if (!members.has(name)) {
                members.set(name, symbol);
            }
        }
        packages.set(analysis.namespace, members);
    }

    for (const analysis of sorted) {
        /** Local name -> symbol it refers to (imports resolved). */
        const scope = new Map<string, CodeSymbol>();
        /** Namespace imports: local name -> file. */
        const namespaces = new Map<string, string>();

        // Scope precedence, lowest first: wildcard package imports, same
        // package, explicit imports, local declarations.
        const packageImports = analysis.imports.filter((ref) => ref.byNamespace);
        for (const ref of packageImports) {
            if (ref.names.some((name) => name.imported === "*")) {
                for (const [name, symbol] of packages.get(ref.source) ?? []) {
                    scope.set(name, symbol);
                }
            }
        }
        if (analysis.namespace !== undefined) {
            for (const [name, symbol] of packages.get(analysis.namespace) ?? []) {
                scope.set(name, symbol);
            }
        }
        for (const ref of packageImports) {
            for (const { imported, local } of ref.names) {
                const symbol = packages.get(ref.source)?.get(imported);
                if (symbol) {
                    scope.set(local, symbol);
                    addRelation({ from: analysis.file, to: symbol.file, type: "imports" });
                }
            }
        }

        for (const ref of analysis.imports) {
            if (ref.byNamespace) {
                continue;
            }

            const target = resolveTarget(analysis.file, ref.source);
            if (!target) {
                continue;
            }

            addRelation({ from: analysis.file, to: target, type: "imports" });

            if (ref.reexport) {
                continue;
            }

            for (const { imported, local } of ref.names) {
                if (imported === "*" && local === "*") {
                    // `from x import *`: every name of the module.
                    for (const [name, symbol] of symbolsByFile.get(target) ?? []) {
                        scope.set(name, symbol);
                    }
                    continue;
                }

                if (imported === "*") {
                    namespaces.set(local, target);
                    continue;
                }

                const symbol = resolveExport(target, imported);
                if (symbol) {
                    scope.set(local, symbol);
                }
            }
        }

        // Local declarations shadow imports.
        for (const [name, symbol] of symbolsByFile.get(analysis.file) ?? []) {
            scope.set(name, symbol);
        }

        for (const ref of analysis.references) {
            const target = resolveName(ref.name, {
                scope,
                namespaces,
                packages,
                resolveExport,
            });
            if (!target || target.kind === "function") {
                continue;
            }

            // `class A : IThing` (C#) / `class A(Protocol)` (Python) do not say
            // whether the base is a class or an interface: the target does.
            const fromKind = symbolsById.get(ref.from)?.kind;
            const type =
                ref.type === "inherits" &&
                fromKind !== "interface" &&
                target.kind === "interface"
                    ? "implements"
                    : ref.type;

            addRelation({ from: ref.from, to: target.id, type });

            // Same-package / wildcard usages have no import line to draw.
            if (analysis.namespace !== undefined) {
                addRelation({ from: analysis.file, to: target.file, type: "imports" });
            }
        }
    }

    const symbols = [...symbolsById.values()]
        .map((symbol) => ({
            ...symbol,
            members: symbol.members && sortMembers(symbol.members),
        }))
        .sort((a, b) => compare(a.id, b.id));

    return {
        symbols,
        relations: [...relations.values()].sort(
            (a, b) =>
                compare(a.from, b.from) ||
                compare(a.to, b.to) ||
                compare(a.type, b.type),
        ),
    };
}

function resolveName(
    name: string,
    context: {
        scope: Map<string, CodeSymbol>;
        namespaces: Map<string, string>;
        packages: Map<string, Map<string, CodeSymbol>>;
        resolveExport: (file: string, name: string) => CodeSymbol | undefined;
    },
): CodeSymbol | undefined {
    if (!name.includes(".")) {
        return context.scope.get(name);
    }

    // `ns.Foo` where `import * as ns from "./x"` (or `import a.b` + `a.b.Foo`).
    for (let end = name.lastIndexOf("."); end > 0; end = name.lastIndexOf(".", end - 1)) {
        const file = context.namespaces.get(name.slice(0, end));
        if (file) {
            return context.resolveExport(file, name.slice(end + 1));
        }
    }

    // Fully qualified name: `com.app.model.Book`.
    const lastDot = name.lastIndexOf(".");
    return context.packages
        .get(name.slice(0, lastDot))
        ?.get(name.slice(lastDot + 1));
}

function sortMembers<T extends { kind: string; name: string }>(members: T[]): T[] {
    // Properties first, then methods; source order inside each group.
    return [
        ...members.filter((member) => member.kind === "property"),
        ...members.filter((member) => member.kind === "method"),
    ].filter(
        (member, index, all) =>
            all.findIndex(
                (other) => other.kind === member.kind && other.name === member.name,
            ) === index,
    );
}

/** Locale-independent comparison: same order on every machine. */
function compare(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}
