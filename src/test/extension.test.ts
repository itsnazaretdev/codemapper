import * as assert from "assert";
import * as vscode from "vscode";
import { analyzeWorkspace } from "../analyzer";
import { analyzeSources, SourceFile } from "../analyzer/core";
import { CodeGraph } from "../analyzer/types";
import {
    graphToClassDiagram,
    graphToModuleDiagram,
} from "../visualization/mermaid";

const sources: SourceFile[] = [
    {
        path: "src/models/base.ts",
        content: `
export abstract class Entity<T> { protected id: string = ""; abstract validate(): boolean; }
export interface Named { name: string; }
export default class Repo {}
export class Other {}
`,
    },
    {
        path: "src/models/index.ts",
        content: `export * from "./base";\nexport { User as Person } from "./user";`,
    },
    {
        path: "src/models/user.ts",
        content: `
import { Entity, Named } from "./base.js";
export class User extends Entity<User> implements Named { name = ""; validate() { return true; } }
`,
    },
    {
        path: "src/services/userService.ts",
        content: `
import Repo from "../models/base";
import { Person } from "../models";
export class UserService {
    constructor(private readonly repo: Repo) {}
    find(): Person { return new Person(); }
}
`,
    },
];

function shuffled<T>(items: T[]): T[] {
    return [...items].reverse().sort(() => Math.random() - 0.5);
}

function hasRelation(graph: CodeGraph, from: string, to: string, type: string) {
    return graph.relations.some(
        (r) => r.from === from && r.to === to && r.type === type,
    );
}

suite("Analyzer", () => {
    test("same code always produces the same diagrams", () => {
        const first = analyzeSources(sources).graph;

        for (let i = 0; i < 20; i++) {
            const other = analyzeSources(shuffled(sources)).graph;
            assert.strictEqual(
                graphToModuleDiagram(other).code,
                graphToModuleDiagram(first).code,
            );
            assert.strictEqual(
                graphToClassDiagram(other).code,
                graphToClassDiagram(first).code,
            );
        }
    });

    test("resolves inheritance, implementation, defaults and barrels", () => {
        const { graph, failedFiles } = analyzeSources(sources);
        const user = "src/models/user.ts#User";
        const service = "src/services/userService.ts#UserService";

        assert.deepStrictEqual(failedFiles, []);
        assert.ok(hasRelation(graph, user, "src/models/base.ts#Entity", "inherits"));
        assert.ok(hasRelation(graph, user, "src/models/base.ts#Named", "implements"));
        assert.ok(hasRelation(graph, service, "src/models/base.ts#Repo", "uses"));
        assert.ok(hasRelation(graph, service, user, "uses"));
        assert.ok(!hasRelation(graph, service, "src/models/base.ts#Other", "uses"));
        assert.ok(
            hasRelation(graph, "src/models/user.ts", "src/models/base.ts", "imports"),
        );
    });

    test("extracts members with visibility and types", () => {
        const { graph } = analyzeSources(sources);
        const entity = graph.symbols.find(
            (s) => s.id === "src/models/base.ts#Entity",
        );

        assert.strictEqual(entity?.isAbstract, true);
        assert.deepStrictEqual(entity?.members, [
            { name: "id", kind: "property", visibility: "protected", isStatic: false, type: "string" },
            { name: "validate", kind: "method", visibility: "public", isStatic: false, type: "boolean" },
        ]);
    });
});

suite("Java", () => {
    const javaSources: SourceFile[] = [
        {
            path: "src/main/java/com/app/model/Item.java",
            content: `package com.app.model;
public abstract class Item { protected int id; public abstract String label(); }`,
        },
        {
            path: "src/main/java/com/app/model/Book.java",
            content: `package com.app.model;
public class Book extends Item implements Comparable<Book> {
    private String title;
    public String label() { return title; }
}`,
        },
        {
            path: "src/main/java/com/app/ui/Window.java",
            content: `package com.app.ui;
import com.app.model.*;
import com.app.data.Repo;
public class Window {
    private final Repo repo = new Repo();
    void show(Book book) {}
}`,
        },
        {
            path: "src/main/java/com/app/data/Repo.java",
            content: `package com.app.data;
import java.util.List;
public class Repo { List<com.app.model.Book> all() { return null; } }`,
        },
        {
            path: "src/main/java/com/app/model/package-info.java",
            content: `package com.app.model;`,
        },
    ];

    test("resolves packages, wildcard imports and qualified names", () => {
        const { graph } = analyzeSources(shuffled(javaSources));
        const book = "src/main/java/com/app/model/Book.java#Book";
        const repo = "src/main/java/com/app/data/Repo.java#Repo";
        const window = "src/main/java/com/app/ui/Window.java#Window";

        assert.ok(hasRelation(graph, book, "src/main/java/com/app/model/Item.java#Item", "inherits"));
        assert.ok(hasRelation(graph, window, book, "uses"));
        assert.ok(hasRelation(graph, window, repo, "uses"));
        assert.ok(hasRelation(graph, repo, book, "uses"));
        assert.ok(
            hasRelation(
                graph,
                "src/main/java/com/app/ui/Window.java",
                "src/main/java/com/app/model/Book.java",
                "imports",
            ),
        );
        assert.ok(
            !graph.symbols.some((s) => s.file.endsWith("package-info.java")),
            "package-info.java is ignored",
        );

        const item = graph.symbols.find((s) => s.name === "Item");
        assert.strictEqual(item?.isAbstract, true);
        assert.deepStrictEqual(item?.members?.map((m) => `${m.visibility} ${m.name}`), [
            "protected id",
            "public label",
        ]);
    });

    test("same Java code always produces the same diagrams", () => {
        const first = analyzeSources(javaSources).graph;
        const other = analyzeSources(shuffled(javaSources)).graph;
        assert.strictEqual(graphToClassDiagram(other).code, graphToClassDiagram(first).code);
        assert.strictEqual(graphToModuleDiagram(other).code, graphToModuleDiagram(first).code);
    });
});

suite("Workspace", () => {
    test("analyzes the opened workspace deterministically", async () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, "tests must run with test-fixtures/sample open");

        const first = await analyzeWorkspace(folder);
        const second = await analyzeWorkspace(folder);

        assert.strictEqual(first.fileCount, 5);
        assert.deepStrictEqual(first.failedFiles, []);
        assert.deepStrictEqual(second.graph, first.graph);
        assert.ok(
            first.graph.symbols.some((s) => s.id === "src/app.tsx#App"),
            "tsx files are parsed",
        );
    });

    test("command opens the diagram panel without errors", async () => {
        await vscode.commands.executeCommand("codemapper-ai.scanWorkspace");
    });
});
