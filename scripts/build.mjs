// Bundles the Electron main, preload and renderer into dist/.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const prod = process.argv.includes('--prod');
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/renderer', { recursive: true });

const common = { bundle: true, sourcemap: !prod, minify: prod, logLevel: 'warning', legalComments: 'none' };
const node = { ...common, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] };

await Promise.all([
  build({ ...node, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.cjs' }),
  build({ ...node, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload.cjs' }),
  build({
    ...common,
    entryPoints: ['src/renderer/main.tsx'],
    outfile: 'dist/renderer/app.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development') },
  }),
]);
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/styles', 'dist/renderer/styles', { recursive: true });
console.log(`Built dist/ (${prod ? 'production' : 'development'})`);
