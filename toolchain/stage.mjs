// Copies build outputs from dist/ into the Workers that bundle them.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const dist = (...p) => path.join(ROOT, 'dist', ...p);

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

// Types for an emscripten factory module (MODULARIZE + EXPORT_ES6).
function declareFactory(file) {
  fs.writeFileSync(
    file.replace(/\.mjs$/, '.d.mts'),
    'declare const create: (options: Record<string, unknown>) => Promise<any>;\nexport default create;\n',
  );
}

// rustc reads crate metadata in 16 KiB pages (see toolchain/rustc-patches); it's
// compressed in pages of the same size, so that reading one inflates one.
const PAGE = 16 * 1024;

const linker = path.join(ROOT, 'workers/linker/src/generated');
fs.rmSync(linker, { recursive: true, force: true });
copy(dist('linker/lld.mjs'), path.join(linker, 'lld.mjs'));
declareFactory(path.join(linker, 'lld.mjs'));
copy(dist('linker/lld.wasm'), path.join(linker, 'lld.wasm'));
copy(dist('toolchain/link.json'), path.join(linker, 'link.json'));
copy(dist('toolchain/js_symbols.stub'), path.join(linker, 'js_symbols.stub'));
copy(dist('toolchain/lib/em'), path.join(linker, 'em'));
copy(dist('toolchain/lib/rust'), path.join(linker, 'rust'));
console.log('staged workers/linker/src/generated');

// The compiler needs the whole std (toolchain/build-std.sh), plus what its in-process
// wasm-ld links against. It bundles std's object code (.rlib). The crate metadata (.rmeta,
// 75 MiB) doesn't fit beside rustc, so it's the compiler's static assets, compressed a
// page at a time (workers/compiler/src/sysroot.ts).
const STD = 'lib/rustlib/wasm32-unknown-emscripten/lib';
const std = dist('toolchain/sysroot', STD);
const compiler = path.join(ROOT, 'workers/compiler/src/generated');
const assets = path.join(ROOT, 'workers/compiler/assets');
if (fs.existsSync(dist('compiler/rustc.wasm'))) {
  fs.rmSync(compiler, { recursive: true, force: true });
  copy(dist('compiler/rustc.mjs'), path.join(compiler, 'rustc.mjs'));
  declareFactory(path.join(compiler, 'rustc.mjs'));
  copy(dist('compiler/rustc.wasm'), path.join(compiler, 'rustc.wasm'));
  copy(dist('toolchain/link.json'), path.join(compiler, 'link.json'));
  copy(dist('toolchain/js_symbols.stub'), path.join(compiler, 'js_symbols.stub'));
  copy(dist('toolchain/lib/em'), path.join(compiler, 'em'));
  const files = fs.readdirSync(std).sort();
  const rlibs = files.filter((f) => f.endsWith('.rlib'));
  for (const f of rlibs) copy(path.join(std, f), path.join(compiler, 'sysroot', STD, f));
  const rmeta = Object.fromEntries(files.filter((f) => f.endsWith('.rmeta')).map((f) => [f, fs.statSync(path.join(std, f)).size]));

  fs.rmSync(assets, { recursive: true, force: true });
  fs.mkdirSync(path.join(assets, 'sysroot'), { recursive: true });
  // Where each file's compressed pages start, and the last one ends.
  const offsets = {};
  for (const name of Object.keys(rmeta)) {
    const data = fs.readFileSync(path.join(std, name));
    const pages = [];
    for (let pos = 0; pos < data.length; pos += PAGE) {
      pages.push(zlib.deflateRawSync(data.subarray(pos, pos + PAGE), { level: 9 }));
    }
    offsets[name] = [0];
    for (const p of pages) offsets[name].push(offsets[name].at(-1) + p.length);
    fs.writeFileSync(path.join(assets, 'sysroot', `${name}.z`), Buffer.concat(pages));
  }
  fs.writeFileSync(path.join(compiler, 'sysroot.json'), JSON.stringify({ dir: STD, rlibs, rmeta, offsets }, null, 2));
  console.log('staged workers/compiler/src/generated and workers/compiler/assets');
}
