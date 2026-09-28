import * as vscode from "vscode";
import { WorkspaceAnalysis } from "../analyzer";
import { MAX_FILES } from "../analyzer/scanner";
import {
    Diagram,
    graphToClassDiagram,
    graphToModuleDiagram,
} from "./mermaid";

interface WebviewData {
    fileCount: number;
    warnings: string[];
    diagrams: { modules: Diagram; classes: Diagram };
}

/** Single diagram panel, reused between runs. */
export class DiagramPanel {
    private static current: DiagramPanel | undefined;

    private ready = false;
    private pending: unknown[] = [];
    private folder: vscode.WorkspaceFolder | undefined;

    static show(
        extensionUri: vscode.Uri,
        onRefresh: () => void,
    ): DiagramPanel {
        if (DiagramPanel.current) {
            DiagramPanel.current.panel.reveal();
            return DiagramPanel.current;
        }

        const panel = vscode.window.createWebviewPanel(
            "codemapperDiagram",
            "CodeMapper",
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, "media"),
                    vscode.Uri.joinPath(extensionUri, "dist", "media"),
                ],
            },
        );

        DiagramPanel.current = new DiagramPanel(panel, extensionUri, onRefresh);
        return DiagramPanel.current;
    }

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        onRefresh: () => void,
    ) {
        panel.webview.html = this.html(extensionUri);

        panel.onDidDispose(() => {
            DiagramPanel.current = undefined;
        });

        panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === "ready") {
                this.ready = true;
                this.pending.forEach((m) => panel.webview.postMessage(m));
                this.pending = [];
            } else if (message.command === "refresh") {
                onRefresh();
            } else if (message.command === "open") {
                await this.openSource(message.file, message.line);
            }
        });
    }

    showLoading(text: string): void {
        this.post({ command: "loading", text });
    }

    showError(text: string): void {
        this.post({ command: "error", text });
    }

    showAnalysis(analysis: WorkspaceAnalysis): void {
        this.folder = analysis.folder;
        this.panel.title = `CodeMapper: ${analysis.folder.name}`;

        const warnings: string[] = [];
        if (analysis.truncated) {
            warnings.push(
                `El proyecto tiene más de ${MAX_FILES} archivos; solo se muestran los ${MAX_FILES} primeros (orden alfabético).`,
            );
        }
        if (analysis.failedFiles.length > 0) {
            warnings.push(
                `No se pudieron analizar ${analysis.failedFiles.length} archivos: ${analysis.failedFiles.slice(0, 5).join(", ")}${analysis.failedFiles.length > 5 ? "…" : ""}`,
            );
        }

        const data: WebviewData = {
            fileCount: analysis.fileCount,
            warnings,
            diagrams: {
                modules: graphToModuleDiagram(analysis.graph),
                classes: graphToClassDiagram(analysis.graph),
            },
        };

        this.post({ command: "data", data });
    }

    private post(message: unknown): void {
        if (this.ready) {
            this.panel.webview.postMessage(message);
        } else {
            this.pending.push(message);
        }
    }

    private async openSource(file: string, line: number): Promise<void> {
        if (!this.folder || typeof file !== "string") {
            return;
        }

        const position = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
        await vscode.window.showTextDocument(
            vscode.Uri.joinPath(this.folder.uri, file),
            {
                viewColumn: vscode.ViewColumn.Beside,
                selection: new vscode.Range(position, position),
            },
        );
    }

    private html(extensionUri: vscode.Uri): string {
        const webview = this.panel.webview;
        const uri = (...segments: string[]) =>
            webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...segments));
        const nonce = createNonce();

        return /* html */ `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${uri("media", "webview.css")}">
</head>
<body>
    <div class="toolbar">
        <div class="tabs">
            <button data-tab="modules">Módulos</button>
            <button data-tab="classes">Clases</button>
        </div>
        <span id="stats" class="stats"></span>
        <span class="spacer"></span>
        <button id="zoomOut" title="Alejar">−</button>
        <button id="zoomIn" title="Acercar">+</button>
        <button id="fit" title="Ajustar a la ventana">Ajustar</button>
        <button id="refresh" title="Volver a analizar el proyecto">Actualizar</button>
    </div>
    <div id="warning" class="warning"></div>
    <div id="viewport"><div id="canvas"></div></div>

    <script nonce="${nonce}" src="${uri("dist", "media", "mermaid.min.js")}"></script>
    <script nonce="${nonce}" src="${uri("dist", "media", "panzoom.min.js")}"></script>
    <script nonce="${nonce}" src="${uri("media", "webview.js")}"></script>
</body>
</html>`;
    }
}

function createNonce(): string {
    const chars =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let nonce = "";
    for (let i = 0; i < 32; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
}
