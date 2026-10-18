// Records a first build of the page's first example, as /api/run streams it, into
// public/recorded-run.json, for the page to replay until someone presses Run.
//
// It builds in `wrangler dev`, with an empty local bucket and no limit on rustc's memory,
// like warm-cache.mjs: some of the example's crates take rustc more memory than a deployed
// Worker gives it, so the deployed playground can't build them from nothing. Every Worker
// shares one process here, so a build is slower than in Workers, downloads especially.
//
// Usage: node scripts/record-run.mjs [--opt 0|2]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { EXAMPLES } from '../public/examples.js';
import { ROOT, wranglerDev } from './wrangler-dev.mjs';

const { values: args } = parseArgs({ options: { opt: { type: 'string', default: '0' } } });
const [example] = EXAMPLES;
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-record-'));
const dev = await wranglerDev({ port: 8791, args: ['--persist-to', state] });

try {
  const res = await fetch(`${dev.base}/api/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
    body: JSON.stringify({ code: example.code, optLevel: args.opt }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  const last = events.at(-1);
  if (last.type !== 'result' || last.result.stage !== 'run') throw new Error(`the build didn't finish:\n${JSON.stringify(last, null, 2).slice(0, 4000)}`);
  const built = events.filter((e) => e.type === 'unit' && e.state === 'end' && !e.cached).length;
  // Milliseconds are enough.
  for (const e of events) {
    e.t = Math.round(e.t);
    if (e.ms != null) e.ms = Math.round(e.ms);
  }
  fs.writeFileSync(path.join(ROOT, 'public/recorded-run.json'), JSON.stringify({ example: example.name, optLevel: args.opt, events }));
  console.log(`${example.name}: ${events.length} events over ${(last.t / 1000).toFixed(1)} s, ${built} crates built`);
} finally {
  dev.stop();
  fs.rmSync(state, { recursive: true, force: true });
}
