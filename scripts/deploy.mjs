// Deploys the playground: stages the toolchain into the Workers, makes sure the R2 bucket
// exists, then deploys each Worker before those that bind to it.
// Extra arguments go to every `wrangler deploy`, e.g. `pnpm run deploy -- --dry-run`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
// pnpm passes the `--` in `pnpm run deploy -- --dry-run` through; wrangler would treat
// everything after it as positional, and deploy for real.
const args = process.argv.slice(2).filter((a) => a !== '--');
const dryRun = args.includes('--dry-run');
const WORKERS = [
  'workers/compiler/wrangler.jsonc',
  'workers/linker/wrangler.jsonc',
  'wrangler.jsonc',
];

const run = (cmd, cmdArgs, opts = {}) => execFileSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', ...opts });
const wrangler = (...a) => run('pnpm', ['exec', 'wrangler', ...a]);

if (!fs.existsSync(path.join(ROOT, 'dist/toolchain')) || !fs.existsSync(path.join(ROOT, 'dist/compiler/rustc.wasm'))) {
  console.error('No toolchain in dist/. Build it first: see "Building" in README.md.');
  process.exit(1);
}
run('pnpm', ['toolchain:stage']);

if (!dryRun) {
  const config = fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
  const bucket = config.match(/"bucket_name":\s*"([^"]+)"/)[1];
  try {
    execFileSync('pnpm', ['exec', 'wrangler', 'r2', 'bucket', 'info', bucket], { cwd: ROOT, stdio: 'ignore' });
  } catch {
    wrangler('r2', 'bucket', 'create', bucket);
  }
}

for (const config of WORKERS) wrangler('deploy', '-c', config, ...args);
