import {
    CodeFile,
    CodeSymbol,
    CodeRelation,
} from "../analyzer/types";

export interface LanguageAnalyzer {
    supports(file: CodeFile): boolean;

    analyze(
        file: CodeFile,
        sourceCode: string,
    ): Promise<{
        symbols: CodeSymbol[];
        relations: CodeRelation[];
    }>;
}