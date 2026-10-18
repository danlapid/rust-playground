// crates.io: the sparse index and .crate downloads.
import { sha256 } from '../hash';

export interface IndexDep {
  /** The name the dependent uses (differs from `package` when renamed). */
  name: string;
  req: string;
  features: string[];
  optional: boolean;
  default_features: boolean;
  target: string | null;
  kind: 'normal' | 'dev' | 'build' | null;
  package?: string;
}

export interface IndexEntry {
  name: string;
  vers: string;
  deps: IndexDep[];
  cksum: string;
  features: Record<string, string[]>;
  features2?: Record<string, string[]>;
  yanked: boolean;
  links?: string | null;
  rust_version?: string | null;
}

/** Where index files and .crate files are kept between requests (R2 in the Worker). */
export interface BlobCache {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
}

export interface Registry {
  versions(name: string): Promise<IndexEntry[]>;
  download(entry: IndexEntry): Promise<Uint8Array>;
}

function indexPath(name: string) {
  const n = name.toLowerCase();
  if (n.length <= 2) return `${n.length}/${n}`;
  if (n.length === 3) return `3/${n[0]}/${n}`;
  return `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
}

/** Index files are kept this long before being fetched again. */
const INDEX_TTL_MS = 10 * 60_000;

export class CratesIo implements Registry {
  #index = new Map<string, Promise<IndexEntry[]>>();

  constructor(private cache?: BlobCache) {}

  versions(name: string): Promise<IndexEntry[]> {
    let entries = this.#index.get(name);
    if (!entries) {
      entries = this.#fetchIndex(name);
      this.#index.set(name, entries);
    }
    return entries;
  }

  async #fetchIndex(name: string): Promise<IndexEntry[]> {
    const key = `index/${indexPath(name)}`;
    let text: string | undefined;
    const cached = await this.cache?.get(key);
    if (cached) {
      const nl = cached.indexOf(10);
      const fetchedAt = Number(new TextDecoder().decode(cached.subarray(0, nl)));
      if (Date.now() - fetchedAt < INDEX_TTL_MS) text = new TextDecoder().decode(cached.subarray(nl + 1));
    }
    if (text === undefined) {
      const res = await fetch(`https://index.crates.io/${indexPath(name)}`);
      if (res.status === 404) throw new Error(`no crate named \`${name}\` on crates.io`);
      if (!res.ok) throw new Error(`crates.io index: ${res.status} for ${name}`);
      text = await res.text();
      await this.cache?.put(key, new TextEncoder().encode(`${Date.now()}\n${text}`));
    }
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const e = JSON.parse(line) as IndexEntry;
        return { ...e, features: { ...e.features, ...e.features2 } };
      });
  }

  async download(entry: IndexEntry): Promise<Uint8Array> {
    const key = `crates/${entry.name}/${entry.name}-${entry.vers}.crate`;
    let bytes = await this.cache?.get(key);
    if (!bytes) {
      const res = await fetch(`https://static.crates.io/${key}`);
      if (!res.ok) throw new Error(`crates.io: ${res.status} downloading ${entry.name} ${entry.vers}`);
      bytes = new Uint8Array(await res.arrayBuffer());
      if ((await sha256(bytes)) !== entry.cksum) {
        throw new Error(`checksum mismatch for ${entry.name} ${entry.vers}`);
      }
      await this.cache?.put(key, bytes);
    }
    return bytes;
  }
}
