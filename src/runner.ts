import runtimeSource from '../dist/toolchain/runtime.mjs';
import { sha256 } from './hash';
import entrySource from './runner/entry.js';

/** The emscripten runtime programs run with (and are linked against). */
export { runtimeSource };

export interface RunOptions {
  args?: string[];
  stdin?: string;
  /** Environment variables, on top of emscripten's defaults. */
  env?: Record<string, string>;
  /** Files to create before running, by absolute path. */
  files?: Record<string, Uint8Array>;
  cwd?: string;
  /** Files, or directories (recursively), to return afterwards. */
  collect?: string[];
  /** Programs the program may start (by path, or name), which `spawn` runs. */
  programs?: string[];
  spawn?: (child: ChildProcess) => Promise<ChildResult>;
}

/** A process the program starts (with std::process::Command, e.g.). */
export interface ChildProcess {
  program: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: Uint8Array;
}

export interface ChildResult {
  status: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface RunResult {
  output: { stream: 'stdout' | 'stderr'; text: string }[];
  exitCode: number | null;
  files?: Record<string, Uint8Array>;
}

interface RunnerEntrypoint {
  run(options: RunOptions): Promise<RunResult>;
}

/** Runs a linked wasm32-unknown-emscripten program in a sandboxed Dynamic Worker. */
export async function runProgram(env: Env, wasm: Uint8Array, options: RunOptions = {}): Promise<RunResult> {
  const id = `run:${await sha256(wasm)}`;
  const worker = env.LOADER.get(id, async () => ({
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
    mainModule: 'entry.js',
    modules: {
      'entry.js': entrySource,
      'runtime.js': runtimeSource,
      'main.wasm': { wasm: wasm.slice().buffer },
    },
    globalOutbound: null,
  }));
  const runner = worker.getEntrypoint() as unknown as RunnerEntrypoint;
  return runner.run(options);
}
