import { env } from 'cloudflare:workers';
import { describe, expect, inject, it } from 'vitest';
import { runProgram } from '../src/runner';

const linked = inject('linkedFixtures');
const wasm = (name: string) => Uint8Array.from(atob(linked[name]), (c) => c.charCodeAt(0));
const text = (r: { output: { stream: string; text: string }[] }, stream: string) =>
  r.output.filter((o) => o.stream === stream).map((o) => o.text);

describe('running emscripten programs in a Dynamic Worker', () => {
  it('captures stdout, stderr, args and uses the in-memory filesystem', async () => {
    const r = await runProgram(env, wasm('hello'), { args: ['a', 'b'] });
    expect(r.exitCode).toBe(0);
    expect(text(r, 'stdout')).toEqual(['Hello from Rust on Workers! the=3', 'args=["a", "b"]', 'fs works']);
    expect(text(r, 'stderr')).toEqual(['this goes to stderr']);
  });

  it('unwinds caught panics and exits 101 on an uncaught one', async () => {
    const r = await runProgram(env, wasm('panic'));
    expect(r.exitCode).toBe(101);
    expect(text(r, 'stdout')).toEqual(['caught=true', 'about to index out of bounds']);
    expect(text(r, 'stderr').join('\n')).toContain('index out of bounds: the len is 0 but the index is 3');
  });

  it('reports process::exit codes and flushes partial lines', async () => {
    const r = await runProgram(env, wasm('exit'));
    expect(r.exitCode).toBe(3);
    expect(text(r, 'stdout')).toEqual(['no trailing newline, then exit 3']);
  });

  it('feeds stdin', async () => {
    const r = await runProgram(env, wasm('stdin'), { stdin: '1\n2\n39\n' });
    expect(text(r, 'stdout')).toEqual(['sum=42']);
  });

  it('runs the same program twice in one isolate with fresh state', async () => {
    const [a, b] = await Promise.all([
      runProgram(env, wasm('stdin'), { stdin: '1\n' }),
      runProgram(env, wasm('stdin'), { stdin: '2\n' }),
    ]);
    expect([text(a, 'stdout'), text(b, 'stdout')]).toEqual([['sum=1'], ['sum=2']]);
  });

});
