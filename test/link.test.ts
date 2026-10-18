import { env } from 'cloudflare:workers';
import { describe, expect, inject, it } from 'vitest';
import { type RunOptions, runProgram } from '../src/runner';

const objects = inject('fixtureObjects');
const decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Links objects in the linker Worker, then runs the program. */
async function linkAndRun(objects: Uint8Array[], options: RunOptions = {}) {
  const linked = await env.LINKER.link({ objects });
  if (!linked.ok || !linked.wasm) return { stage: 'link' as const, diagnostics: linked.diagnostics };
  return { stage: 'run' as const, diagnostics: linked.diagnostics, run: await runProgram(env, linked.wasm, options) };
}
const stdout = (r: Awaited<ReturnType<typeof linkAndRun>>) =>
  r.run?.output.filter((o) => o.stream === 'stdout').map((o) => o.text);

describe('linking with wasm-ld in a Worker', () => {
  it('links rustc objects against the bundled sysroot and runs the result', async () => {
    const r = await linkAndRun(objects.hello.map(decode), { args: ['x'] });
    expect(r.diagnostics).toBe('');
    expect(r.stage).toBe('run');
    expect(r.run?.exitCode).toBe(0);
    expect(stdout(r)).toEqual(['Hello from Rust on Workers! the=3', 'args=["x"]', 'fs works']);
  });

  it('links every fixture', async () => {
    for (const name of ['panic', 'exit', 'stdin']) {
      const r = await linkAndRun(objects[name].map(decode), { stdin: '40\n2\n' });
      expect(r.stage, name).toBe('run');
    }
  });

  it('reports undefined symbols as link diagnostics', async () => {
    // Only the codegen unit without `main`'s callees: wasm-ld must fail, not crash.
    const r = await linkAndRun([decode(objects.hello[1])]);
    expect(r.stage).toBe('link');
    expect(r.diagnostics).toMatch(/undefined symbol/);
  });
});
