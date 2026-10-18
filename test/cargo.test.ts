import { describe, expect, it } from 'vitest';
import { targetMatches } from '../src/cargo/cfg';
import { snippetManifest, unpackCrate } from '../src/cargo/crate';
import type { IndexDep, IndexEntry, Registry } from '../src/cargo/registry';
import { buildOrder, resolve } from '../src/cargo/resolve';
import { matches, parseReq, parseVersion } from '../src/cargo/semver';

const m = (req: string, v: string) => matches(parseReq(req), parseVersion(v));

describe('semver', () => {
  it('follows Cargo’s requirement semantics', () => {
    expect([m('1.2.3', '1.9.0'), m('1.2.3', '2.0.0'), m('1.2.3', '1.2.2')]).toEqual([true, false, false]);
    expect([m('0.2.3', '0.2.9'), m('0.2.3', '0.3.0')]).toEqual([true, false]);
    expect([m('0.0.3', '0.0.3'), m('0.0.3', '0.0.4')]).toEqual([true, false]);
    expect([m('~1.2', '1.2.9'), m('~1.2', '1.3.0'), m('=1.2', '1.2.5'), m('=1.2.3', '1.2.4')]).toEqual([true, false, true, false]);
    expect([m('>=1.0, <1.5', '1.4.9'), m('>=1.0, <1.5', '1.5.0'), m('*', '7.0.0'), m('1.*', '1.8.0')]).toEqual([true, false, true, true]);
    expect([m('>1.2', '1.2.9'), m('>1.2', '1.3.0'), m('<=1.2', '1.2.9')]).toEqual([false, true, true]);
  });

  it('only matches prereleases that are asked for', () => {
    expect(m('1', '1.5.0-beta.1')).toBe(false);
    expect(m('1.5.0-beta.1', '1.5.0-beta.2')).toBe(true);
    expect(m('1.5.0-beta.1', '1.5.0')).toBe(true);
  });
});

describe('cfg', () => {
  it('evaluates target cfgs for wasm32-unknown-emscripten', () => {
    expect(targetMatches('cfg(unix)')).toBe(true);
    expect(targetMatches('cfg(windows)')).toBe(false);
    expect(targetMatches('cfg(all(target_arch = "wasm32", not(target_os = "unknown")))')).toBe(true);
    expect(targetMatches('cfg(any(target_os = "linux", target_os = "macos"))')).toBe(false);
    expect(targetMatches('wasm32-unknown-emscripten')).toBe(true);
    expect(targetMatches('x86_64-unknown-linux-gnu')).toBe(false);
  });
});

const dep = (name: string, req: string, extra: Partial<IndexDep> = {}): IndexDep => ({
  name, req, features: [], optional: false, default_features: true, target: null, kind: 'normal', ...extra,
});

class FakeRegistry implements Registry {
  constructor(private crates: Record<string, Partial<IndexEntry>[]>) {}
  async versions(name: string) {
    const list = this.crates[name];
    if (!list) throw new Error(`no crate ${name}`);
    return list.map((e) => ({ name, vers: '1.0.0', deps: [], cksum: '', features: {}, yanked: false, ...e }));
  }
  async download(): Promise<Uint8Array> {
    throw new Error('not here');
  }
}

describe('resolver', () => {
  it('picks the newest matching version and unifies features', async () => {
    const reg = new FakeRegistry({
      app: [{ vers: '1.0.0', deps: [dep('lib', '1', { features: ['a'] }), dep('mid', '1')] }],
      mid: [{ vers: '1.0.0', deps: [dep('lib', '1.1', { features: ['b'], default_features: false })] }],
      lib: [
        { vers: '1.0.0', features: { default: [], a: [], b: [] } },
        { vers: '1.2.0', features: { default: ['std'], std: [], a: [], b: [] } },
        { vers: '1.3.0', yanked: true },
        { vers: '2.0.0' },
      ],
    });
    const r = await resolve(reg, [{ name: 'app', req: '1' }]);
    expect([...r.packages.keys()].sort()).toEqual(['app@1.0.0', 'lib@1.2.0', 'mid@1.0.0']);
    expect(r.packages.get('lib@1.2.0')!.features).toEqual(['a', 'b', 'default', 'std']);
    expect(buildOrder(r).map((p) => p.name)).toEqual(['lib', 'mid', 'app']);
  });

  it('enables optional dependencies through features', async () => {
    const reg = new FakeRegistry({
      app: [{
        features: { default: ['json'], json: ['dep:serde_json', 'log?/std'], fast: ['simd/avx'] },
        deps: [
          dep('serde_json', '1', { optional: true }),
          dep('simd', '1', { optional: true }),
          dep('log', '1', { optional: true }),
          dep('winapi', '1', { target: 'cfg(windows)' }),
          dep('tester', '1', { kind: 'dev' }),
        ],
      }],
      serde_json: [{}],
      simd: [{ features: { avx: [] } }],
      log: [{ features: { std: [] } }],
      winapi: [{}],
      tester: [{}],
    });
    const plain = await resolve(reg, [{ name: 'app', req: '1' }]);
    expect([...plain.packages.keys()].sort()).toEqual(['app@1.0.0', 'serde_json@1.0.0']);
    const fast = await resolve(reg, [{ name: 'app', req: '1', features: ['fast'], defaultFeatures: false }]);
    expect([...fast.packages.keys()].sort()).toEqual(['app@1.0.0', 'simd@1.0.0']);
    expect(fast.packages.get('simd@1.0.0')!.features).toEqual(['avx']);
    // `log?/std` does not turn on `log`; the implicit feature `log` does.
    const both = await resolve(reg, [{ name: 'app', req: '1', features: ['log'] }]);
    expect(both.packages.get('log@1.0.0')!.features).toEqual(['std']);
  });

  it('settles one version per compatible range', async () => {
    const reg = new FakeRegistry({
      a: [{ deps: [dep('x', '1.0')] }],
      b: [{ deps: [dep('x', '=1.1.0')] }],
      x: [{ vers: '1.0.0' }, { vers: '1.1.0' }, { vers: '1.2.0' }, { vers: '2.0.0' }],
    });
    const r = await resolve(reg, [{ name: 'a', req: '1' }, { name: 'b', req: '1' }, { name: 'x', req: '2' }]);
    expect([...r.packages.keys()].filter((k) => k.startsWith('x@')).sort()).toEqual(['x@1.1.0', 'x@2.0.0']);
  });

  it('keeps renames and skips versions needing a newer Rust', async () => {
    const reg = new FakeRegistry({
      app: [{ deps: [dep('rand_old', '0.7', { package: 'rand' })] }],
      rand: [{ vers: '0.7.3' }, { vers: '0.7.4', rust_version: '1.99' }],
    });
    const r = await resolve(reg, [{ name: 'app', req: '1' }]);
    expect(r.packages.get('app@1.0.0')!.deps).toEqual([{ name: 'rand_old', renamed: true, id: 'rand@0.7.3', kind: 'normal' }]);
  });
});

describe('snippets', () => {
  it('reads dependencies from cargo-script frontmatter', () => {
    const code = '---\n[dependencies]\nrand = "0.8"\nserde = { version = "1", features = ["derive"] }\n---\nfn main() {}\n';
    expect(snippetManifest(code)?.dependencies.map((d) => [d.name, d.req, d.features])).toEqual([
      ['rand', '0.8', []],
      ['serde', '1', ['derive']],
    ]);
    expect(snippetManifest('fn main() {}\n')).toBeNull();
    expect(snippetManifest('#!/usr/bin/env cargo\n---\n[dependencies]\nx = "1"\n---\n')?.dependencies).toHaveLength(1);
  });

  it('unpacks .crate tarballs', async () => {
    // A tar with one file, `pkg-1.0.0/src/lib.rs`, gzipped.
    const header = new Uint8Array(512);
    const put = (s: string, at: number) => header.set(new TextEncoder().encode(s), at);
    const body = new TextEncoder().encode('pub fn f() {}\n');
    put('pkg-1.0.0/src/lib.rs', 0);
    put('0000644\0', 100);
    put(body.length.toString(8).padStart(11, '0') + '\0', 124);
    put('0', 156);
    put('ustar\0', 257);
    const tar = new Uint8Array(512 + 512 + 1024);
    tar.set(header);
    tar.set(body, 512);
    const gz = new Uint8Array(await new Response(new Blob([tar]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    const files = await unpackCrate(gz);
    expect(Object.keys(files)).toEqual(['src/lib.rs']);
    expect(new TextDecoder().decode(files['src/lib.rs'])).toBe('pub fn f() {}\n');
  });
});
