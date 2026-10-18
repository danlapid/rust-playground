// Dependency resolution: versions and features, roughly as Cargo does it for one target
// (build scripts and proc macros also run on wasm32-unknown-emscripten here, so host and
// target dependencies unify into one graph).
import { targetMatches } from './cfg';
import type { IndexDep, IndexEntry, Registry } from './registry';
import { compare, compatKey, matches, parseReq, parseVersion, type Version } from './semver';

/** The Rust version of the playground's compiler, for `rust-version`-aware resolution. */
const RUST_VERSION = parseVersion('1.98.1');

export interface DepSpec {
  /** The name the dependent uses for it (the key in `[dependencies]`). */
  name: string;
  /** The crate on crates.io, if renamed. */
  package?: string;
  req: string;
  features?: string[];
  defaultFeatures?: boolean;
  optional?: boolean;
  target?: string | null;
  kind?: 'normal' | 'build' | 'dev' | null;
}

export interface Edge {
  /** The dependency's name in the dependent (`--extern` name, if it was renamed). */
  name: string;
  renamed: boolean;
  id: string;
  kind: 'normal' | 'build';
}

export interface Package {
  id: string;
  name: string;
  version: string;
  entry: IndexEntry;
  features: string[];
  deps: Edge[];
}

export interface Resolution {
  root: Edge[];
  packages: Map<string, Package>;
}

class Restart extends Error {}

interface Node {
  entry: IndexEntry;
  version: Version;
  features: Set<string>;
  enabledOptional: Set<string>;
  /** Features to enable on a dependency (by name in this package) once it is active. */
  depFeatures: Map<string, Set<string>>;
  edges: Map<string, Edge>;
}

const toDepSpec = (d: IndexDep): DepSpec => ({
  name: d.name,
  package: d.package,
  req: d.req,
  features: d.features,
  defaultFeatures: d.default_features,
  optional: d.optional,
  target: d.target,
  kind: d.kind,
});

export async function resolve(registry: Registry, rootDeps: DepSpec[]): Promise<Resolution> {
  // Versions chosen to satisfy several requirements in one semver-compatible slot.
  const preferred = new Map<string, string>();
  for (let attempt = 0; ; attempt++) {
    try {
      return await resolveOnce(registry, rootDeps, preferred);
    } catch (e) {
      if (!(e instanceof Restart) || attempt > 20) throw e;
    }
  }
}

async function resolveOnce(registry: Registry, rootDeps: DepSpec[], preferred: Map<string, string>) {
  const nodes = new Map<string, Node>(); // by id
  const reqsBySlot = new Map<string, string[]>();
  const queue: (() => Promise<void>)[] = [];
  const root: Edge[] = [];

  const applicable = (d: DepSpec) => d.kind !== 'dev' && targetMatches(d.target);

  async function pick(name: string, req: string): Promise<Node> {
    const parsed = parseReq(req);
    for (const node of nodes.values()) {
      if (node.entry.name === name && matches(parsed, node.version)) return node;
    }
    const candidates = (await registry.versions(name))
      .filter((e) => !e.yanked)
      .map((e) => ({ e, v: parseVersion(e.vers) }))
      .filter(({ v }) => matches(parsed, v))
      .sort((a, b) => compare(b.v, a.v));
    if (!candidates.length) throw new Error(`no version of \`${name}\` matches \`${req}\``);
    const supported = candidates.filter(
      ({ e }) => !e.rust_version || compare(parseVersion(normalize(e.rust_version)), RUST_VERSION) <= 0,
    );
    let chosen = (supported.length ? supported : candidates)[0];
    const slot = `${name}@${compatKey(chosen.v)}`;
    const pin = preferred.get(slot);
    if (pin) chosen = candidates.find(({ e }) => e.vers === pin) ?? chosen;

    const reqs = [...(reqsBySlot.get(slot) ?? []), req];
    reqsBySlot.set(slot, reqs);
    const sameSlot = [...nodes.values()].find(
      (n) => n.entry.name === name && compatKey(n.version) === compatKey(chosen.v),
    );
    if (sameSlot) {
      // Two requirements picked different versions in one slot: settle on the newest
      // version that satisfies all of them, and start over.
      const all = reqs.map(parseReq);
      const both = candidates.find(({ v }) => all.every((r) => matches(r, v)));
      if (!both) throw new Error(`conflicting requirements for \`${name}\`: ${reqs.join(', ')}`);
      preferred.set(slot, both.e.vers);
      throw new Restart();
    }

    const node: Node = {
      entry: chosen.e,
      version: chosen.v,
      features: new Set(),
      enabledOptional: new Set(),
      depFeatures: new Map(),
      edges: new Map(),
    };
    nodes.set(`${name}@${chosen.e.vers}`, node);
    for (const dep of node.entry.deps.map(toDepSpec)) {
      if (!dep.optional && applicable(dep)) activate(node, dep);
    }
    return node;
  }

  function depsNamed(node: Node, name: string) {
    return node.entry.deps.map(toDepSpec).filter((d) => d.name === name && applicable(d));
  }

  function activate(parent: Node | null, dep: DepSpec) {
    // Fetch its index file now, alongside the others, rather than when the queue gets to
    // it: the queue picks one package at a time. (`pick` reports the errors.)
    registry.versions(dep.package ?? dep.name).catch(() => {});
    queue.push(async () => {
      const node = await pick(dep.package ?? dep.name, dep.req);
      const id = `${node.entry.name}@${node.entry.vers}`;
      const kind = dep.kind === 'build' ? 'build' : 'normal';
      const edge: Edge = { name: dep.name, renamed: !!dep.package && dep.package !== dep.name, id, kind };
      if (parent) parent.edges.set(`${kind}:${dep.name}`, edge);
      else root.push(edge);
      if (dep.defaultFeatures !== false && 'default' in node.entry.features) enableFeature(node, 'default');
      for (const f of dep.features ?? []) enableFeature(node, f);
      for (const f of parent?.depFeatures.get(dep.name) ?? []) enableFeature(node, f);
    });
  }

  function enableOptional(node: Node, name: string) {
    if (node.enabledOptional.has(name)) return;
    node.enabledOptional.add(name);
    for (const dep of depsNamed(node, name)) if (dep.optional) activate(node, dep);
  }

  function enableDepFeature(node: Node, depName: string, feature: string) {
    let set = node.depFeatures.get(depName);
    if (!set) node.depFeatures.set(depName, (set = new Set()));
    set.add(feature);
    for (const edge of node.edges.values()) {
      if (edge.name === depName) enableFeature(nodes.get(edge.id)!, feature);
    }
  }

  function enableFeature(node: Node, feature: string) {
    if (node.features.has(feature)) return;
    const table = node.entry.features;
    const explicitDeps = new Set(
      Object.values(table).flat().filter((v) => v.startsWith('dep:')).map((v) => v.slice(4)),
    );
    const isOptionalDep = node.entry.deps.some((d) => d.optional && d.name === feature);
    if (!(feature in table) && !(isOptionalDep && !explicitDeps.has(feature))) {
      throw new Error(`\`${node.entry.name}\` ${node.entry.vers} has no feature \`${feature}\``);
    }
    node.features.add(feature);
    // An optional dependency is also a feature of its own name, unless `dep:` is used.
    const values = table[feature] ?? [`dep:${feature}`];
    for (const value of values) {
      const slash = value.indexOf('/');
      if (value.startsWith('dep:')) {
        enableOptional(node, value.slice(4));
      } else if (slash > 0) {
        const weak = value[slash - 1] === '?';
        const depName = value.slice(0, weak ? slash - 1 : slash);
        if (!weak && node.entry.deps.some((d) => d.optional && d.name === depName)) {
          if (!explicitDeps.has(depName) && depName in table) enableFeature(node, depName);
          enableOptional(node, depName);
        }
        enableDepFeature(node, depName, value.slice(slash + 1));
      } else {
        enableFeature(node, value);
      }
    }
  }

  for (const dep of rootDeps) if (applicable(dep)) activate(null, dep);
  while (queue.length) await queue.shift()!();

  const packages = new Map<string, Package>();
  for (const [id, node] of nodes) {
    packages.set(id, {
      id,
      name: node.entry.name,
      version: node.entry.vers,
      entry: node.entry,
      // Including optional dependencies' implicit features: Cargo passes them as cfgs too.
      features: [...node.features].sort(),
      deps: [...node.edges.values()],
    });
  }
  return { root, packages };
}

/** `rust-version` may omit the minor or patch. */
const normalize = (v: string) => [...v.split('.'), '0', '0'].slice(0, 3).join('.');

/** Packages ordered so that every package comes after its dependencies. */
export function buildOrder(resolution: Resolution): Package[] {
  const order: Package[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const pkg = resolution.packages.get(id)!;
    for (const dep of pkg.deps) visit(dep.id);
    order.push(pkg);
  };
  for (const edge of resolution.root) visit(edge.id);
  return order;
}
