#!/usr/bin/env node
/**
 * Bundle the platform function for Terraform (infra/lambda.tf):
 *
 *   infra/.build/lambda/
 *     index.js        src/platform/handler.ts and everything it imports, one file
 *     index.js.map    its source map (the function runs with --enable-source-maps)
 *
 * CommonJS, so nothing in the bundle has to care that the AWS SDK's Node
 * builds are: Lambda reads a bare .js with no package.json beside it as
 * CommonJS. The SDK is bundled rather than taken from the runtime, so the
 * function runs the version this repository's lockfile names.
 *
 * Run before `terraform apply`: `npm run build:lambda`.
 */
import { build } from 'esbuild';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'infra', '.build', 'lambda');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'platform', 'handler.ts')],
  outfile: join(out, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  sourcesContent: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
});

const size = statSync(join(out, 'index.js')).size;
console.log(`built ${join(out, 'index.js')} (${(size / 1024).toFixed(0)} KB)`);
// A direct upload takes 50 MB zipped; this is nowhere near it, and if it ever
// is, something was bundled that should not have been.
if (size > 20 * 1024 * 1024) {
  console.error('the function bundle is over 20 MB: something large was bundled');
  process.exit(1);
}
