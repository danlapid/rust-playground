// Builds resolved dependencies the way Cargo would: build scripts run as programs in a
// Dynamic Worker, libraries compile with rustc in the compiler Worker, and every unit is
// cached by a hash of everything that goes into it.
import shimSource from '../../toolchain/proc-macro/shim.rs';
import type { ProcMacroModule, RustcRequest } from '../../workers/compiler/src/index';
import { type ChildProcess, type ChildResult, runProgram } from '../runner';
import { TARGET, TARGET_CFG } from './cfg';
import { compressPages } from '../../workers/compiler/src/paged';
import { stubRlib } from './ar';
import { type CrateManifest, type Files, readManifest, unpackCrate } from './crate';
import { type BlobCache, type Registry } from './registry';
import { sha256 } from '../hash';
import type { Edge, Package, Resolution } from './resolve';
import { type Emit, type Outcome, type WorkerName, ignore } from '../events';

/** Changes whenever compiled artifacts stop being reusable (std included). */
export const RUSTC_ID = 'rustc 1.98.1 (48a229cea 2026-09-01) wasm32-unknown-emscripten, std with posix_spawn and split metadata';

/** Where build scripts find rustc ($RUSTC), which they may run to probe it. */
const RUSTC_PATH = '/usr/bin/rustc';

/** What the proc-macro module exports to its Dynamic Worker (see toolchain/proc-macro). */
const PROC_MACRO_EXPORTS = ['pm_alloc', 'pm_count', 'pm_output', 'pm_run'];

/** How many crates compile at once. */
const CONCURRENCY = 4;

interface BuildOptions {
  optLevel: string;
  /** Compiled units, by hash (R2 in the Worker). */
  cache?: BlobCache;
  /** Reads a built unit, if not from `cache` (`readUnit`), and where it came from. */
  readUnit?: (hash: string) => Promise<{ unit?: CachedUnit; outcome: Outcome }>;
  /** Hears about each crate's progress. */
  emit?: Emit;
}

interface Unit {
  pkg: Package;
  hash: string;
  libName: string;
  /** What dependents pass to `--extern` to compile: an rmeta, or a proc-macro crate's metadata. */
  rmeta: string;
  /** And to link: the crate's object code. */
  rlib?: string;
  /**
   * The crate's metadata and that of every crate it depends on, by path: what rustc
   * needs to compile a dependent library. Kept apart from the object code, which only
   * linking needs. Libraries' metadata is in `paged`, as compressed pages (see
   * workers/compiler/src/paged.ts), which rustc reads in place, a page at a time;
   * `metadata` has proc-macro crates', which is small.
   */
  metadata: Files;
  paged: Files;
  /** The rlibs of the crate and every crate it depends on: what linking also needs. */
  objects: Files;
  /** The proc-macro crates in the closure, by the path of their metadata. */
  procMacros: Record<string, ProcMacroModule>;
}

export interface UnitReport {
  id: string;
  cached: boolean;
  /** When it started (once its dependencies were built), from the start of the build. */
  start: number;
  ms: number;
  /** Its macros run in a Dynamic Worker of their own. */
  procMacro?: boolean;
  /** It has a build script, which ran in a Dynamic Worker (unless cached). */
  buildScript?: boolean;
}

export interface DepsResult {
  ok: boolean;
  /** Warnings from build scripts, or the error that stopped the build. */
  diagnostics: string;
  externs: { name: string; path: string }[];
  /**
   * What compiling the program, up to object files (-Zno-link), needs: the crates'
   * metadata (`paged` for libraries), and their rlibs as stubs. Linking is the linker
   * Worker's.
   */
  files: Files;
  paged: Files;
  /** The crates' object code (rlibs), for the linker. */
  objects: Uint8Array[];
  procMacros: Record<string, ProcMacroModule>;
  units: UnitReport[];
}

class BuildError extends Error {}

const enc = new TextEncoder();
const dec = new TextDecoder();
const featureCfgs = (features: string[]) => features.flatMap((f) => ['--cfg', `feature="${f}"`]);

function semaphore(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(f: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await f();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/**
 * Each package's unit hash: a hash of everything that goes into compiling it, its
 * dependencies' hashes included. It depends only on the resolution, so every unit's can
 * be known before any is built (or read from the cache).
 */
function unitHashes(resolution: Resolution, optLevel: string) {
  const hashes = new Map<string, Promise<string>>();
  const hashOf = (id: string): Promise<string> => {
    let hash = hashes.get(id);
    if (!hash) {
      const pkg = resolution.packages.get(id)!;
      hash = (async () => {
        const deps = await Promise.all(pkg.deps.map(async (e) => [e.name, e.kind, await hashOf(e.id)]));
        const key = JSON.stringify({ rustc: RUSTC_ID, id, features: pkg.features, optLevel, deps: deps.sort() });
        return (await sha256(key)).slice(0, 16);
      })();
      hashes.set(id, hash);
    }
    return hash;
  };
  return hashOf;
}

/** A unit's artifacts, as cached once it's built. */
export type CachedUnit = { libName: string; buildScript?: boolean } & (
  | { rmeta: Uint8Array; wasm: Uint8Array; count: number }
  | { pages: Uint8Array; rlib: Uint8Array }
);

/** A unit's artifacts from the cache, if it was built before. */
export async function readUnit(cache: BlobCache, hash: string): Promise<CachedUnit | undefined> {
  const meta = await cache.get(`units/${hash}.json`);
  if (!meta) return;
  const { libName, procMacro, buildScript } = JSON.parse(dec.decode(meta)) as {
    libName: string;
    procMacro?: { count: number };
    buildScript?: boolean;
  };
  if (procMacro) {
    const [rmeta, wasm] = await Promise.all([cache.get(`units/${hash}.rmeta`), cache.get(`units/${hash}.wasm`)]);
    return rmeta && wasm ? { libName, buildScript, rmeta, wasm, count: procMacro.count } : undefined;
  }
  const [pages, rlib] = await Promise.all([cache.get(`units/${hash}.pages`), cache.get(`units/${hash}.rlib`)]);
  return pages && rlib ? { libName, buildScript, pages, rlib } : undefined;
}

/** Bump when DepsResult, or how it's put together, changes: results are cached by key. */
const DEPS_FORMAT = 2;

/** A key for what `buildDependencies` returns for a resolution. */
export async function depsKey(resolution: Resolution, optLevel: string) {
  const hashOf = unitHashes(resolution, optLevel);
  const roots = await Promise.all(resolution.root.map(async (e) => [e.name, e.renamed, await hashOf(e.id)]));
  return (await sha256(JSON.stringify({ format: DEPS_FORMAT, roots }))).slice(0, 32);
}

/** Environment Cargo gives build scripts, beyond the package's own. */
function buildScriptEnv(pkg: Package, manifest: CrateManifest, dir: string, outDir: string, optLevel: string) {
  const cfgs = new Map<string, string[]>();
  for (const [name, value] of TARGET_CFG) {
    const key = `CARGO_CFG_${name.toUpperCase()}`;
    cfgs.set(key, [...(cfgs.get(key) ?? []), ...(value === null ? [] : [value])]);
  }
  return {
    ...manifest.env,
    ...Object.fromEntries([...cfgs].map(([k, v]) => [k, v.join(',')])),
    ...Object.fromEntries(pkg.features.map((f) => [`CARGO_FEATURE_${f.toUpperCase().replaceAll('-', '_')}`, '1'])),
    ...(manifest.links ? { CARGO_MANIFEST_LINKS: manifest.links } : {}),
    CARGO_MANIFEST_DIR: dir,
    CARGO_MANIFEST_PATH: `${dir}/Cargo.toml`,
    CARGO: '/usr/bin/cargo',
    RUSTC: RUSTC_PATH,
    RUSTDOC: '/usr/bin/rustdoc',
    CARGO_ENCODED_RUSTFLAGS: '',
    OUT_DIR: outDir,
    TARGET,
    HOST: TARGET,
    NUM_JOBS: '1',
    OPT_LEVEL: optLevel,
    DEBUG: optLevel === '0' ? 'true' : 'false',
    PROFILE: optLevel === '0' ? 'debug' : 'release',
  };
}

interface BuildScriptOutput {
  cfgs: string[];
  env: Record<string, string>;
  outFiles: Files;
  warnings: string[];
}

/** Parses `cargo:` and `cargo::` directives. */
function parseDirectives(stdout: string[]): Omit<BuildScriptOutput, 'outFiles'> {
  const out = { cfgs: [] as string[], env: {} as Record<string, string>, warnings: [] as string[] };
  for (const line of stdout) {
    const m = /^cargo::?([a-z-]+)=(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'rustc-cfg') out.cfgs.push(value);
    else if (key === 'rustc-env') {
      const eq = value.indexOf('=');
      if (eq > 0) out.env[value.slice(0, eq)] = value.slice(eq + 1);
    } else if (key === 'warning') out.warnings.push(value);
  }
  return out;
}

export async function buildDependencies(env: Env, registry: Registry, resolution: Resolution, options: BuildOptions): Promise<DepsResult> {
  const compiler = env.COMPILER;
  const { cache, optLevel } = options;
  const limit = semaphore(CONCURRENCY);
  const units = new Map<string, Promise<Unit>>();
  const reports: UnitReport[] = [];
  const t0 = performance.now();
  const warnings: string[] = [];
  const hashOf = unitHashes(resolution, optLevel);
  const emit = options.emit ?? ignore;
  const started = new Set<string>();

  /** Does `work` for a crate, in `worker`, telling `emit`. */
  async function working<T>(pkg: Package, worker: WorkerName, what: string, work: () => Promise<T>): Promise<T> {
    emit({ type: 'work', id: pkg.id, worker, what, state: 'start' });
    try {
      const result = await work();
      emit({ type: 'work', id: pkg.id, worker, what, state: 'end', ok: true });
      return result;
    } catch (e) {
      emit({ type: 'work', id: pkg.id, worker, what, state: 'end', ok: false });
      throw e;
    }
  }

  async function rustc(pkg: Package, request: RustcRequest, what: string) {
    const result = await limit(() => working(pkg, 'compiler', `compile ${what}`, () => compiler.rustc(request)));
    if (result.code !== 0) {
      throw new BuildError(`error: failed to compile ${what} of \`${pkg.name} v${pkg.version}\`\n\n${result.diagnostics}`);
    }
    return result;
  }

  async function runBuildScript(pkg: Package, manifest: CrateManifest, src: Files, dir: string, deps: Unit[], hash: string): Promise<BuildScriptOutput> {
    const key = `build-out/${hash}.json`;
    const cached = await cache?.get(key);
    if (cached) {
      const json = JSON.parse(dec.decode(cached));
      const outFiles = Object.fromEntries(Object.entries(json.outFiles as Record<string, string>).map(([p, b]) => [p, Uint8Array.from(atob(b), (c) => c.charCodeAt(0))]));
      return { ...json, outFiles };
    }
    const buildDeps = deps.filter((d) => pkg.deps.some((e) => e.kind === 'build' && e.id === d.pkg.id));
    const compiled = await rustc(
      pkg,
      {
        args: [
          `${dir}/${manifest.build}`,
          '--crate-name=build_script_build',
          '--crate-type=bin',
          `--edition=${manifest.edition}`,
          '-Copt-level=0',
          '--cap-lints=allow',
          ...featureCfgs(pkg.features),
          '-L', 'dependency=/deps',
          ...externs(pkg, buildDeps, 'build', true),
          '-o', '/out/build-script-build.wasm',
        ],
        env: { ...manifest.env, CARGO_MANIFEST_DIR: dir, CARGO_CRATE_NAME: 'build_script_build' },
        files: { ...src, ...Object.assign({}, ...buildDeps.flatMap((d) => [d.metadata, d.objects])) },
        paged: Object.assign({}, ...buildDeps.map((d) => d.paged)),
        procMacros: Object.assign({}, ...buildDeps.map((d) => d.procMacros)),
        link: true,
        collect: ['/out/build-script-build.wasm'],
      },
      'the build script',
    );
    const outDir = `/out/${pkg.name}-${hash}`;
    const files = { ...src, [`${outDir}/.keep`]: new Uint8Array() };
    // Build scripts run rustc to see what it supports (`rustc --version`, autocfg's
    // probes, ...): in the compiler Worker, with the package's files.
    const spawn = async (child: ChildProcess): Promise<ChildResult> => {
      const result = await working(pkg, 'compiler', `rustc ${child.args.join(' ')}`.slice(0, 80), () =>
        compiler.rustc({ args: child.args, env: child.env, stdin: child.stdin, cwd: child.cwd, files }),
      );
      return { status: result.code, stdout: result.stdout, stderr: result.stderr };
    };
    const run = await working(pkg, 'dynamic', 'run the build script', () => runProgram(env, compiled.files['/out/build-script-build.wasm'], {
      env: buildScriptEnv(pkg, manifest, dir, outDir, optLevel),
      files,
      cwd: dir,
      collect: [outDir],
      programs: [RUSTC_PATH],
      spawn,
    }));
    const stdout = run.output.filter((o) => o.stream === 'stdout').map((o) => o.text);
    if (run.exitCode !== 0) {
      const log = run.output.map((o) => o.text).join('\n');
      throw new BuildError(`error: failed to run the build script of \`${pkg.name} v${pkg.version}\` (exit code ${run.exitCode})\n\n${log}`);
    }
    const outFiles = run.files ?? {};
    delete outFiles[`${outDir}/.keep`];
    const result = { ...parseDirectives(stdout), outFiles };
    const toB64 = (b: Uint8Array) => btoa(Array.from(b, (c) => String.fromCharCode(c)).join(''));
    await cache?.put(key, enc.encode(JSON.stringify({ ...result, outFiles: Object.fromEntries(Object.entries(outFiles).map(([p, b]) => [p, toB64(b)])) })));
    return result;
  }

  /** What the dependent calls a dependency's crate, as Cargo passes it to `--extern`. */
  const externName = (edge: Edge, unit: Unit) => (edge.renamed ? edge.name.replaceAll('-', '_') : unit.libName);

  function externs(pkg: Package, deps: Unit[], kind: 'normal' | 'build', link: boolean) {
    return pkg.deps
      .filter((e) => e.kind === kind)
      .flatMap((e) => {
        const dep = deps.find((d) => d.pkg.id === e.id)!;
        return [dep.rmeta, ...(link && dep.rlib ? [dep.rlib] : [])].map((path) => `--extern=${externName(e, dep)}=${path}`);
      });
  }

  function unit(id: string): Promise<Unit> {
    let u = units.get(id);
    if (!u) {
      u = buildUnit(resolution.packages.get(id)!);
      u.catch(() => {
        if (started.has(id)) emit({ type: 'unit', id, state: 'end', ok: false });
      });
      units.set(id, u);
    }
    return u;
  }

  async function buildUnit(pkg: Package): Promise<Unit> {
    const hash = await hashOf(pkg.id);
    // Read it from the cache while its dependencies load.
    const lookup = performance.now();
    const cached = (
      options.readUnit
        ? options.readUnit(hash)
        : cache
          ? readUnit(cache, hash).then((unit) => ({ unit, outcome: unit ? ('r2' as const) : ('miss' as const) }))
          : Promise.resolve({ unit: undefined, outcome: 'miss' as const })
    ).then((found) => {
      emit({ type: 'cache', what: 'unit', id: pkg.id, outcome: found.outcome, ms: performance.now() - lookup });
      return found.unit;
    });
    cached.catch(() => {});
    const deps = await Promise.all([...new Set(pkg.deps.map((e) => e.id))].map(unit));
    const normalDeps = deps.filter((d) => pkg.deps.some((e) => e.kind === 'normal' && e.id === d.pkg.id));
    const metadata: Files = Object.assign({}, ...normalDeps.map((d) => d.metadata));
    const paged: Files = Object.assign({}, ...normalDeps.map((d) => d.paged));
    const objects: Files = Object.assign({}, ...normalDeps.map((d) => d.objects));
    const procMacros: Record<string, ProcMacroModule> = Object.assign({}, ...normalDeps.map((d) => d.procMacros));
    const start = performance.now();

    started.add(pkg.id);
    emit({ type: 'unit', id: pkg.id, state: 'start' });
    const hit = await cached;
    if (hit) {
      const { libName, buildScript } = hit;
      reports.push({ id: pkg.id, cached: true, start: start - t0, ms: performance.now() - start, procMacro: 'wasm' in hit, buildScript });
      emit({ type: 'unit', id: pkg.id, state: 'end', ok: true, cached: true, procMacro: 'wasm' in hit, buildScript });
      return 'wasm' in hit
        ? procMacroUnit(pkg, hash, libName, hit.rmeta, { hash, wasm: hit.wasm, count: hit.count })
        : libUnit(pkg, hash, libName, hit.pages, hit.rlib, { metadata, paged, objects }, procMacros);
    }

    const src = await unpackCrate(await working(pkg, 'crates.io', 'download', () => registry.download(pkg.entry)));
    const manifest = readManifest(src);
    if (!manifest.lib) throw new BuildError(`\`${pkg.name} v${pkg.version}\` has no library target`);
    const dir = `/src/${pkg.name}-${pkg.version}`;
    const files: Files = Object.fromEntries(Object.entries(src).map(([p, b]) => [`${dir}/${p}`, b]));

    let script: BuildScriptOutput | undefined;
    if (manifest.build) {
      script = await runBuildScript(pkg, manifest, files, dir, deps, hash);
      warnings.push(...script.warnings.map((w) => `warning: ${pkg.name}@${pkg.version}: ${w}`));
    }
    const outDir = `/out/${pkg.name}-${hash}`;
    const libName = manifest.lib.name;
    const isProcMacro = manifest.lib.procMacro;
    // A library compiles to metadata, which is what dependents compile against, and an
    // rlib with just its object code, for linking. A proc-macro crate compiles to
    // metadata and an object, which is linked into a module of its own below.
    const rlib = `/deps/lib${libName}-${hash}.rlib`;
    const rmeta = isProcMacro ? `/deps/${libName}-${hash}.wasm` : `/deps/lib${libName}-${hash}.rmeta`;
    const compiled = await rustc(
      pkg,
      {
        args: [
          `${dir}/${manifest.lib.path}`,
          `--crate-name=${libName}`,
          ...(isProcMacro
            ? ['--crate-type=proc-macro', '--extern=proc_macro', '-Ccodegen-units=1', `--emit=metadata=${rmeta},obj=/out/pm/${libName}.o`]
            : ['--crate-type=lib', '--emit=metadata,link', '-Zembed-metadata=no', '--out-dir=/deps']),
          `--edition=${manifest.edition}`,
          `-Copt-level=${optLevel}`,
          `-Cmetadata=${hash}`,
          `-Cextra-filename=-${hash}`,
          '--cap-lints=allow',
          ...featureCfgs(pkg.features),
          ...(script?.cfgs ?? []).flatMap((c) => ['--cfg', c]),
          '-L', 'dependency=/deps',
          ...externs(pkg, normalDeps, 'normal', false),
        ],
        env: {
          ...manifest.env,
          CARGO_MANIFEST_DIR: dir,
          CARGO_MANIFEST_PATH: `${dir}/Cargo.toml`,
          CARGO_CRATE_NAME: libName,
          ...(script ? { OUT_DIR: outDir } : {}),
          ...script?.env,
        },
        files: { ...files, ...script?.outFiles, ...metadata },
        paged,
        procMacros,
        collect: isProcMacro ? [rmeta, `/out/pm/${libName}.o`] : [rmeta, rlib],
      },
      'the library',
    );
    if (isProcMacro) {
      const objectFiles = Object.keys(compiled.files).filter((f) => f.endsWith('.o'));
      const module = await linkProcMacro(pkg, hash, objectFiles, { ...objects, ...compiled.files });
      await cache?.put(`units/${hash}.rmeta`, compiled.files[rmeta]);
      await cache?.put(`units/${hash}.wasm`, module.wasm);
      await cache?.put(`units/${hash}.json`, enc.encode(JSON.stringify({ libName, procMacro: { count: module.count }, buildScript: !!script })));
      reports.push({ id: pkg.id, cached: false, start: start - t0, ms: performance.now() - start, procMacro: true, buildScript: !!script });
      emit({ type: 'unit', id: pkg.id, state: 'end', ok: true, cached: false, procMacro: true, buildScript: !!script });
      return procMacroUnit(pkg, hash, libName, compiled.files[rmeta], module);
    }
    const [rmetaOut, rlibOut] = [compiled.files[rmeta], compiled.files[rlib]];
    if (!rmetaOut || !rlibOut) throw new BuildError(`rustc did not produce ${rmeta} and ${rlib} for \`${pkg.name}\``);
    const pages = compressPages(rmetaOut);
    await cache?.put(`units/${hash}.pages`, pages);
    await cache?.put(`units/${hash}.rlib`, rlibOut);
    await cache?.put(`units/${hash}.json`, enc.encode(JSON.stringify({ libName, buildScript: !!script })));
    reports.push({ id: pkg.id, cached: false, start: start - t0, ms: performance.now() - start, buildScript: !!script });
    emit({ type: 'unit', id: pkg.id, state: 'end', ok: true, cached: false, buildScript: !!script });
    return libUnit(pkg, hash, libName, pages, rlibOut, { metadata, paged, objects }, procMacros);
  }

  function libUnit(
    pkg: Package,
    hash: string,
    libName: string,
    pages: Uint8Array,
    rlibBytes: Uint8Array,
    deps: Pick<Unit, 'metadata' | 'paged' | 'objects'>,
    procMacros: Record<string, ProcMacroModule>,
  ): Unit {
    const rmeta = `/deps/lib${libName}-${hash}.rmeta`;
    const rlib = `/deps/lib${libName}-${hash}.rlib`;
    return {
      pkg,
      hash,
      libName,
      rmeta,
      rlib,
      metadata: deps.metadata,
      paged: { ...deps.paged, [rmeta]: pages },
      objects: { ...deps.objects, [rlib]: rlibBytes },
      procMacros,
    };
  }

  /**
   * A proc-macro crate's dependents only load its metadata (rustc does not load the
   * dependencies of proc-macro crates); its macros run in its module.
   */
  function procMacroUnit(pkg: Package, hash: string, libName: string, rmeta: Uint8Array, module: ProcMacroModule): Unit {
    const path = `/deps/${libName}-${hash}.wasm`;
    return { pkg, hash, libName, rmeta: path, metadata: { [path]: rmeta }, paged: {}, objects: {}, procMacros: { [path]: module } };
  }

  /**
   * Links a proc-macro crate's objects, the rlibs it depends on, and the shim that
   * exports its macros to the host into a program of its own.
   */
  async function linkProcMacro(pkg: Package, hash: string, objects: string[], files: Files): Promise<ProcMacroModule> {
    const rlibs = Object.keys(files).filter((f) => f.endsWith('.rlib'));
    const out = `/out/pm/${pkg.name}-${hash}.wasm`;
    const linked = await rustc(
      pkg,
      {
        args: [
          '/pm/shim.rs',
          '--crate-name=proc_macro_module',
          '--crate-type=bin',
          '--edition=2024',
          `-Copt-level=${optLevel}`,
          ...[...objects, ...rlibs, ...PROC_MACRO_EXPORTS.map((e) => `--export=${e}`)].map((a) => `-Clink-arg=${a}`),
          '-o', out,
        ],
        files: { ...files, '/pm/shim.rs': shimSource },
        link: true,
        collect: [out],
      },
      'the proc-macro module',
    );
    const wasm = linked.files[out];
    const count = await compiler.procMacroCount({ hash, wasm });
    return { hash, wasm, count };
  }

  try {
    const roots = await Promise.all(resolution.root.map(async (e) => ({ edge: e, unit: await unit(e.id) })));
    const objects: Files = Object.assign({}, ...roots.map((r) => r.unit.objects));
    return {
      ok: true,
      diagnostics: warnings.join('\n'),
      externs: roots.flatMap(({ edge, unit }) =>
        [unit.rmeta, ...(unit.rlib ? [unit.rlib] : [])].map((path) => ({ name: externName(edge, unit), path })),
      ),
      files: {
        ...Object.assign({}, ...roots.map((r) => r.unit.metadata)),
        ...Object.fromEntries(Object.entries(objects).map(([path, rlib]) => [path, stubRlib(rlib)])),
      },
      paged: Object.assign({}, ...roots.map((r) => r.unit.paged)),
      objects: Object.values(objects),
      procMacros: Object.assign({}, ...roots.map((r) => r.unit.procMacros)),
      units: reports,
    };
  } catch (e) {
    // Let in-flight units finish (and be cached) before reporting.
    await Promise.allSettled(units.values());
    if (!(e instanceof BuildError)) throw e;
    return { ok: false, diagnostics: [...warnings, e.message].join('\n'), externs: [], files: {}, paged: {}, objects: [], procMacros: {}, units: reports };
  }
}

/** A BlobCache over an R2 bucket. */
export function r2Cache(bucket: R2Bucket): BlobCache {
  return {
    get: (key) =>
      retrying(async () => {
        const obj = await bucket.get(key);
        return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
      }),
    put: (key, value) => retrying(async () => void (await bucket.put(key, value))),
  };
}

/** Tries again, a few times, what fails with an error that says it's worth it. */
async function retrying<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (e) {
      if (attempt === 3 || !(e as { retryable?: boolean }).retryable) throw e;
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
}
