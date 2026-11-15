#!/usr/bin/env node
/**
 * Build the console for the static site Terraform uploads (infra/console.tf
 * reads dist/console):
 *
 *   dist/console/
 *     index.html                 console/index.html, naming the hashed bundle
 *     assets/console-<hash>.js   src/dashboard/console/main.ts and everything it imports
 *     assets/console-<hash>.css  the styles it imports
 *     assets/keep-awake.*        the loop the dashboard plays to keep a screen awake
 *     favicon.svg                console/public/, as is
 *
 * config.json is not here: Terraform writes it beside the build from the
 * pool, the client and the hosts, so a build is never tied to a deploy.
 *
 * `npm run build:console`.
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'console');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'assets'), { recursive: true });

const result = await build({
  entryPoints: { console: join(root, 'src', 'dashboard', 'console', 'main.ts') },
  outdir: out,
  entryNames: 'assets/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  minify: true,
  tsconfig: join(root, 'src', 'dashboard', 'tsconfig.json'),
  metafile: true,
  logLevel: 'info',
});

// The hashed names the entry page loads.
const outputs = Object.keys(result.metafile.outputs).map((file) => relative(out, resolve(root, file)).replace(/\\/g, '/'));
const script = outputs.find((file) => /^assets\/console-[A-Z0-9]+\.js$/i.test(file));
const style = outputs.find((file) => /^assets\/console-[A-Z0-9]+\.css$/i.test(file));
if (!script) {
  console.error('the console bundle was not written');
  process.exit(1);
}

const page = readFileSync(join(root, 'console', 'index.html'), 'utf8')
  .replace('%CONSOLE_JS%', `/${script}`)
  .replace('%CONSOLE_CSS%', style ? `<link rel="stylesheet" href="/${style}">` : '');
writeFileSync(join(out, 'index.html'), page);

// Served as they are: the icon, and the keep-awake loop the dashboard asks for by name.
const publicDir = join(root, 'console', 'public');
for (const name of readdirSync(publicDir)) cpSync(join(publicDir, name), join(out, name), { recursive: true });
const media = join(root, 'src', 'dashboard', 'assets');
if (existsSync(media)) {
  for (const name of readdirSync(media)) cpSync(join(media, name), join(out, 'assets', basename(name)));
}

console.log(`built ${out} (${script}${style ? `, ${style}` : ''})`);
