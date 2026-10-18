// Copies the Emscripten rustc host binary out of the rust build into dist/compiler/,
// with the same fixes as the lld module so it runs in workerd.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOST = 'wasm32-unknown-emscripten';
// Cargo's output: rustc-main.js and its wasm, which cargo names after the crate. (The
// stage1 sysroot step after it expects a native binary layout and fails; it is not needed.)
// Bootstrap builds it in a directory named after the machine it ran on (build-rustc.sh).
const build = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)[1];
const dir = path.join(ROOT, `.build/rust/build/${build}/stage1-rustc/${HOST}/release`);
if (!fs.existsSync(path.join(dir, 'rustc_main.wasm'))) throw new Error(`rustc_main.wasm not found in ${dir}`);

const out = path.join(ROOT, 'dist/compiler');
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(dir, 'rustc_main.wasm'), path.join(out, 'rustc.wasm'));
let glue = fs.readFileSync(path.join(dir, 'rustc-main.js'), 'utf8');
// Workers module URLs are not file: URLs; nothing here should depend on them.
glue = glue.replaceAll('import.meta.url', '"file:///bundle/rustc.mjs"');
// workerd has no process.binding(); node:fs exports the same open(2) flags.
glue = glue.replaceAll('process.binding("constants")["fs"]', 'require("node:fs").constants');
fs.writeFileSync(path.join(out, 'rustc.mjs'), glue);
console.log(`rustc.wasm ${(fs.statSync(path.join(out, 'rustc.wasm')).size / 1048576).toFixed(1)} MiB from ${path.relative(ROOT, dir)}`);
