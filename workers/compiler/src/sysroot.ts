// The sysroot rustc sees: std's object code (.rlib), which the compiler Worker bundles,
// and std's crate metadata (.rmeta), which is its static assets, as compressed pages
// (see paged.ts and toolchain/stage.mjs). Plain TypeScript (erasable syntax only), so that Node can run it too.
import { PAGE, mountRemote, readPages } from './paged.ts';

export interface SysrootManifest {
  /** The library directory, relative to the sysroot. */
  dir: string;
  rlibs: string[];
  /** .rmeta files, with their sizes. */
  rmeta: Record<string, number>;
  /** Where each .rmeta file's compressed pages start in its .z file, and the last one ends. */
  offsets: Record<string, number[]>;
}

/** Reads `length` bytes at `position` of a .rmeta file. */
type ReadMetadata = (name: string, position: number, length: number) => Promise<Uint8Array>;

/** Fetches compressed pages of .rmeta files, by file. */
export type FetchPages = (pages: Record<string, number[]>) => Promise<Record<string, Uint8Array[]>>;

/** Fetches pages from each .rmeta file's .z file, all of its pages: `file(name)`. */
export function pagesFromFiles(manifest: SysrootManifest, file: (name: string) => Promise<Uint8Array>): FetchPages {
  return async (wanted) =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(wanted).map(async ([name, pages]) => {
          const data = await file(name);
          const offsets = manifest.offsets[name];
          return [name, pages.map((p) => data.subarray(offsets[p], offsets[p + 1]))] as const;
        }),
      ),
    );
}

interface CachedPages {
  /** Fetches every page, once, in one request. */
  prefetch(): Promise<void>;
  read: ReadMetadata;
}

/**
 * Reads .rmeta files through a cache of their compressed pages (27 MiB), which lasts as
 * long as the isolate. Prefetch them all before running rustc. Fetching a page as rustc
 * reads it would suspend rustc across I/O, a thousand times or so a compile, and in
 * workerd that holds on to memory until rustc is done: enough to exceed a Worker's limit.
 */
export function cachedPages(manifest: SysrootManifest, fetch: FetchPages): CachedPages {
  const cache = new Map<string, Uint8Array>();
  const key = (name: string, page: number) => `${name}:${page}`;
  const fetchMissing = async (wanted: Record<string, number[]>) => {
    const missing = Object.fromEntries(
      Object.entries(wanted)
        .map(([name, pages]) => [name, pages.filter((p) => !cache.has(key(name, p)))] as const)
        .filter(([, pages]) => pages.length),
    );
    if (!Object.keys(missing).length) return;
    const fetched = await fetch(missing);
    for (const [name, pages] of Object.entries(missing)) pages.forEach((p, i) => cache.set(key(name, p), fetched[name][i]));
  };
  const pagesOf = (name: string) => Array.from({ length: Math.ceil(manifest.rmeta[name] / PAGE) }, (_, p) => p);
  let fetched: Promise<void> | undefined;
  const prefetch = () =>
    (fetched ??= fetchMissing(Object.fromEntries(Object.keys(manifest.rmeta).map((name) => [name, pagesOf(name)]))).catch((e) => {
      fetched = undefined;
      throw e;
    }));
  const read: ReadMetadata = async (name, position, length) => {
    const size = manifest.rmeta[name];
    const wanted = pagesOf(name).filter((p) => p * PAGE < Math.min(position + length, size) && (p + 1) * PAGE > position);
    await fetchMissing({ [name]: wanted });
    return readPages(size, (p) => cache.get(key(name, p))!, position, length);
  };
  return { prefetch, read };
}

/** Creates the sysroot at `root` in rustc's filesystem. */
export function mountSysroot(
  FS: any,
  root: string,
  manifest: SysrootManifest,
  rlib: (name: string) => Uint8Array,
  read: ReadMetadata,
) {
  const dir = `${root}/${manifest.dir}`;
  FS.mkdirTree(dir);
  // Owned, not copied: nothing writes to them.
  for (const name of manifest.rlibs) FS.writeFile(`${dir}/${name}`, rlib(name), { canOwn: true });
  for (const [name, size] of Object.entries(manifest.rmeta)) {
    mountRemote(FS, `${dir}/${name}`, size, (position, length) => read(name, position, length));
  }
}
