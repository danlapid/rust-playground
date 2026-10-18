// What's worth keeping between requests, behind Workers Cache: the `Cached` entrypoint's
// GET responses are cached by Cloudflare (see wrangler.jsonc), tiered and shared across
// deploys. The playground calls it through its loopback binding, `exports.Cached`. What's
// expensive to make is stored in R2, and Workers Cache serves it from there.
import { WorkerEntrypoint, env, exports, waitUntil } from 'cloudflare:workers';
import { buildDependencies, type CachedUnit, depsKey, type DepsResult, r2Cache, readUnit } from './cargo/build';
import { type BlobCache, CratesIo } from './cargo/registry';
import { type DepSpec, type Package, type Resolution, resolve } from './cargo/resolve';
import type { Emit, Outcome } from './events';

const cacheControl = {
  /** Index files change as crates are published; serve a stale resolution while refreshing. */
  resolve: 'public, max-age=600, stale-while-revalidate=86400',
  immutable: 'public, max-age=31536000, immutable',
  none: 'no-store',
};

/** Where things made once are stored in R2, by route. */
const STORED: Record<string, string> = { deps: 'deps', build: 'builds' };

export class Cached extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, route, ...rest] = url.pathname.split('/');
    const missing = () => new Response(null, { status: 404, headers: { 'cache-control': cacheControl.none } });
    try {
      if (route === 'resolve') {
        const deps = JSON.parse(url.searchParams.get('deps')!) as DepSpec[];
        let resolution: Resolution;
        try {
          resolution = await resolve(new CratesIo(r2Cache(this.env.ARTIFACTS)), deps);
        } catch (e) {
          return new Response((e as Error).message, { status: 422, headers: { 'cache-control': cacheControl.none } });
        }
        const body = JSON.stringify({ root: resolution.root, packages: [...resolution.packages.values()] });
        return new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': cacheControl.resolve } });
      }
      if (route === 'unit') {
        // A built crate's artifacts, in one response: they never change, being keyed by a
        // hash of everything that went into them.
        const unit = await readUnit(r2Cache(this.env.ARTIFACTS), rest[0]);
        if (!unit) return missing();
        return new Response(pack(unit), { headers: { 'cache-control': cacheControl.immutable } });
      }
      if (route in STORED) {
        // Everything a snippet's dependencies built to, or what the snippet compiled to,
        // keyed by everything that went into it.
        const object = await this.env.ARTIFACTS.get(`${STORED[route]}/${rest[0]}`);
        if (!object) return missing();
        return new Response(object.body, { headers: { 'cache-control': cacheControl.immutable } });
      }
      return new Response('not found', { status: 404, headers: { 'cache-control': cacheControl.none } });
    } catch (e) {
      console.error(e);
      return new Response(e instanceof Error ? `${e.name}: ${e.message}` : String(e), {
        status: 500,
        headers: { 'cache-control': cacheControl.none },
      });
    }
  }
}

const cached = (path: string) =>
  exports.Cached.fetch(`http://cache${path}`).catch((e) => {
    throw new Error(`the cache (${path.split('?')[0]}): ${e instanceof Error ? e.message : e}`);
  });

/** How long a cache hit takes, at most, in practice. */
const HIT_MS = 50;

/**
 * What the cache has, or what `local` gets if the cache is slow to answer. A miss runs
 * this Worker to fill the cache, maybe in another data center, which takes much longer
 * than reading R2 here. So unless the cache answers quickly, `local` runs too, and the
 * first to succeed wins; the cache's carries on, and fills it for next time. Either
 * failing falls back to the other.
 */
async function hedged<T>(fromCache: Promise<T>, local: () => Promise<T>): Promise<T> {
  const late = Symbol();
  const first = await Promise.race([fromCache.catch((): typeof late => late), new Promise<typeof late>((r) => setTimeout(() => r(late), HIT_MS))]);
  if (first !== late) return first;
  try {
    return await Promise.any([fromCache, local()]);
  } catch (e) {
    // Both failed: local's error is the one about the thing itself.
    throw (e as AggregateError).errors[1];
  }
}

/** Whether Workers Cache answered, rather than running the entrypoint to answer. */
const hit = (res: Response) => /^(HIT|STALE|UPDATING|REVALIDATED)$/i.test(res.headers.get('cf-cache-status') ?? '');

interface Looked<T> {
  value: T;
  hit: boolean;
}

/** A lookup's outcome: what isn't found is made; what the cache didn't have came from R2. */
const outcome = ({ value, hit }: Looked<unknown>): Outcome => (value === undefined ? 'miss' : hit ? 'hit' : 'r2');

/** Gets something stored in R2 (see STORED), through the cache. */
async function stored<T>(route: string, key: string) {
  const fromCache = cached(`/${route}/${key}`).then(async (res): Promise<Looked<T | undefined>> => {
    if (res.status === 404) return { value: undefined, hit: false };
    if (!res.ok) throw new Error(`cache: ${res.status} for ${route} ${key}: ${await res.text()}`);
    return { value: unpack<T>(new Uint8Array(await res.arrayBuffer())), hit: hit(res) };
  });
  const value = await hedged(fromCache, async () => {
    const bytes = await r2Cache(env.ARTIFACTS).get(`${STORED[route]}/${key}`);
    return { value: bytes ? unpack<T>(bytes) : undefined, hit: false };
  });
  return { value: value.value, outcome: outcome(value) };
}

/** Stores something for `stored`, after the response if need be. */
function store(route: string, key: string, value: unknown) {
  waitUntil(r2Cache(env.ARTIFACTS).put(`${STORED[route]}/${key}`, pack(value)));
}

/** A built crate, if it was built before. */
async function cachedUnit(r2: BlobCache, hash: string) {
  const fromCache = cached(`/unit/${hash}`).then(async (res): Promise<Looked<CachedUnit | undefined>> => {
    if (res.status === 404) return { value: undefined, hit: false };
    if (!res.ok) throw new Error(`cache: ${res.status} for unit ${hash}: ${await res.text()}`);
    return { value: unpack<CachedUnit>(new Uint8Array(await res.arrayBuffer())), hit: hit(res) };
  });
  const value = await hedged(fromCache, async () => ({ value: await readUnit(r2, hash), hit: false }));
  return { unit: value.value, outcome: outcome(value) };
}

/** Resolves dependencies, or throws with why they don't resolve. */
export async function cachedResolve(deps: DepSpec[]) {
  const fromCache = cached(`/resolve?deps=${encodeURIComponent(JSON.stringify(deps))}`).then(async (res) => {
    if (!res.ok) throw new Error(await res.text());
    const { root, packages } = (await res.json()) as { root: Resolution['root']; packages: Package[] };
    return { value: { root, packages: new Map(packages.map((p) => [p.id, p])) }, hit: hit(res) };
  });
  const value = await hedged(fromCache, async () => ({ value: await resolve(new CratesIo(r2Cache(env.ARTIFACTS)), deps), hit: false }));
  // Resolved from the index, here or by the entrypoint, unless the cache had it.
  return { resolution: value.value, outcome: value.hit ? ('hit' as const) : ('miss' as const) };
}

/** A snippet's build (see pipeline.ts), if it was built before. */
export const cachedBuild = <T>(key: string) => stored<T>('build', key);

/** Keeps a snippet's build for `cachedBuild`. */
export const storeBuild = (key: string, build: unknown) => store('build', key, build);

/** Builds resolved dependencies, or gets them from the last time they were built. */
export async function cachedDeps(resolution: Resolution, optLevel: string, emit: Emit): Promise<DepsResult & { key: string }> {
  const key = await depsKey(resolution, optLevel);
  const t0 = performance.now();
  const found = await stored<DepsResult>('deps', key);
  emit({ type: 'cache', what: 'deps', outcome: found.outcome, ms: performance.now() - t0 });
  if (found.value) {
    // Every crate came with it.
    const ms = performance.now() - t0;
    const units = found.value.units.map((u) => ({ ...u, cached: true, start: 0, ms }));
    for (const { id, procMacro, buildScript } of units) {
      emit({ type: 'unit', id, state: 'start', procMacro, buildScript });
      emit({ type: 'unit', id, state: 'end', ok: true, cached: true, procMacro, buildScript });
    }
    return { ...found.value, units, key };
  }
  const r2 = r2Cache(env.ARTIFACTS);
  const result = await buildDependencies(env, new CratesIo(r2), resolution, {
    optLevel,
    cache: r2,
    readUnit: (hash) => cachedUnit(r2, hash),
    emit,
  });
  if (result.ok) store('deps', key, result);
  return { ...result, key };
}

/** JSON with its byte arrays stored after it, as they are: a u32 length, the JSON, the bytes. */
function pack(value: unknown): Uint8Array {
  const blobs: Uint8Array[] = [];
  let size = 0;
  const json = new TextEncoder().encode(
    JSON.stringify(value, (_, v) => {
      if (!(v instanceof Uint8Array)) return v;
      blobs.push(v);
      size += v.length;
      return { $bytes: [size - v.length, v.length] };
    }),
  );
  const out = new Uint8Array(4 + json.length + size);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  let at = 4 + json.length;
  for (const b of blobs) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

function unpack<T>(bytes: Uint8Array): T {
  const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
  const base = 4 + length;
  return JSON.parse(new TextDecoder().decode(bytes.subarray(4, base)), (_, v) =>
    // Copies, not views: sending a view over RPC would send all of `bytes`.
    v && typeof v === 'object' && Array.isArray(v.$bytes) ? bytes.slice(base + v.$bytes[0], base + v.$bytes[0] + v.$bytes[1]) : v,
  );
}
