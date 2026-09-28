const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

/**
 * Webview libraries are served from dist/media: node_modules is not
 * shipped in the .vsix and the diagram must work offline.
 */
function copyWebviewAssets() {
	const assets = {
		'mermaid.min.js': require.resolve('mermaid/dist/mermaid.min.js'),
		'panzoom.min.js': require.resolve('@panzoom/panzoom/dist/panzoom.min.js'),
	};
	const target = path.join(__dirname, 'dist', 'media');
	fs.mkdirSync(target, { recursive: true });
	for (const [name, source] of Object.entries(assets)) {
		fs.copyFileSync(source, path.join(target, name));
	}
}

async function main() {
	copyWebviewAssets();

	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode',
    'tree-sitter',
    'tree-sitter-typescript',
    'tree-sitter-java',
    'tree-sitter-python',
    'tree-sitter-c-sharp',
    'tree-sitter-php',],
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
