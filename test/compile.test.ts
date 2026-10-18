import { env, exports } from 'cloudflare:workers';
import { describe, expect, inject, it } from 'vitest';
import { compileAndRun, type PlaygroundResult } from '../src/pipeline';

const stdout = (r: PlaygroundResult) => r.run?.output.filter((o) => o.stream === 'stdout').map((o) => o.text);

const HELLO = `
use std::collections::BTreeMap;
fn main() {
    let mut counts = BTreeMap::new();
    for w in "a b a c b a".split(' ') {
        *counts.entry(w).or_insert(0) += 1;
    }
    println!("{counts:?}");
}
`;

describe.skipIf(!inject('hasCompiler'))('rustc in a Worker', () => {
  it('compiles, links in-process and runs', async () => {
    const r = await compileAndRun(env, { code: HELLO });
    expect(r.compile.diagnostics).toBe('');
    expect(r.stage).toBe('run');
    expect(stdout(r)).toEqual(['{"a": 3, "b": 2, "c": 1}']);
    expect(r.run?.exitCode).toBe(0);
  });

  it('compiles to objects and links in the linker Worker', async () => {
    const r = await compileAndRun(env, { code: HELLO, pipeline: 'split' });
    expect(r.stage).toBe('run');
    expect(r.link?.ok).toBe(true);
    expect(stdout(r)).toEqual(['{"a": 3, "b": 2, "c": 1}']);
  });

  it('reuses a build of the same snippet, and still runs it', async () => {
    const code = `fn main() { println!("{}", std::env::args().count()); } // ${crypto.randomUUID()}`;
    const first = await compileAndRun(env, { code, pipeline: 'split' });
    expect(first.compile.cached).toBeUndefined();
    const again = await compileAndRun(env, { code, pipeline: 'split', args: ['x'] });
    expect(again.compile.cached).toBe(true);
    expect(again.link?.cached).toBe(true);
    expect(stdout(again)).toEqual(['2']);
    // Built another way, it compiles again.
    const single = await compileAndRun(env, { code });
    expect(single.compile.cached).toBeUndefined();
  });

  it('reports type errors with source spans', async () => {
    const r = await compileAndRun(env, { code: 'fn main() { let x: u32 = "no"; }' });
    expect(r.stage).toBe('compile');
    expect(r.compile.ok).toBe(false);
    expect(r.compile.diagnostics).toMatch(/error\[E0308\]: mismatched types/);
    expect(r.compile.diagnostics).toMatch(/main\.rs:1:/);
  });

  it('checks without codegen', async () => {
    const r = await compileAndRun(env, { code: 'fn main() { let v: Vec<u8> = Vec::new(); }', check: true });
    expect(r.compile.ok).toBe(true);
    expect(r.compile.diagnostics).toMatch(/unused variable/);
    expect(r.run).toBeUndefined();
  });

  it('runs release builds, with panics and exit codes', async () => {
    const r = await compileAndRun(env, {
      code: 'fn main() { let v: Vec<i32> = std::env::args().map(|a| a.len() as i32).collect(); assert!(v.len() > 5, "only {} args", v.len()); }',
      optLevel: '2',
      args: ['a', 'b'],
    });
    expect(r.stage).toBe('run');
    expect(r.run?.exitCode).toBe(101);
    expect(r.run?.output.map((o) => o.text).join('\n')).toMatch(/only 3 args/);
  });

  it('runs programs that start processes, which do not exist', async () => {
    const r = await compileAndRun(env, {
      code: 'fn main() { println!("{:?}", std::process::Command::new("ls").output().unwrap_err().kind()); }',
    });
    expect(stdout(r)).toEqual(['NotFound']);
  });

  it('is reachable over HTTP', async () => {
    const res = await exports.default.fetch('http://x/api/run', {
      method: 'POST',
      body: JSON.stringify({ code: 'use std::io::Read; fn main() { let mut s = String::new(); std::io::stdin().read_to_string(&mut s).unwrap(); println!("{}", s.trim().to_uppercase()); }', stdin: 'hi\n' }),
    });
    expect(stdout((await res.json()) as PlaygroundResult)).toEqual(['HI']);
  });

  it('streams the run as it happens', async () => {
    const res = await exports.default.fetch('http://x/api/run', {
      method: 'POST',
      headers: { accept: 'application/x-ndjson' },
      body: JSON.stringify({ code: `fn main() { println!("live"); } // ${crypto.randomUUID()}` }),
    });
    expect(res.headers.get('content-type')).toMatch(/^application\/x-ndjson/);
    const events = new TextDecoder().decode(await res.arrayBuffer()).trim().split('\n').map((l) => JSON.parse(l));
    const steps = events.filter((e) => e.type === 'step').map((e) => `${e.step} ${e.state}`);
    expect(steps).toEqual(['compile start', 'compile end', 'run start', 'run end']);
    expect(events.find((e) => e.type === 'cache')).toMatchObject({ what: 'build', outcome: 'miss' });
    const last = events.at(-1);
    expect(last.type).toBe('result');
    expect(stdout(last.result)).toEqual(['live']);
    expect(events.every((e, i) => i === 0 || e.t >= events[i - 1].t)).toBe(true);
  });
});
