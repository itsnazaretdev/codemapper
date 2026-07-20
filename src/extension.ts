import * as vscode from "vscode";
import { GoogleGenerativeAI } from "@google/generative-ai";

/**
 * Retrieves the stored Gemini API key from VS Code SecretStorage,
 * or guides the user to obtain one.
 */
async function getOrPromptApiKey(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  const SECRET_KEY_NAME = "gemini_api_key";
  let apiKey = await context.secrets.get(SECRET_KEY_NAME);

  if (!apiKey) {
    const selection = await vscode.window.showInformationMessage(
      "CodeMapper AI requires a free Gemini API key to analyze your project.",
      "Get Free API Key",
      "I already have one",
    );

    if (selection === "Get Free API Key") {
      vscode.env.openExternal(
        vscode.Uri.parse("https://aistudio.google.com/app/apikey"),
      );
    }

    apiKey = await vscode.window.showInputBox({
      prompt: "Paste your Gemini API Key here (stored locally in OS Keychain)",
      password: true,
      ignoreFocusOut: true,
    });

    if (apiKey) {
      await context.secrets.store(SECRET_KEY_NAME, apiKey);
      vscode.window.showInformationMessage("🔑 API Key saved securely!");
    }
  }

  return apiKey;
}

/**
 * Scans the workspace for project files.
 */
async function scanWorkspaceFiles(): Promise<string[]> {
  const excludePattern = "**/{node_modules,.git,dist,out,build,.vscode}/**";
  const files = await vscode.workspace.findFiles("**/*", excludePattern, 100);
  return files.map((file) => vscode.workspace.asRelativePath(file));
}

/**
 * Generates initial structural Mermaid architecture diagram.
 */
async function generateArchitectureDiagram(
  files: string[],
  apiKey: string,
): Promise<string> {
  const genAI = new GoogleGenerativeAI(apiKey);

  const prompt = `
You are an expert software architect. Below is the list of files in a project workspace:

Files in project:
${files.map((f) => `- ${f}`).join("\n")}

Based on this structure:
1. Infer the main modules and their relationships.
2. Generate a valid Mermaid.js flowchart using 'graph TD'.
3. Do not include custom classDef colors.
4. Return ONLY valid Mermaid code inside a markdown code block (\`\`\`mermaid ... \`\`\`).
`;

  const modelsToTry = [
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash",
  ];

  for (const modelName of modelsToTry) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (error: any) {
      if (modelName === modelsToTry[modelsToTry.length - 1]) {
        throw error;
      }
    }
  }

  throw new Error("Unable to connect to Gemini API models.");
}

/**
 * Generates a specific Sequence Diagram for a selected node/component.
 */
async function generateSequenceForNode(
  nodeName: string,
  files: string[],
  apiKey: string,
): Promise<string> {
  const genAI = new GoogleGenerativeAI(apiKey);

  const prompt = `
You are an expert software architect. Analyze the project structure below:

Files in project:
${files.map((f) => `- ${f}`).join("\n")}

Focus specifically on the component/file named: "${nodeName}"
1. Generate a valid Mermaid.js **sequenceDiagram** showing step-by-step how execution and data flows through "${nodeName}" and its related modules.
2. Keep the participants clear and lifelines well-defined.
3. DO NOT include custom CSS/classDef colors.
4. Return ONLY valid Mermaid code enclosed in a code block (\`\`\`mermaid ... \`\`\`).
`;

  const modelsToTry = [
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash",
  ];

  for (const modelName of modelsToTry) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (error: any) {
      if (modelName === modelsToTry[modelsToTry.length - 1]) {
        throw error;
      }
    }
  }

  throw new Error("Failed to generate sequence diagram.");
}

/**
 * Renders HTML panel for both Architecture Flowcharts & Sequence Flow views.
 */
function displayDiagramWebview(
  context: vscode.ExtensionContext,
  mermaidCode: string,
  title: string = "CodeMapper Architecture Diagram",
  fileList: string[] = [],
  apiKey: string = "",
) {
  const panel = vscode.window.createWebviewPanel(
    "codemapperDiagram",
    title,
    vscode.ViewColumn.One,
    { enableScripts: true },
  );

  const cleanMermaid = mermaidCode
    .replace(/```mermaid/g, "")
    .replace(/```/g, "")
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
                background-color: #969595;
                color: #ffffff;
                font-family: var(--vscode-font-family, sans-serif);
                overflow: hidden;
            }
            .header {
                padding: 10px 20px;
                background: #7e7e80;
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
                color: #dfdfdf;
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
                background: #7a7a7a;
                padding: 24px;
                border-radius: 8px;
                box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);
            }
            .mermaid .node {
                cursor: pointer !important;
            }
        </style>

        <script src="https://unpkg.com/@panzoom/panzoom@4.5.1/dist/panzoom.min.js"></script>
        <script type="module">
            import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
            
            const vscode = acquireVsCodeApi();

            mermaid.initialize({ startOnLoad: true, theme: 'dark', securityLevel: 'loose' });

            window.addEventListener('load', () => {
                const elem = document.getElementById('panzoom-element');
                const panzoom = Panzoom(elem, {
                    maxScale: 5,
                    minScale: 0.2,
                    contain: 'outside'
                });

                const viewport = document.getElementById('viewport');
                viewport.addEventListener('wheel', panzoom.zoomWithWheel);

                // Add click listener to all rendered Mermaid nodes
                setTimeout(() => {
                    const nodes = document.querySelectorAll('.mermaid .node');
                    nodes.forEach(node => {
                        node.addEventListener('click', (e) => {
                            e.stopPropagation();
                            const nodeText = node.textContent?.trim() || 'Component';
                            vscode.postMessage({
                                command: 'nodeClicked',
                                label: nodeText
                            });
                        });
                    });
                }, 800);
            });
        </script>
    </head>
    <body>
        <div class="header">
            <h2>📊 ${title}</h2>
            <span class="instructions">💡 Click any Node for Sequence Flow | 🖱️ Scroll to Zoom</span>
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

  // Listen for click messages coming from Webview JS
  panel.webview.onDidReceiveMessage(async (message) => {
    if (message.command === "nodeClicked") {
      const selectedNode = message.label;
      vscode.window.showInformationMessage(
        `🔍 Generating Sequence Flow for: ${selectedNode}...`,
      );

      try {
        const seqCode = await generateSequenceForNode(
          selectedNode,
          fileList,
          apiKey,
        );
        displayDiagramWebview(
          context,
          seqCode,
          `Sequence Flow: ${selectedNode}`,
          fileList,
          apiKey,
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to generate sequence: ${err}`);
      }
    }
  });
}

export function activate(context: vscode.ExtensionContext) {
  let generateDiagramCommand = vscode.commands.registerCommand(
    "codemapper-ai.scanWorkspace",
    async () => {
      if (
        !vscode.workspace.workspaceFolders ||
        vscode.workspace.workspaceFolders.length === 0
      ) {
        vscode.window.showErrorMessage(
          "Please open a folder or project workspace first!",
        );
        return;
      }

      try {
        const apiKey = await getOrPromptApiKey(context);
        if (!apiKey) {
          return;
        }

        vscode.window.showInformationMessage("🔍 Scanning workspace files...");
        const fileList = await scanWorkspaceFiles();

        vscode.window.showInformationMessage(
          "⚡ Generating architecture diagram with Gemini...",
        );
        const mermaidCode = await generateArchitectureDiagram(fileList, apiKey);

        // Render interactive dark webview
        displayDiagramWebview(
          context,
          mermaidCode,
          "Project Architecture Diagram",
          fileList,
          apiKey,
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Error generating diagram: ${error}`);
      }
    },
  );

  let clearKeyCommand = vscode.commands.registerCommand(
    "codemapper-ai.clearApiKey",
    async () => {
      await context.secrets.delete("gemini_api_key");
      vscode.window.showInformationMessage("🔑 Gemini API Key cleared!");
    },
  );

  context.subscriptions.push(generateDiagramCommand, clearKeyCommand);
}

export function deactivate() {}
