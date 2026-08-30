import { LanguageAnalyzer } from "./languageAnalyzer";

const analyzers: LanguageAnalyzer[] = [];

export function getAnalyzer(
    filePath: string,
): LanguageAnalyzer | undefined {
    return analyzers.find((analyzer) =>
        analyzer.supports({
            path: filePath,
        }),
    );
}