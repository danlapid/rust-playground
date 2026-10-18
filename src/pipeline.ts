import type { CompileRequest } from '../workers/compiler/src/index';
import { cachedBuild, cachedDeps, cachedResolve, storeBuild } from './cache';
import { RUSTC_ID, type UnitReport } from './cargo/build';
import { snippetManifest } from './cargo/crate';
import { type Emit, ignore, type RunEvent } from './events';
import { sha256 } from './hash';
import { type RunOptions, type RunResult, runProgram, runtimeSource } from './runner';

export interface PlaygroundRequest extends Pick<RunOptions, 'args' | 'stdin'> {
  code: string;
  edition?: CompileRequest['edition'];
  optLevel?: CompileRequest['optLevel'];
  /**
   * `single`: rustc links in-process, in the compiler Worker.
   * `split`: rustc stops before linking; the linker Worker (its own isolate) links.
   * Programs with dependencies are always split: linking them in rustc would take their
   * dependencies' object code, as well as rustc, in the compiler's memory.
   */
  pipeline?: 'single' | 'split';
  /** Stop after type checking. */
  check?: boolean;
}

interface StageResult {
  ok: boolean;
  diagnostics: string;
  ms: number;
  /** It came from the cache: the snippet was built the same way before. */
  cached?: boolean;
}

export interface PlaygroundResult {
  stage: 'deps' | 'compile' | 'link' | 'run';
  /** Dependencies from the snippet's frontmatter, when it has any. */
  deps?: StageResult & { units: UnitReport[] };
  /** `memory`: the size of rustc's memory, in bytes, afterwards (see RustcResult). */
  compile: StageResult & { memory?: number };
  link?: StageResult;
  run?: RunResult & { ms: number };
}

/** What compiling, and linking unless it only checked, came to. */
interface Build {
  compile: PlaygroundResult['compile'];
  link?: StageResult;
  wasm?: Uint8Array;
}

type Step = Extract<RunEvent, { type: 'step' }>['step'];

/** Says which Worker an error came from. */
const from = <T>(worker: string, call: Promise<T>) =>
  call.catch((e) => {
    throw new Error(`the ${worker} Worker: ${e instanceof Error ? e.message : e}`);
  });

/** Bump when Build, or how a snippet is compiled, changes: builds are cached by key. */
const BUILD_FORMAT = 1;

/** Identifies the runtime programs link against. */
let runtime: Promise<string> | undefined;
const runtimeId = () => (runtime ??= sha256(runtimeSource));

export async function compileAndRun(env: Env, request: PlaygroundRequest, emit: Emit = ignore): Promise<PlaygroundResult> {
  const compiler = env.COMPILER;
  const { code, edition, optLevel, pipeline = 'single', check = false } = request;
  /** Runs a step, telling `emit` when it starts and ends. */
  const step = async <T extends { ok: boolean }>(name: Step, work: () => Promise<T>): Promise<T> => {
    emit({ type: 'step', step: name, state: 'start' });
    try {
      const result = await work();
      emit({ type: 'step', step: name, state: 'end', ok: result.ok });
      return result;
    } catch (e) {
      emit({ type: 'step', step: name, state: 'end', ok: false });
      throw e;
    }
  };

  let t = performance.now();
  let deps: PlaygroundResult['deps'];
  let built: CompileRequest['deps'];
  let depObjects: Uint8Array[] = [];
  let depsId: string | undefined;
  const manifest = (() => {
    try {
      return snippetManifest(code);
    } catch (e) {
      return e as Error;
    }
  })();
  if (manifest instanceof Error || manifest?.dependencies.length) {
    const failed = (diagnostics: string) => ({
      stage: 'deps' as const,
      deps: { ok: false, diagnostics, ms: performance.now() - t, units: [] },
      compile: { ok: false, diagnostics: '', ms: 0 },
    });
    if (manifest instanceof Error) return failed(`error: invalid manifest: ${manifest.message}`);
    const resolved = await step('resolve', async () => {
      const t0 = performance.now();
      try {
        const { resolution, outcome } = await cachedResolve(manifest!.dependencies);
        emit({ type: 'cache', what: 'resolve', outcome, ms: performance.now() - t0 });
        return { ok: true as const, resolution };
      } catch (e) {
        return { ok: false as const, error: (e as Error).message };
      }
    });
    if (!resolved.ok) return failed(`error: failed to resolve dependencies: ${resolved.error}`);
    const result = await step('deps', () => cachedDeps(resolved.resolution, optLevel ?? '0', emit));
    deps = { ok: result.ok, diagnostics: result.diagnostics, ms: performance.now() - t, units: result.units };
    if (!result.ok) return { stage: 'deps', deps, compile: { ok: false, diagnostics: '', ms: 0 } };
    built = { files: result.files, paged: result.paged, externs: result.externs, procMacros: result.procMacros };
    depObjects = result.objects;
    depsId = result.key;
  }
  const split = pipeline === 'split' || !!built;
  const mode = check ? 'check' : split ? 'objects' : 'link';

  // What compiling and linking come to depends only on these, so it's kept, by them.
  const key = await sha256(
    JSON.stringify({ format: BUILD_FORMAT, rustc: RUSTC_ID, runtime: await runtimeId(), code, edition, optLevel, mode, deps: depsId }),
  );
  t = performance.now();
  const found = await cachedBuild<Build>(key);
  const lookup = performance.now() - t;
  emit({ type: 'cache', what: 'build', outcome: found.outcome, ms: lookup });
  let build: Build;
  if (found.value) {
    const { compile, link } = found.value;
    build = { ...found.value, compile: { ...compile, ms: lookup, cached: true }, link: link && { ...link, ms: 0, cached: true } };
    for (const [name, result] of [['compile', compile], ['link', link]] as const) {
      if (!result) continue;
      emit({ type: 'step', step: name, state: 'start', cached: true });
      emit({ type: 'step', step: name, state: 'end', ok: result.ok, cached: true });
    }
  } else {
    build = await compileAndLink();
    // Running out of memory depends on more than the snippet.
    if (!/rustc ran out of memory/.test(build.compile.diagnostics)) storeBuild(key, build);
  }
  const { compile, link, wasm } = build;
  if (!compile.ok || check) return { stage: 'compile', deps, compile };
  if (link && !link.ok) return { stage: 'link', deps, compile, link };

  async function compileAndLink(): Promise<Build> {
    t = performance.now();
    const compiled = await step('compile', () => from('compiler', compiler.compile({ code, edition, optLevel, mode, deps: built })));
    const compile = { ok: compiled.ok, diagnostics: compiled.diagnostics, ms: performance.now() - t, memory: compiled.memory };
    if (!compiled.ok || check || !split) return { compile, wasm: compiled.wasm };
    t = performance.now();
    const linked = await step('link', () => from('linker', env.LINKER.link({ objects: [...(compiled.objects ?? []), ...depObjects] })));
    return { compile, link: { ok: linked.ok, diagnostics: linked.diagnostics, ms: performance.now() - t }, wasm: linked.wasm };
  }

  t = performance.now();
  const run = await step('run', async () => ({ ok: true, ...(await runProgram(env, wasm!, { args: request.args, stdin: request.stdin })) }));
  const { ok: _, ...result } = run;
  return { stage: 'run', deps, compile, link, run: { ...result, ms: performance.now() - t } };
}
