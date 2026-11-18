import { context } from 'esbuild';
const build = await context({ entryPoints: ['src/extension.ts'], bundle: true, outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], sourcemap: true, minify: !process.argv.includes('--watch') });
if (process.argv.includes('--watch')) await build.watch();
else { await build.rebuild(); await build.dispose(); }
