import { LanguageAnalyzer } from "./languageAnalyzer";
import { csharpAnalyzer } from "./csharp";
import { javaAnalyzer } from "./java";
import { phpAnalyzer } from "./php";
import { pythonAnalyzer } from "./python";
import { typescriptAnalyzer } from "./typescript";

const analyzers: LanguageAnalyzer[] = [
    typescriptAnalyzer,
    javaAnalyzer,
    pythonAnalyzer,
    csharpAnalyzer,
    phpAnalyzer,
];

export function getAnalyzer(
    filePath: string,
): LanguageAnalyzer | undefined {
    return analyzers.find((analyzer) =>
        analyzer.supports({
            path: filePath,
        }),
    );
}
