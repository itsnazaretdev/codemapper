// @ts-check
/* global mermaid, Panzoom, acquireVsCodeApi */

(function () {
    const vscode = acquireVsCodeApi();

    const canvas = /** @type {HTMLElement} */ (document.getElementById("canvas"));
    const viewport = /** @type {HTMLElement} */ (document.getElementById("viewport"));
    const stats = /** @type {HTMLElement} */ (document.getElementById("stats"));
    const warning = /** @type {HTMLElement} */ (document.getElementById("warning"));
    const tabs = document.querySelectorAll("[data-tab]");

    /** @type {any} */
    let data;
    let activeTab = (vscode.getState() || {}).tab || "modules";
    let renderCount = 0;

    // eslint-disable-next-line no-undef
    const panzoom = Panzoom(canvas, {
        maxScale: 8,
        minScale: 0.05,
        canvas: true,
        origin: "0 0",
    });
    viewport.addEventListener("wheel", (event) => panzoom.zoomWithWheel(event));

    const isDark =
        document.body.classList.contains("vscode-dark") ||
        document.body.classList.contains("vscode-high-contrast");

    mermaid.initialize({
        startOnLoad: false,
        // Needed so `click` / `callback` lines can call codemapperOpen.
        securityLevel: "loose",
        theme: isDark ? "dark" : "default",
        maxTextSize: 5_000_000,
        maxEdges: 50_000,
        flowchart: { useMaxWidth: false },
        class: { useMaxWidth: false },
    });

    /** Called by Mermaid when a node is clicked. */
    // @ts-ignore
    window.codemapperOpen = (/** @type {string} */ nodeId) => {
        const target = data?.diagrams[activeTab]?.targets[nodeId];
        if (target) {
            vscode.postMessage({ command: "open", ...target });
        }
    };

    tabs.forEach((tab) =>
        tab.addEventListener("click", () => {
            activeTab = /** @type {HTMLElement} */ (tab).dataset.tab;
            vscode.setState({ tab: activeTab });
            render();
        }),
    );

    document.getElementById("refresh")?.addEventListener("click", () =>
        vscode.postMessage({ command: "refresh" }),
    );
    document.getElementById("zoomIn")?.addEventListener("click", () => panzoom.zoomIn());
    document.getElementById("zoomOut")?.addEventListener("click", () => panzoom.zoomOut());
    document.getElementById("fit")?.addEventListener("click", fit);

    window.addEventListener("message", (event) => {
        const message = event.data;
        if (message.command === "loading") {
            showMessage(message.text);
        } else if (message.command === "error") {
            showMessage(message.text, true);
        } else if (message.command === "data") {
            data = message.data;
            render();
        }
    });

    async function render() {
        tabs.forEach((tab) =>
            tab.classList.toggle(
                "active",
                /** @type {HTMLElement} */ (tab).dataset.tab === activeTab,
            ),
        );

        if (!data) {
            return;
        }

        const diagram = data.diagrams[activeTab];
        stats.textContent = `${data.fileCount} archivos · ${diagram.nodeCount} nodos · ${diagram.edgeCount} relaciones`;
        warning.textContent = data.warnings.join(" ");

        if (diagram.nodeCount === 0) {
            showMessage(
                activeTab === "classes"
                    ? "No se han encontrado clases, interfaces ni enums."
                    : "No se han encontrado archivos compatibles (por ahora: TypeScript y Java).",
            );
            return;
        }

        const current = ++renderCount;
        showMessage("Dibujando diagrama…");

        try {
            const { svg, bindFunctions } = await mermaid.render(
                `diagram-${current}`,
                diagram.code,
            );
            if (current !== renderCount) {
                return; // A newer render started meanwhile.
            }
            canvas.innerHTML = svg;
            useNaturalSize(canvas.querySelector("svg"));
            bindFunctions?.(canvas);
            fit();
        } catch (error) {
            showMessage(`No se pudo dibujar el diagrama:\n${error}`, true);
        }
    }

    /**
     * Some diagram types render with `width="100%"`, which collapses inside
     * the pan/zoom canvas. Pin the SVG to its real size; zoom handles the rest.
     * @param {SVGSVGElement | null} svg
     */
    function useNaturalSize(svg) {
        const viewBox = svg?.viewBox.baseVal;
        if (!svg || !viewBox || !viewBox.width) {
            return;
        }
        svg.setAttribute("width", String(viewBox.width));
        svg.setAttribute("height", String(viewBox.height));
        svg.style.maxWidth = "none";
    }

    function fit() {
        const svg = canvas.querySelector("svg");
        if (!svg) {
            panzoom.reset({ animate: false });
            return;
        }

        const width = svg.getBoundingClientRect().width / panzoom.getScale();
        const height = svg.getBoundingClientRect().height / panzoom.getScale();
        const scale = Math.min(
            1,
            viewport.clientWidth / (width + 48),
            viewport.clientHeight / (height + 48),
        );

        panzoom.zoom(scale, { animate: false });
        setTimeout(() => panzoom.pan(0, 0, { animate: false }));
    }

    /**
     * @param {string} text
     * @param {boolean} [isError]
     */
    function showMessage(text, isError = false) {
        canvas.innerHTML = "";
        const element = document.createElement("div");
        element.className = isError ? "message error" : "message";
        element.textContent = text;
        canvas.appendChild(element);
        panzoom.reset({ animate: false });
    }

    vscode.postMessage({ command: "ready" });
})();
