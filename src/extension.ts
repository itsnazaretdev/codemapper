import * as vscode from 'vscode';
import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * Retrieves the stored Gemini API key from VS Code SecretStorage,
 * or guides the user to obtain one.
 */
async function getOrPromptApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
    const SECRET_KEY_NAME = 'gemini_api_key';
    let apiKey = await context.secrets.get(SECRET_KEY_NAME);

    if (!apiKey) {
        const selection = await vscode.window.showInformationMessage(
            'CodeMapper AI requires a free Gemini API key to analyze your project.',
            'Get Free API Key',
            'I already have one'
        );

        if (selection === 'Get Free API Key') {
            vscode.env.openExternal(vscode.Uri.parse('https://aistudio.google.com/app/apikey'));
        }

        apiKey = await vscode.window.showInputBox({
            prompt: 'Paste your Gemini API Key here (stored locally in OS Keychain)',
            password: true,
            ignoreFocusOut: true
        });

        if (apiKey) {
            await context.secrets.store(SECRET_KEY_NAME, apiKey);
            vscode.window.showInformationMessage('🔑 API Key saved securely!');
        }
    }

    return apiKey;
}

/**
 * Scans the workspace for project files.
 */
async function scanWorkspaceFiles(): Promise<string[]> {
    const excludePattern = '**/{node_modules,.git,dist,out,build,.vscode}/**';
    const files = await vscode.workspace.findFiles('**/*', excludePattern, 100);
    return files.map(file => vscode.workspace.asRelativePath(file));
}

/**
 * Generates Mermaid architecture diagram using Gemini AI with model fallback.
 */
async function generateArchitectureDiagram(files: string[], apiKey: string): Promise<string> {
    const genAI = new GoogleGenerativeAI(apiKey);

    const prompt = `
You are an expert software architect. Below is the list of files in a project workspace:

Files in project:
${files.map(f => `- ${f}`).join('\n')}

Based on this structure:
1. Infer the main modules and their relationships.
2. Generate a valid Mermaid.js flowchart using 'graph TD'.
3. Do not include custom classDef colors. Keep it clean so the dark theme applies properly.
4. Return ONLY valid Mermaid code inside a markdown code block (\`\`\`mermaid ... \`\`\`).
`;

    const modelsToTry = ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-2.5-flash"];

    for (const modelName of modelsToTry) {
        try {
            console.log(`Attempting generation with model: ${modelName}`);
            const model = genAI.getGenerativeModel({ model: modelName });
            const result = await model.generateContent(prompt);
            return result.response.text();
        } catch (error: any) {
            console.warn(`Model ${modelName} failed:`, error?.message || error);
            if (modelName === modelsToTry[modelsToTry.length - 1]) {
                throw error;
            }
        }
    }

    throw new Error("Unable to connect to Gemini API models.");
}

/**
 * Opens a VS Code Webview panel and renders the Mermaid diagram visually in Dark Theme with pan/zoom.
 */
function displayDiagramWebview(context: vscode.ExtensionContext, mermaidCode: string) {
    const panel = vscode.window.createWebviewPanel(
        'codemapperDiagram',
        'CodeMapper Architecture Diagram',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    const cleanMermaid = mermaidCode
        .replace(/```mermaid/g, '')
        .replace(/```/g, '')
        .trim();

    panel.webview.html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            html, body {
                height: 100%;
                margin: 0;
                padding: 0;
                background-color: #1e1e1e;
                color: #ffffff;
                font-family: var(--vscode-font-family, sans-serif);
                overflow: hidden;
            }
            .header {
                padding: 10px 20px;
                background: #252526;
                border-bottom: 1px solid #3c3c3c;
                display: flex;
                justify-content: space-between;
                align-items: center;
                z-index: 10;
                position: relative;
            }
            h2 {
                margin: 0;
                color: #61dafb;
                font-size: 1.1rem;
            }
            .instructions {
                font-size: 0.85rem;
                color: #888888;
            }
            #viewport {
                width: 100vw;
                height: calc(100vh - 50px);
                cursor: grab;
            }
            #viewport:active {
                cursor: grabbing;
            }
            #panzoom-element {
                display: flex;
                justify-content: center;
                align-items: center;
                min-width: 100%;
                min-height: 100%;
                padding: 40px;
                box-sizing: border-box;
            }
            .mermaid {
                background: #252526;
                padding: 24px;
                border-radius: 8px;
                box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);
            }
        </style>

        <script src="https://unpkg.com/@panzoom/panzoom@4.5.1/dist/panzoom.min.js"></script>
        <script type="module">
            import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
            
            mermaid.initialize({ startOnLoad: true, theme: 'dark' });

            window.addEventListener('load', () => {
                const elem = document.getElementById('panzoom-element');
                const panzoom = Panzoom(elem, {
                    maxScale: 5,
                    minScale: 0.2,
                    contain: 'outside'
                });

                const viewport = document.getElementById('viewport');
                viewport.addEventListener('wheel', panzoom.zoomWithWheel);
            });
        </script>
    </head>
    <body>
        <div class="header">
            <h2>📊 Project Architecture Diagram</h2>
            <span class="instructions">🖱️ Mouse wheel to Zoom | Click & Drag to Move</span>
        </div>
        <div id="viewport">
            <div id="panzoom-element">
                <pre class="mermaid">
${cleanMermaid}
                </pre>
            </div>
        </div>
    </body>
    </html>
    `;
}

export function activate(context: vscode.ExtensionContext) {

    let generateDiagramCommand = vscode.commands.registerCommand('codemapper-ai.scanWorkspace', async () => {
        
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('Please open a folder or project workspace first!');
            return;
        }

        try {
            const apiKey = await getOrPromptApiKey(context);
            if (!apiKey) {
				return;
			}

            vscode.window.showInformationMessage('🔍 Scanning workspace files...');
            const fileList = await scanWorkspaceFiles();

            vscode.window.showInformationMessage('⚡ Generating architecture diagram with Gemini...');
            const mermaidCode = await generateArchitectureDiagram(fileList, apiKey);

            // Open Visual Dark Webview Tab
            displayDiagramWebview(context, mermaidCode);

        } catch (error) {
            vscode.window.showErrorMessage(`Error generating diagram: ${error}`);
        }
    });

    let clearKeyCommand = vscode.commands.registerCommand('codemapper-ai.clearApiKey', async () => {
        await context.secrets.delete('gemini_api_key');
        vscode.window.showInformationMessage('🔑 Gemini API Key cleared!');
    });

    context.subscriptions.push(generateDiagramCommand, clearKeyCommand);
}

export function deactivate() {}