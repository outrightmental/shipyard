#!/usr/bin/env node
/**
 * The console with a made-up fleet, to work on how it looks without a
 * platform, a sign-in or a machine: `npm run demo:console` (the fleet is in
 * src/dashboard/console/demo.ts).
 *
 * It bundles that entry, serves it on http://127.0.0.1:3939, and rebuilds as
 * the sources change; reload the page to see a change.
 *
 *   --port=<n>   another port
 *   --once       build and exit, for checking that it still builds
 */
import { context } from 'esbuild';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'console-demo');
const port = Number(process.argv.find((arg) => arg.startsWith('--port='))?.slice('--port='.length) ?? 3939);
const once = process.argv.includes('--once');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const build = await context({
  entryPoints: { demo: join(root, 'src', 'dashboard', 'console', 'demo.ts') },
  outdir: out,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  tsconfig: join(root, 'src', 'dashboard', 'tsconfig.json'),
  logLevel: 'info',
});
await build.rebuild();

writeFileSync(join(out, 'index.html'), readFileSync(join(root, 'console', 'index.html'), 'utf8')
  .replace('%CONSOLE_JS%', '/demo.js')
  .replace('%CONSOLE_CSS%', '<link rel="stylesheet" href="/demo.css">')
  .replace('<title>Shipyard</title>', '<title>Shipyard (demo)</title>'));
writeFileSync(join(out, 'favicon.svg'), readFileSync(join(root, 'console', 'public', 'favicon.svg')));

if (once) {
  await build.dispose();
  console.log(`built ${out}`);
  process.exit(0);
}

await build.watch();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json', '.svg': 'image/svg+xml' };

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  // Anything that is not a file of the build is the page itself, as the console's routes are.
  const file = normalize(join(out, extname(path) ? path : 'index.html'));
  if (!file.startsWith(out)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`the console, with a made-up fleet: http://127.0.0.1:${port}/`);
});
