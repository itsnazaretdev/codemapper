import { LanguageAnalyzer } from "./languageAnalyzer";
import { javaAnalyzer } from "./java";
import { typescriptAnalyzer } from "./typescript";

const analyzers: LanguageAnalyzer[] = [typescriptAnalyzer, javaAnalyzer];

export function getAnalyzer(
    filePath: string,
): LanguageAnalyzer | undefined {
    return analyzers.find((analyzer) =>
        analyzer.supports({
            path: filePath,
        }),
    );
}
