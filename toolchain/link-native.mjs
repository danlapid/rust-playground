// Links objects into a program on the host with rust-lld, using the same link.json the
// linker Worker uses. The tests use it to link fixture programs without the linker Worker.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOOLCHAIN = path.resolve(import.meta.dirname, '../dist/toolchain');

function expandLinkArgs(link, { objects, emLib, rustLib, jsSymbols }) {
  return link.args.flatMap((a) => {
    if (a === '{OBJECTS}') return objects;
    if (a === '{RUST_LIBS}') return link.rustLibs.map((l) => `${rustLib}/${l}`);
    if (a === '{JS_SYMBOLS}') return [jsSymbols];
    return [a.replace('{EM_LIB}', emLib)];
  });
}

export function linkNative(objects) {
  const link = JSON.parse(fs.readFileSync(path.join(TOOLCHAIN, 'link.json'), 'utf8'));
  const sysroot = execFileSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' }).trim();
  const lld = path.join(sysroot, 'lib/rustlib', hostTriple(), 'bin/rust-lld');
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-link-')), 'main.wasm');
  const args = expandLinkArgs(link, {
    objects,
    emLib: path.join(TOOLCHAIN, 'lib/em'),
    rustLib: path.join(TOOLCHAIN, 'lib/rust'),
    jsSymbols: path.join(TOOLCHAIN, 'js_symbols.stub'),
  });
  execFileSync(lld, ['-flavor', 'wasm', '-o', out, ...args], { stdio: 'inherit' });
  return fs.readFileSync(out);
}

export function fixtureObjects(name) {
  const dir = path.join(TOOLCHAIN, 'fixtures', name);
  return fs.readdirSync(dir).sort().map((f) => path.join(dir, f));
}

function hostTriple() {
  return execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.*)$/m)[1];
}
