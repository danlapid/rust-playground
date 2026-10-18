// .crate files (gzipped tarballs) and the manifests inside them.
import { parse } from 'smol-toml';

export type Files = Record<string, Uint8Array>;

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The files of a .crate, relative to its top directory (`name-version/`). */
export async function unpackCrate(crate: Uint8Array): Promise<Files> {
  const tar = await gunzip(crate);
  const files: Files = {};
  const text = (a: number, b: number) => new TextDecoder().decode(tar.subarray(a, b)).replace(/\0.*$/s, '');
  let longName: string | undefined;
  let paxPath: string | undefined;
  for (let off = 0; off + 512 <= tar.length; ) {
    if (tar[off] === 0) break;
    const size = parseInt(text(off + 124, off + 136).trim() || '0', 8);
    const type = String.fromCharCode(tar[off + 156] || 48);
    const body = tar.subarray(off + 512, off + 512 + size);
    let name = longName ?? paxPath ?? (text(off + 345, off + 500) ? `${text(off + 345, off + 500)}/` : '') + text(off, off + 100);
    longName = paxPath = undefined;
    if (type === 'L') {
      longName = new TextDecoder().decode(body).replace(/\0.*$/s, '');
    } else if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(new TextDecoder().decode(body));
      if (m) paxPath = m[1];
    } else if (type === '0' || type === '7') {
      name = name.replace(/^[^/]+\//, '');
      if (name) files[name] = body.slice();
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

export interface CrateManifest {
  name: string;
  version: string;
  edition: string;
  /** The library target, if any. */
  lib?: { name: string; path: string; procMacro: boolean };
  /** The build script, if any. */
  build?: string;
  links?: string;
  env: Record<string, string>;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export function readManifest(files: Files): CrateManifest {
  const raw = files['Cargo.toml'];
  if (!raw) throw new Error('Cargo.toml missing from crate');
  const toml = parse(new TextDecoder().decode(raw)) as Record<string, any>;
  const pkg = toml.package ?? {};
  const name: string = pkg.name;
  const version: string = pkg.version;
  const edition: string = str(pkg.edition) ?? '2015';
  const lib = toml.lib ?? {};
  const libPath = str(lib.path) ?? (files['src/lib.rs'] ? 'src/lib.rs' : undefined);
  const build =
    pkg.build === false ? undefined : (str(pkg.build) ?? (files['build.rs'] && pkg.autobuild !== false ? 'build.rs' : undefined));
  const [major, minor, patch] = version.split(/[.+-]/);
  const authors = Array.isArray(pkg.authors) ? pkg.authors.join(':') : '';
  return {
    name,
    version,
    edition,
    lib: libPath
      ? { name: (str(lib.name) ?? name).replaceAll('-', '_'), path: libPath, procMacro: !!(lib['proc-macro'] ?? lib.proc_macro) }
      : undefined,
    build,
    links: str(pkg.links),
    // What Cargo sets for rustc (and build scripts), for env!() and friends.
    env: {
      CARGO_PKG_NAME: name,
      CARGO_PKG_VERSION: version,
      CARGO_PKG_VERSION_MAJOR: major,
      CARGO_PKG_VERSION_MINOR: minor,
      CARGO_PKG_VERSION_PATCH: patch,
      CARGO_PKG_VERSION_PRE: version.includes('-') ? version.slice(version.indexOf('-') + 1).split('+')[0] : '',
      CARGO_PKG_AUTHORS: authors,
      CARGO_PKG_DESCRIPTION: str(pkg.description) ?? '',
      CARGO_PKG_HOMEPAGE: str(pkg.homepage) ?? '',
      CARGO_PKG_REPOSITORY: str(pkg.repository) ?? '',
      CARGO_PKG_LICENSE: str(pkg.license) ?? '',
      CARGO_PKG_LICENSE_FILE: str(pkg['license-file']) ?? '',
      CARGO_PKG_RUST_VERSION: str(pkg['rust-version']) ?? '',
      CARGO_PKG_README: str(pkg.readme) ?? '',
    },
  };
}

/**
 * The `[dependencies]` of a snippet, from cargo-script frontmatter at the top of the file:
 *
 *     ---
 *     [dependencies]
 *     rand = "0.8"
 *     ---
 */
export function snippetManifest(code: string): { dependencies: SnippetDep[] } | null {
  // Optionally after a shebang (but not an inner attribute, `#![...]`).
  const m = /^(?:#!(?!\[)[^\n]*\n)?\s*---[^\n]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(code);
  if (!m) return null;
  const toml = parse(m[1]) as Record<string, any>;
  const deps: SnippetDep[] = [];
  const add = (table: Record<string, any> | undefined, target: string | null) => {
    for (const [name, spec] of Object.entries(table ?? {})) {
      const s = typeof spec === 'string' ? { version: spec } : spec;
      if (s.path || s.git) throw new Error(`dependency \`${name}\`: only crates.io dependencies are supported`);
      deps.push({
        name,
        package: s.package,
        req: s.version ?? '*',
        features: s.features ?? [],
        defaultFeatures: s['default-features'] ?? s.default_features ?? true,
        target,
      });
    }
  };
  add(toml.dependencies, null);
  for (const [target, tables] of Object.entries(toml.target ?? {})) add((tables as any).dependencies, target);
  return { dependencies: deps };
}

export interface SnippetDep {
  name: string;
  package?: string;
  req: string;
  features: string[];
  defaultFeatures: boolean;
  target: string | null;
}
