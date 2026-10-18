// Runs the staged rustc.wasm in Node the way the compiler Worker does (same /bundle
// layout, sysroot and arguments), then runs the program it builds with the generic
// runtime. std's metadata comes from the compiler Worker's static assets, the pages it
// fetches them from. Needs Node 24 or later, for JSPI.
//
// Usage: node toolchain/try-rustc.mjs [file.rs] [-- rustc args...]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cachedPages, mountSysroot, pagesFromFiles } from '../workers/compiler/src/sysroot.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const GENERATED = path.join(ROOT, 'workers/compiler/src/generated');
const BUNDLE = '/bundle/generated';

const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const extra = dash < 0 ? [] : argv.slice(dash + 1);
const file = (dash < 0 ? argv : argv.slice(0, dash))[0];
const code = file
  ? fs.readFileSync(file, 'utf8')
  : 'fn main() { let v: Vec<_> = (1..=5).map(|i| i * i).collect(); println!("hello from rustc.wasm: {v:?}"); }';

const { default: createRustc } = await import(pathToFileURL(path.join(GENERATED, 'rustc.mjs')).href);
const link = JSON.parse(fs.readFileSync(path.join(GENERATED, 'link.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(GENERATED, 'sysroot.json'), 'utf8'));
const MiB = (n) => `${(n / 1048576).toFixed(1)} MiB`;

let t = performance.now();
const rustcModule = await WebAssembly.compile(fs.readFileSync(path.join(GENERATED, 'rustc.wasm')));
console.log(`compiled in ${Math.round(performance.now() - t)} ms`);
t = performance.now();
let memory;
const instantiate = (module) => (imports, done) => {
  memory ??= imports.env.memory;
  done(new WebAssembly.Instance(module, imports));
  return {};
};
const rustc = await createRustc({
  thisProgram: 'rustc',
  print: (s) => console.log('[rustc]', s),
  printErr: (s) => console.log('[rustc]', s),
  instantiateWasm: instantiate(rustcModule),
  // Before static constructors run: emscripten reads the environment once.
  preRun: [(m) => Object.assign(m.ENV, { RUSTC_BOOTSTRAP: '1' })],
});
console.log(`instantiated in ${Math.round(performance.now() - t)} ms`);
const { FS, NODEFS } = rustc;
FS.mkdirTree(BUNDLE);
FS.mount(NODEFS, { root: GENERATED }, BUNDLE);
const ASSETS = path.join(ROOT, 'workers/compiler/assets/sysroot');
const fetched = { requests: 0, bytes: 0 };
const fetchPages = pagesFromFiles(manifest, async (name) => {
  const data = fs.readFileSync(path.join(ASSETS, `${name}.z`));
  fetched.requests++;
  fetched.bytes += data.length;
  return data;
});
const pages = cachedPages(manifest, fetchPages);
await pages.prefetch();
mountSysroot(FS, '/sysroot', manifest, (name) => fs.readFileSync(path.join(GENERATED, 'sysroot', manifest.dir, name)), pages.read);
FS.mkdir('/work');
FS.writeFile('/work/main.rs', code);

const linkArgs = link.args
  .filter((a) => a !== '{OBJECTS}' && a !== '{RUST_LIBS}')
  .map((a) => a.replace('{EM_LIB}', `${BUNDLE}/em`).replace('{JS_SYMBOLS}', `${BUNDLE}/js_symbols.stub`));
const args = [
  '/work/main.rs',
  '--edition=2024',
  '--target=wasm32-unknown-emscripten',
  '--sysroot=/sysroot',
  '--color=never',
  '-o', '/work/main.wasm',
  '-Zunstable-options',
  '-Clinker-flavor=wasm-lld',
  '-Clinker=rust-lld',
  ...linkArgs.map((a) => `-Clink-arg=${a}`),
  ...extra,
];
t = performance.now();
const status = await rustc.callMain(args);
console.log(`rustc exited ${status} in ${Math.round(performance.now() - t)} ms`);
console.log(`memory ${MiB(memory.buffer.byteLength)}; fetched ${MiB(fetched.bytes)} of compressed metadata pages, from ${fetched.requests} files`);
if (status !== 0 || !FS.analyzePath('/work/main.wasm').exists) process.exit(1);

const wasm = FS.readFile('/work/main.wasm');
console.log(`program: ${wasm.length} bytes`);
const { default: createModule } = await import(pathToFileURL(path.join(ROOT, 'dist/toolchain/runtime.mjs')).href);
await createModule({
  thisProgram: 'main',
  instantiateWasm: instantiate(await WebAssembly.compile(wasm)),
  print: (s) => console.log('[main]', s),
  printErr: (s) => console.log('[main:err]', s),
  onExit: (c) => console.log(`program exited ${c}`),
});
