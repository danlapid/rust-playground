import './subarray';
import { WorkerEntrypoint } from 'cloudflare:workers';
import fs from 'node:fs';
import runtimeSource from '../../../dist/toolchain/runtime.mjs';
import procMacroEntrySource from './proc-macro/entry.js';
import createRustc from './generated/rustc.mjs';
import rustcWasm from './generated/rustc.wasm';
import link from './generated/link.json';
import sysrootManifest from './generated/sysroot.json';
import { mountPaged } from './paged';
import { cachedPages, mountSysroot, pagesFromFiles } from './sysroot';

// Where the bundled files land in node:fs, through find_additional_modules.
const BUNDLE = '/bundle/generated';
const TARGET = 'wasm32-unknown-emscripten';
const SYSROOT = '/sysroot';

/** Arguments every rustc invocation gets: the target and std. */
const BASE_ARGS = [`--target=${TARGET}`, `--sysroot=${SYSROOT}`, '--color=never'];

/** What rustc needs to link a program itself, with wasm-ld in-process. */
const LINK_ARGS = [
  '-Zunstable-options',
  '-Clinker-flavor=wasm-lld',
  '-Clinker=rust-lld',
  ...link.args
    .filter((a: string) => a !== '{OBJECTS}' && a !== '{RUST_LIBS}')
    .map((a: string) => a.replace('{EM_LIB}', `${BUNDLE}/em`).replace('{JS_SYMBOLS}', `${BUNDLE}/js_symbols.stub`))
    .map((a: string) => `-Clink-arg=${a}`),
];

/** A proc-macro crate, linked into a module of its own (see toolchain/proc-macro). */
export interface ProcMacroModule {
  /** Identifies the module, for its Dynamic Worker. */
  hash: string;
  wasm: Uint8Array;
  /** How many macros the crate has. */
  count: number;
}

export interface RustcRequest {
  /** Arguments after the target and sysroot. */
  args: string[];
  /** Proc-macro crates, by the path of their metadata (what `--extern` names). */
  procMacros?: Record<string, ProcMacroModule>;
  env?: Record<string, string>;
  stdin?: Uint8Array;
  /** Files to create first, by absolute path. */
  files?: Record<string, Uint8Array | string>;
  /** Files to create first from compressed pages (paged.ts), which rustc reads in place. */
  paged?: Record<string, Uint8Array>;
  /** Add the arguments for linking a wasm32-unknown-emscripten program. */
  link?: boolean;
  /** Files, or directories (recursively), to return afterwards. */
  collect?: string[];
  cwd?: string;
}

export interface RustcResult {
  code: number;
  /** The size of rustc's memory afterwards: the most it has used since it was last replaced. */
  memory: number;
  /** Everything rustc printed. */
  diagnostics: string;
  stdout: Uint8Array;
  stderr: Uint8Array;
  files: Record<string, Uint8Array>;
}

export interface CompileRequest {
  code: string;
  edition?: '2015' | '2018' | '2021' | '2024';
  /**
   * `link` produces a runnable program (rustc runs wasm-ld in-process), `objects` stops
   * before linking and returns the object files for the linker Worker, and `check` stops
   * after type checking.
   */
  mode?: 'link' | 'objects' | 'check';
  optLevel?: '0' | '1' | '2' | '3' | 's' | 'z';
  /** Compiled dependencies: their files by path, and the crates the snippet can name. */
  deps?: {
    files: Record<string, Uint8Array>;
    paged?: Record<string, Uint8Array>;
    externs: { name: string; path: string }[];
    procMacros?: Record<string, ProcMacroModule>;
  };
}

export interface CompileResult {
  ok: boolean;
  /** The program, in `link` mode. */
  wasm?: Uint8Array;
  /** Object files in link order, in `objects` mode. */
  objects?: Uint8Array[];
  diagnostics: string;
  /** See {@link RustcResult.memory}. */
  memory: number;
}

function collect(FS: any, path: string, out: Record<string, Uint8Array>) {
  const { exists, object } = FS.analyzePath(path);
  if (!exists) return;
  if (FS.isDir(object.mode)) {
    for (const name of FS.readdir(path) as string[]) {
      if (name !== '.' && name !== '..') collect(FS, `${path}/${name}`, out);
    }
  } else {
    out[path] = FS.readFile(path);
  }
}

interface ProcMacroWorker {
  count(): Promise<number>;
  run(
    index: number,
    input: Uint8Array,
    forceShowPanics: boolean,
    dispatch: (request: Uint8Array) => Uint8Array,
  ): Promise<{ output: Uint8Array; log: string[] }>;
}

/** The Dynamic Worker that runs a proc-macro module, sandboxed: macros are arbitrary code. */
function procMacroWorker(loader: WorkerLoader, module: Pick<ProcMacroModule, 'hash' | 'wasm'>): ProcMacroWorker {
  const worker = loader.get(`proc-macro:${module.hash}`, async () => ({
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
    mainModule: 'entry.js',
    modules: {
      'entry.js': procMacroEntrySource,
      'runtime.js': runtimeSource,
      'macro.wasm': { wasm: module.wasm.slice().buffer },
    },
    globalOutbound: null,
  }));
  return worker.getEntrypoint() as unknown as ProcMacroWorker;
}

/**
 * rustc's proc-macro host (see rustc_proc_macro::bridge::remote): `load` registers a
 * proc-macro crate's macros, and `run` expands one in the crate's Dynamic Worker. `run`
 * suspends rustc (JSPI) until the macro is done; meanwhile, the macro's requests to the
 * bridge come back here and are served by rustc's dispatcher, re-entering it. It can't
 * suspend, so it must not read a page of metadata that isn't fetched yet: all of them are,
 * before rustc runs (see sysroot.ts).
 */
function procMacroHost(
  loader: WorkerLoader | undefined,
  modules: Record<string, ProcMacroModule>,
  log: string[],
  wasmMemory: WebAssembly.Memory,
) {
  let exports: any;
  const slots: { module: ProcMacroModule; index: number }[] = [];
  const memory = () => new Uint8Array(wasmMemory.buffer);
  const write = (bytes: Uint8Array) => {
    const ptr = exports.__rustc_proc_macro_alloc(bytes.length);
    memory().set(bytes, ptr);
  };
  const host = {
    load(ptr: number, len: number, firstSlot: number) {
      const path = new TextDecoder().decode(memory().subarray(ptr, ptr + len));
      const module = modules[path];
      if (!module || !loader) return -1;
      for (let i = 0; i < module.count; i++) slots[firstSlot + i] = { module, index: i };
      return module.count;
    },
    async run(slot: number, ptr: number, len: number, forceShowPanics: number) {
      const { module, index } = slots[slot];
      const input = memory().slice(ptr, ptr + len);
      const result = await procMacroWorker(loader!, module).run(index, input, !!forceShowPanics, (request) => {
        write(request);
        const replyLen = exports.__rustc_proc_macro_dispatch();
        const replyPtr = exports.__rustc_proc_macro_reply();
        return memory().slice(replyPtr, replyPtr + replyLen);
      });
      log.push(...result.log);
      write(result.output);
      return result.output.length;
    },
  };
  return { host, setExports: (e: any) => (exports = e) };
}

/** std's crate metadata, from this Worker's static assets: the binding of the current run. */
let assets: RustcEnv['ASSETS'];
const sysrootPages = cachedPages(
  sysrootManifest,
  pagesFromFiles(sysrootManifest, async (name) => {
    const res = await assets.fetch(`http://assets/sysroot/${name}.z`);
    if (!res.ok) throw new Error(`std's metadata, ${name}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }),
);

/** std's object code, read from the bundle once. */
const rlibs = new Map<string, Uint8Array>();
function rlib(name: string): Uint8Array {
  let bytes = rlibs.get(name);
  if (!bytes) rlibs.set(name, (bytes = fs.readFileSync(`${BUNDLE}/sysroot/${sysrootManifest.dir}/${name}`)));
  return bytes;
}

// rustc's memory, reused by every run, one at a time: an isolate's memory limit counts
// all of it, so two runs, or a finished run's memory awaiting garbage collection, would
// each count in full. 32 MiB is rustc's initial memory (toolchain/rustc/emcc-link.sh).
// It can grow to RUSTC_MEMORY_MIB. Workers lets an isolate past its 128 MB limit while a
// request runs (and retires it after), but kills it outright at about 230 MB, which would
// fail every request it's serving: so rustc's limit leaves room below that for JS (std's
// metadata pages, the run's files), and past it rustc fails to allocate instead. Above
// 128 MB, it relies on ./subarray.
// Memory can't shrink, so a run that grows it past KEEP_MEMORY (building a big crate)
// leaves it for the garbage collector, rather than leave every later run less room.
let memory: WebAssembly.Memory | undefined;
/** How much it grows at a time (toolchain/rustc/emcc-link.sh). */
const GROWTH_STEP = 2 * 1048576;
const KEEP_MEMORY = 64 * 1048576;
let running: Promise<unknown> = Promise.resolve();

function exclusive<T>(run: () => Promise<T>): Promise<T> {
  const result = running.then(run, run);
  running = result.catch(() => {});
  return result;
}

interface RustcEnv {
  LOADER?: WorkerLoader;
  /** The most memory rustc gets, in MiB (wrangler.jsonc). */
  RUSTC_MEMORY_MIB?: string;
  /** This Worker's static assets: std's crate metadata (toolchain/stage.mjs). */
  ASSETS: Fetcher;
}

/** Runs rustc, compiled to WebAssembly, in a fresh instance. */
function runRustc(request: RustcRequest, env: RustcEnv): Promise<RustcResult> {
  return exclusive(() => run(request, env));
}

async function run(
  { args, env = {}, stdin, files = {}, paged = {}, link = false, collect: paths = [], cwd, procMacros = {} }: RustcRequest,
  { LOADER: loader, ASSETS, RUSTC_MEMORY_MIB: maxMiB = '4096' }: RustcEnv,
): Promise<RustcResult> {
  if (memory) new Uint8Array(memory.buffer).fill(0);
  else memory = new WebAssembly.Memory({ initial: 512, maximum: Number(maxMiB) * 16 });
  const diagnostics: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const pm = procMacroHost(loader, procMacros, diagnostics, memory);
  let stdinPos = 0;
  const rustc = await createRustc({
    thisProgram: 'rustc',
    print: (text: string) => (diagnostics.push(text), stdout.push(text)),
    printErr: (text: string) => (diagnostics.push(text), stderr.push(text)),
    stdin: () => (stdin && stdinPos < stdin.length ? stdin[stdinPos++] : null),
    rustcProcMacroHost: pm.host,
    wasmMemory: memory,
    instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance) => void) {
      const instance = new WebAssembly.Instance(rustcWasm, imports);
      pm.setExports(instance.exports);
      done(instance);
      return {};
    },
    // Emscripten reads the environment once, possibly from static constructors, so it
    // has to be in place before they run. RUSTC_BOOTSTRAP allows -Z flags on a stable
    // compiler, which has to stay "stable 1.98.1" to load std built by rustup's 1.98.1
    // (toolchain/build-std.sh).
    preRun: [(m: { ENV: Record<string, string> }) => Object.assign(m.ENV, { RUSTC_BOOTSTRAP: '1', RUST_BACKTRACE: '0' }, env)],
  });
  const { FS, NODEFS } = rustc;
  // workerd reports /bundle directories as 0444 (no search bit), which emscripten's
  // permission checks reject. Everything here is ours, so skip the checks.
  FS.ignorePermissions = true;
  FS.mkdir('/bundle');
  FS.mount(NODEFS, { root: '/bundle' }, '/bundle');
  assets = ASSETS;
  await sysrootPages.prefetch();
  mountSysroot(FS, SYSROOT, sysrootManifest, rlib, sysrootPages.read);
  // Owned, not copied: they're this run's, and garbage after it.
  for (const [path, data] of Object.entries(files)) {
    FS.mkdirTree(path.slice(0, path.lastIndexOf('/')) || '/');
    FS.writeFile(path, data, { canOwn: true });
  }
  for (const [path, blob] of Object.entries(paged)) mountPaged(FS, path, blob);
  // rustc writes its outputs, and temporary files, next to where they go.
  for (const path of paths) FS.mkdirTree(path.slice(0, path.lastIndexOf('/')) || '/');
  if (cwd) {
    FS.mkdirTree(cwd);
    FS.chdir(cwd);
  }

  let code: number;
  try {
    // A promise: rustc's main is a JSPI export, so that proc macros can suspend it.
    // Unless the caller passes its own (build scripts probing rustc, e.g.).
    const base = BASE_ARGS.filter((a) => !args.some((b) => b === a.split('=')[0] || b.startsWith(a.split('=')[0] + '=')));
    code = await rustc.callMain([...base, ...args, ...(link ? LINK_ARGS : [])]);
  } catch (e) {
    code = 101;
    diagnostics.push(String(e));
  }
  // Running out shows up as an allocation failure, or a panic, in whatever needed it.
  if (code !== 0 && memory.buffer.byteLength + GROWTH_STEP > Number(maxMiB) * 1048576) {
    diagnostics.push(`note: rustc ran out of memory: it gets ${(memory.buffer.byteLength / 1048576).toFixed(0)} MiB in a Worker`);
  }
  const out: Record<string, Uint8Array> = {};
  for (const path of paths) collect(FS, path, out);
  const lines = (l: string[]) => new TextEncoder().encode(l.map((t) => `${t}\n`).join(''));
  const size = memory.buffer.byteLength;
  if (size > KEEP_MEMORY) memory = undefined;
  return {
    code,
    diagnostics: diagnostics.join('\n'),
    stdout: lines(stdout),
    stderr: lines(stderr),
    files: out,
    memory: size,
  };
}

interface CompilerEnv extends RustcEnv {
  LOADER: WorkerLoader;
}

export class Compiler extends WorkerEntrypoint<CompilerEnv> {
  rustc(request: RustcRequest): Promise<RustcResult> {
    return runRustc(request, this.env);
  }

  /** How many macros a proc-macro module has. */
  procMacroCount(module: Pick<ProcMacroModule, 'hash' | 'wasm'>): Promise<number> {
    return procMacroWorker(this.env.LOADER, module).count();
  }

  async compile({ code, edition = '2024', mode = 'link', optLevel = '0', deps }: CompileRequest): Promise<CompileResult> {
    const args = [
      '/work/main.rs',
      '--crate-name=main',
      `--edition=${edition}`,
      `-Copt-level=${optLevel}`,
      // Dependencies are declared in cargo-script frontmatter, which rustc 1.98 gates.
      ...(/^\s*---/.test(code.replace(/^#!(?!\[)[^\n]*\n/, '')) ? ['-Zcrate-attr=feature(frontmatter)'] : []),
      ...(deps ? ['-L', 'dependency=/deps', ...deps.externs.map((e) => `--extern=${e.name}=${e.path}`)] : []),
      ...(mode === 'check'
        ? ['--emit=metadata', '-o', '/work/main.rmeta']
        : mode === 'objects'
          ? ['-Zno-link', '-o', '/work/main']
          : ['-o', '/work/main.wasm']),
    ];
    const result = await runRustc(
      {
        args,
        files: { '/work/main.rs': code, ...deps?.files },
        paged: deps?.paged,
        procMacros: deps?.procMacros,
        link: mode === 'link',
        collect: ['/work'],
      },
      this.env,
    );
    const ok = result.code === 0;
    return {
      ok,
      wasm: ok && mode === 'link' ? result.files['/work/main.wasm'] : undefined,
      objects:
        ok && mode === 'objects'
          ? Object.keys(result.files)
              .filter((f) => f.endsWith('.o'))
              .sort()
              .map((f) => result.files[f])
          : undefined,
      diagnostics: result.diagnostics,
      memory: result.memory,
    };
  }
}

export default {
  fetch() {
    return new Response('rust-playground compiler: use the Compiler entrypoint over RPC', { status: 404 });
  },
} satisfies ExportedHandler;
