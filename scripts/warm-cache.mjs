// Builds the examples' dependencies into the deployed playground's R2 bucket. Some crates
// take rustc more memory to compile than a Worker can give it (RUSTC_MEMORY_MIB in
// workers/compiler/wrangler.jsonc), so they're built here, in `wrangler dev`, which has no
// memory limit, with the bucket binding remote. Built units are keyed by everything that
// goes into them, rustc included, so the deployed Workers use them as they are.
//
// Usage: node scripts/warm-cache.mjs [file.rs...]   (default: the page's examples)
import fs from 'node:fs';
import { EXAMPLES } from '../public/examples.js';
import { wranglerDev } from './wrangler-dev.mjs';

const files = process.argv.slice(2);
const programs = (files.length ? files.map((f) => ({ name: f, code: fs.readFileSync(f, 'utf8') })) : EXAMPLES)
  // Only programs with dependencies, in cargo-script frontmatter.
  .filter((p) => /^\s*---/.test(p.code.replace(/^#!(?!\[)[^\n]*\n/, '')));

const dev = await wranglerDev({
  port: 8790,
  edit(file, config) {
    if (file !== 'wrangler.jsonc') return false;
    config.r2_buckets = config.r2_buckets.map((b) => ({ ...b, remote: true }));
    return true;
  },
});

let failed = false;
try {
  const run = async (code, optLevel) => {
    const res = await fetch(`${dev.base}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, optLevel }) });
    return res.ok ? await res.json() : { deps: { ok: false, diagnostics: await res.text(), units: [] } };
  };
  // Both of the page's builds: debug and release.
  for (const { name: example, code } of programs) for (const [optLevel, profile] of [['0', 'debug'], ['2', 'release']]) {
    const name = `${example} (${profile})`;
    const t = performance.now();
    let result = await run(code, optLevel);
    // Locally, a long build with many Dynamic Workers sometimes loses its connection.
    // What it built is cached, so trying again picks up where it left off.
    for (let i = 0; i < 3 && /Network connection lost/.test(result.deps?.diagnostics ?? ''); i++) result = await run(code, optLevel);
    const units = result.deps?.units ?? [];
    const built = units.filter((u) => !u.cached).length;
    const secs = ((performance.now() - t) / 1000).toFixed(1);
    if (result.deps?.ok) {
      console.log(`${name}: ${units.length} crates, ${built} built (${secs}s)`);
    } else {
      failed = true;
      console.log(`${name}: failed (${secs}s)\n${result.deps?.diagnostics}`);
      console.log(`wrangler dev's log ends:\n${dev.log().trim().split('\n').slice(-25).join('\n')}`);
    }
  }
} finally {
  dev.stop();
}
process.exit(failed ? 1 : 0);
