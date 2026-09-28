import { CodeFile, FileAnalysis } from "../analyzer/types";

export interface LanguageAnalyzer {
    supports(file: CodeFile): boolean;

    analyze(file: CodeFile, sourceCode: string): FileAnalysis;

    /** Candidate paths an import specifier may point to, in priority order. */
    resolveImport(fromFile: string, specifier: string): string[];
}
