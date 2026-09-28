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

suite("JavaScript", () => {
    const jsSources: SourceFile[] = [
        {
            path: "src/animal.js",
            content: `class Animal { constructor(n) { this.name = n; } speak() {} }\nmodule.exports = Animal;`,
        },
        {
            path: "src/dog.mjs",
            content: `import Animal from "./animal.js";\nimport { Owner } from "./owner";\nexport class Dog extends Animal { constructor() { super(); this.owner = new Owner(); } }`,
        },
        {
            path: "src/owner.cjs",
            content: `class Owner {}\nmodule.exports = { Owner };`,
        },
        {
            path: "src/app.jsx",
            content: `const { Dog } = require("./dog.mjs");\nclass App { render() { return <div>{new Dog()}</div>; } }`,
        },
        { path: "src/vendor.min.js", content: `class Minified {}` },
    ];

    test("resolves require, module.exports and JSX", () => {
        const { graph, failedFiles } = analyzeSources(shuffled(jsSources));
        const dog = "src/dog.mjs#Dog";

        assert.deepStrictEqual(failedFiles, []);
        assert.ok(hasRelation(graph, dog, "src/animal.js#Animal", "inherits"));
        assert.ok(hasRelation(graph, "src/app.jsx#App", dog, "uses"));
        assert.ok(hasRelation(graph, dog, "src/owner.cjs#Owner", "uses"), "extensionless import");
        assert.ok(!graph.symbols.some((s) => s.name === "Minified"), "min.js is ignored");

        const animal = graph.symbols.find((s) => s.name === "Animal");
        assert.deepStrictEqual(animal?.members?.map((m) => m.name), ["name", "speak"]);
    });
});

suite("Python", () => {
    const pySources: SourceFile[] = [
        {
            path: "src/app/models/base.py",
            content: `from abc import ABC\nfrom enum import Enum\nclass Named(ABC):\n    def name(self) -> str: ...\nclass Base: pass\nclass Role(Enum):\n    ADMIN = 1\n`,
        },
        {
            path: "src/app/models/user.py",
            content: `from .base import Base, Named, Role\nclass User(Base, Named):\n    def __init__(self):\n        self._role: Role = Role.ADMIN\n    @staticmethod\n    def make() -> "User": ...\n`,
        },
        { path: "src/app/models/__init__.py", content: `from .user import User\n` },
        {
            path: "src/app/services/users.py",
            content: `from app.models import User\nimport app.models.base as b\nclass Users:\n    def get(self) -> User: ...\n    def base(self) -> b.Base: ...\n`,
        },
    ];

    test("resolves relative, absolute and package imports", () => {
        const { graph } = analyzeSources(shuffled(pySources));
        const user = "src/app/models/user.py#User";
        const users = "src/app/services/users.py#Users";

        assert.ok(hasRelation(graph, user, "src/app/models/base.py#Base", "inherits"));
        assert.ok(hasRelation(graph, user, "src/app/models/base.py#Named", "implements"));
        assert.ok(hasRelation(graph, user, "src/app/models/base.py#Role", "uses"));
        assert.ok(hasRelation(graph, users, user, "uses"), "through __init__.py");
        assert.ok(hasRelation(graph, users, "src/app/models/base.py#Base", "uses"), "module alias");

        const role = graph.symbols.find((s) => s.name === "Role");
        assert.strictEqual(role?.kind, "enum");
        const member = graph.symbols.find((s) => s.id === user)?.members;
        assert.deepStrictEqual(member?.map((m) => `${m.visibility} ${m.name}${m.isStatic ? "$" : ""}`), [
            "protected _role",
            "public make$",
        ]);
    });
});

suite("C#", () => {
    const csSources: SourceFile[] = [
        {
            path: "App/Models/User.cs",
            content: `namespace App.Models { public abstract class Entity {} public interface IUser {} public class User : Entity, IUser { public string Name { get; set; } internal int Age; } }`,
        },
        {
            path: "App/Services/UserService.cs",
            content: `using App.Models;\nusing Alias = App.Models.Entity;\nnamespace App.Services;\npublic class UserService { private readonly List<User> _users; public Alias Get() => null; }`,
        },
        {
            path: "App/Core.cs",
            content: `namespace App;\npublic enum Role { Admin }`,
        },
        {
            path: "App/Services/Other.cs",
            content: `namespace App.Services;\nclass Other { Role role; UserService service; }`,
        },
    ];

    test("resolves namespaces, using aliases and base lists", () => {
        const { graph } = analyzeSources(shuffled(csSources));
        const user = "App/Models/User.cs#User";
        const service = "App/Services/UserService.cs#UserService";
        const other = "App/Services/Other.cs#Other";

        assert.ok(hasRelation(graph, user, "App/Models/User.cs#Entity", "inherits"));
        assert.ok(hasRelation(graph, user, "App/Models/User.cs#IUser", "implements"));
        assert.ok(hasRelation(graph, service, user, "uses"), "generic argument");
        assert.ok(hasRelation(graph, service, "App/Models/User.cs#Entity", "uses"), "using alias");
        assert.ok(hasRelation(graph, other, service, "uses"), "same namespace");
        assert.ok(hasRelation(graph, other, "App/Core.cs#Role", "uses"), "parent namespace");

        const members = graph.symbols.find((s) => s.id === user)?.members;
        assert.deepStrictEqual(members?.map((m) => `${m.visibility} ${m.name}`), [
            "public Name",
            "package Age",
        ]);
    });
});

suite("PHP", () => {
    const phpSources: SourceFile[] = [
        {
            path: "app/Models/User.php",
            content: `<?php\nnamespace App\\Models;\nabstract class Model {}\nclass Team {}\nclass User extends Model { protected $fillable = []; public function team(): Team { return $this->belongsTo(Team::class); } }`,
        },
        {
            path: "app/Contracts/Repo.php",
            content: `<?php\nnamespace App\\Contracts;\ninterface Repo {}`,
        },
        {
            path: "app/Services/UserService.php",
            content: `<?php\nnamespace App\\Services;\nuse App\\Models\\User;\nuse App\\Contracts\\Repo as RepoContract;\ntrait Logs {}\nclass UserService implements RepoContract {\n    use Logs;\n    public function __construct(private User $user) {}\n    public function team() { return new \\App\\Models\\Team(); }\n    public static function all(): ?User { return User::query(); }\n}\n?>\n<p>html</p>`,
        },
    ];

    test("resolves namespaces, use aliases, traits and qualified names", () => {
        const { graph, failedFiles } = analyzeSources(shuffled(phpSources));
        const user = "app/Models/User.php#User";
        const service = "app/Services/UserService.php#UserService";

        assert.deepStrictEqual(failedFiles, []);
        assert.ok(hasRelation(graph, user, "app/Models/User.php#Model", "inherits"));
        assert.ok(hasRelation(graph, user, "app/Models/User.php#Team", "uses"), "same namespace");
        assert.ok(hasRelation(graph, service, "app/Contracts/Repo.php#Repo", "implements"), "use alias");
        assert.ok(hasRelation(graph, service, user, "uses"));
        assert.ok(hasRelation(graph, service, "app/Models/User.php#Team", "uses"), "qualified name");
        assert.ok(hasRelation(graph, service, "app/Services/UserService.php#Logs", "uses"), "trait");

        const logs = graph.symbols.find((s) => s.name === "Logs");
        assert.strictEqual(logs?.stereotype, "trait");
        const members = graph.symbols.find((s) => s.id === service)?.members;
        assert.deepStrictEqual(members?.map((m) => `${m.visibility} ${m.name}`), [
            "private user",
            "public team",
            "public all",
        ]);
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
