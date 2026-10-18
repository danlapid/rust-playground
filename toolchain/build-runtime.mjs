#!/usr/bin/env node
// Build-time step: run emcc once on a reference program and turn what it does into
// data, so that linking and running user programs at request time needs no emcc.
//
// Outputs (dist/toolchain/):
//   runtime.mjs        emscripten JS glue that works with *any* program linked by link.json
//   link.json          wasm-ld arguments emcc would use, with inputs replaced by placeholders
//   js_symbols.stub    wasm-ld stub library listing every JS-implemented symbol
//   lib/em/*.a         emscripten system libraries (libc, dlmalloc, compiler-rt, ...)
//   lib/em/process.o   posix_spawn for programs, handed to the embedder (toolchain/runtime)
//   lib/rust/*.rlib    Rust std for wasm32-unknown-emscripten (toolchain/build-std.sh), for
//                      linking (object code only: the metadata is in .rmeta files)
//   sysroot/           the same std, .rlib and .rmeta files, for rustc in a Worker
//   fixtures/          reference programs compiled to objects, for tests
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'dist/toolchain');
const EMSDK = process.env.EMSDK ?? path.join(os.homedir(), 'emsdk');
const TARGET = 'wasm32-unknown-emscripten';
// Our std (toolchain/build-std.sh), for rustup's rustc 1.98.1.
const SYSROOT = path.join(ROOT, '.build/std/sysroot');
const RUNTIME_SRC = path.join(ROOT, 'toolchain/runtime');

// Settings for the generic runtime. MODULARIZE=1 gives a factory, so one isolate can
// run a program many times with fresh state. ASSERTIONS=0 because shell.js's runtime
// environment detection misidentifies workerd as a web worker.
const EMCC_SETTINGS = [
  '-sMODULARIZE=1',
  '-sEXPORT_ES6',
  '-sENVIRONMENT=node',
  '-sASSERTIONS=0',
  '-sALLOW_MEMORY_GROWTH=1',
  '-sEXIT_RUNTIME=1',
  '-sINCLUDE_FULL_LIBRARY',
  // main can suspend, for the host to run child processes (toolchain/runtime).
  '-sJSPI',
  // For the runner: environment variables, files in and out (build scripts), and main.
  '-sEXPORTED_RUNTIME_METHODS=FS,ENV,callMain',
];

const env = {
  ...process.env,
  PATH: [path.join(EMSDK, 'upstream/emscripten'), process.env.PATH].join(':'),
  EMSDK,
  EM_CONFIG: path.join(EMSDK, '.emscripten'),
  // Keeps emcc's temp files (the JS symbol stub) around after the link.
  EMCC_DEBUG_SAVE: '1',
};

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-runtime-'));
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'lib/em'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'lib/rust'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'fixtures'), { recursive: true });

// 1. Link a reference program through emcc and capture the wasm-ld command. rustc
// surfaces the linker's stderr (emcc -v) as a warning on its own stderr.
const refSrc = path.join(work, 'reference.rs');
fs.writeFileSync(refSrc, 'fn main() { println!("reference"); }\n');
const ref = spawnSync(
  'rustc',
  [
    '--target', TARGET, `--sysroot=${SYSROOT}`, '-Copt-level=0', refSrc, '-o', path.join(work, 'reference.mjs'),
    '-Clink-arg=-v', ...EMCC_SETTINGS.map((s) => `-Clink-arg=${s}`),
    `-Clink-arg=--js-library=${path.join(RUNTIME_SRC, 'process-host.js')}`,
  ],
  { env, cwd: work, encoding: 'utf8' },
);
if (ref.status !== 0) throw new Error(`reference link failed:\n${ref.stderr}`);
const ldLine = ref.stderr.split('\n').find((l) => /^\s*\S*\/bin\/wasm-ld /.test(l));
if (!ldLine) throw new Error(`no wasm-ld command in emcc output:\n${ref.stderr}`);
const ldArgs = ldLine.trim().split(/\s+/).slice(1);

// 2. Rewrite the command line into placeholders + bundled files.
const libDirs = [];
const args = [];
const rustLibs = [];
for (let i = 0; i < ldArgs.length; i++) {
  const a = ldArgs[i];
  if (a === '-o') { i++; continue; }
  if (a.endsWith('libemscripten_js_symbols.so')) {
    fs.copyFileSync(a, path.join(OUT, 'js_symbols.stub'));
    args.push('{JS_SYMBOLS}');
  } else if (a.startsWith('-L')) {
    libDirs.push(a.slice(2));
  } else if (a.startsWith('-l')) {
    const name = `lib${a.slice(2)}.a`;
    const dir = libDirs.find((d) => fs.existsSync(path.join(d, name)));
    if (!dir) throw new Error(`cannot find ${name} in ${libDirs.join(', ')}`);
    fs.copyFileSync(path.join(dir, name), path.join(OUT, 'lib/em', name));
    args.push(`{EM_LIB}/${name}`);
  } else if (a.endsWith('.rcgu.o')) {
    if (!args.includes('{OBJECTS}')) args.push('{OBJECTS}');
  } else if (a.endsWith('.rlib')) {
    const name = path.basename(a);
    fs.copyFileSync(a, path.join(OUT, 'lib/rust', name));
    rustLibs.push(name);
    if (!args.includes('{RUST_LIBS}')) args.push('{RUST_LIBS}');
  } else {
    args.push(a);
  }
}
// Before the system libraries, whose weak stubs it overrides.
execFileSync('emcc', ['-c', '-O2', path.join(RUNTIME_SRC, 'process.c'), '-o', path.join(OUT, 'lib/em/process.o')], { env });
args.splice(args.indexOf('{RUST_LIBS}') + 1, 0, '{EM_LIB}/process.o');
fs.writeFileSync(
  path.join(OUT, 'link.json'),
  JSON.stringify({ target: TARGET, settings: EMCC_SETTINGS, args, rustLibs }, null, 2),
);

// The full std, for rustc running in a Worker: object code in .rlib files, crate
// metadata in .rmeta files.
const stdDir = path.join(SYSROOT, 'lib/rustlib', TARGET, 'lib');
const sysrootStd = path.join(OUT, 'sysroot/lib/rustlib', TARGET, 'lib');
fs.mkdirSync(sysrootStd, { recursive: true });
for (const f of fs.readdirSync(stdDir).filter((f) => f.endsWith('.rlib') || f.endsWith('.rmeta'))) {
  fs.copyFileSync(path.join(stdDir, f), path.join(sysrootStd, f));
}

// 3. Make the glue generic.
let glue = fs.readFileSync(path.join(work, 'reference.mjs'), 'utf8');
const stub = fs.readFileSync(path.join(OUT, 'js_symbols.stub'), 'utf8');
const symbols = stub.split('\n').slice(1).map((l) => l.split(':')[0].trim()).filter(Boolean);

// emcc lists only the imports the reference program happens to use. Replace that with
// every JS library function, so any program linked against js_symbols.stub finds its
// imports. Unused entries are ignored by WebAssembly.instantiate.
const importsStart = glue.indexOf('var wasmImports = {');
const importsEnd = glue.indexOf('};', importsStart) + 2;
if (importsStart < 0) throw new Error('wasmImports not found in glue');
const entries = symbols
  .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s))
  .filter((s) => new RegExp(`(?:function|var|let|const)\\s+_${escape(s)}\\b`).test(glue))
  .map((s) => `  ${s}: _${s}`);
glue = `${glue.slice(0, importsStart)}var wasmImports = {\n${entries.join(',\n')}\n};${glue.slice(importsEnd)}`;

// Drop "run as main script under node", which reads process.argv[1].
glue = glue.replace(
  /\/\/ When run as the main script under node[\s\S]*?(?=\/\/ end include: postamble\.js)/,
  '',
);
// Workers module URLs are not file: URLs; nothing here should depend on them.
glue = glue.replaceAll('import.meta.url', '"file:///bundle/runtime.mjs"');
fs.writeFileSync(path.join(OUT, 'runtime.mjs'), glue);

// 4. Test fixtures: object files for a few programs, as rustc -Zno-link would hand them over.
const FIXTURES = path.join(ROOT, 'test/fixtures');
for (const f of fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.rs'))) {
  const name = path.basename(f, '.rs');
  const dir = path.join(work, `fx-${name}`);
  fs.mkdirSync(dir);
  execFileSync(
    'rustc',
    ['--target', TARGET, `--sysroot=${SYSROOT}`, '-Copt-level=0', '-Zno-link', path.join(FIXTURES, f), '-o', path.join(dir, name)],
    { env: { ...env, RUSTC_BOOTSTRAP: '1' }, cwd: dir, stdio: 'inherit' },
  );
  const objects = fs.readdirSync(dir).filter((o) => o.endsWith('.o')).sort();
  fs.mkdirSync(path.join(OUT, 'fixtures', name), { recursive: true });
  for (const o of objects) fs.copyFileSync(path.join(dir, o), path.join(OUT, 'fixtures', name, o));
}

const size = (p) => fs.readdirSync(p).reduce((n, f) => n + fs.statSync(path.join(p, f)).size, 0);
console.log(`runtime.mjs   ${(fs.statSync(path.join(OUT, 'runtime.mjs')).size / 1024).toFixed(0)} KiB, ${entries.length} imports`);
console.log(`lib/em        ${(size(path.join(OUT, 'lib/em')) / 1048576).toFixed(1)} MiB`);
console.log(`lib/rust      ${(size(path.join(OUT, 'lib/rust')) / 1048576).toFixed(1)} MiB`);
console.log(`link.json     ${args.length} args, ${rustLibs.length} rlibs`);

function escape(s) {
  return s.replace(/[$]/g, '\\$');
}
