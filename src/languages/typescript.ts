import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";

export function parseTypeScript(sourceCode: string) {
    const parser = new Parser();

    parser.setLanguage(TypeScript.typescript);

    return parser.parse(sourceCode);
}