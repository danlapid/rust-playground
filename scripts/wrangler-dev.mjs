// Runs the three Workers in `wrangler dev` for the scripts here, with rustc's memory unlimited:
// some crates take it more than a deployed Worker gives it. `edit` can change the other
// configs too. Changed configs are written next to the originals, so relative paths in them
// still resolve, and removed again by `stop()`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
const CONFIGS = ['wrangler.jsonc', 'workers/compiler/wrangler.jsonc', 'workers/linker/wrangler.jsonc'];

/** Comments are on lines of their own in these configs. */
const readConfig = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/^\s*\/\/.*$/gm, ''));

/**
 * Starts `wrangler dev` on `port` and waits until it answers. `edit(file, config)` may change
 * a config in place, returning true if it did. `args` go to wrangler.
 */
export async function wranglerDev({ port, edit = () => false, args = [] }) {
  const written = [];
  const configs = CONFIGS.map((file) => {
    const config = readConfig(file);
    let changed = edit(file, config);
    if (file === 'workers/compiler/wrangler.jsonc') {
      config.vars = { ...config.vars, RUSTC_MEMORY_MIB: '4096' };
      changed = true;
    }
    if (!changed) return file;
    const out = path.join(path.dirname(file), 'wrangler.script.json');
    fs.writeFileSync(path.join(ROOT, out), JSON.stringify(config, null, 2));
    written.push(out);
    return out;
  });
  const dev = spawn(path.join(ROOT, 'node_modules/.bin/wrangler'), ['dev', '--port', String(port), ...args, ...configs.flatMap((c) => ['-c', c])], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  dev.stdout.on('data', (d) => (log += d));
  dev.stderr.on('data', (d) => (log += d));
  const stop = () => {
    dev.kill();
    for (const p of written) fs.rmSync(path.join(ROOT, p), { force: true });
  };

  const base = `http://localhost:${port}`;
  try {
    for (let i = 0; ; i++) {
      if (dev.exitCode !== null || i > 120) throw new Error(`wrangler dev didn't start:\n${log}`);
      if (await fetch(base).then(() => true, () => false)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (e) {
    stop();
    throw e;
  }
  return { base, stop, log: () => log };
}
