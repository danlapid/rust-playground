// Versions and version requirements, with Cargo's semantics.

export interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

export function parseVersion(s: string): Version {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s.trim());
  if (!m) throw new Error(`invalid version: ${s}`);
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

function comparePre(a: string[], b: string[]): number {
  if (!a.length || !b.length) return b.length - a.length; // a release sorts after its prereleases
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const [x, y] = [a[i], b[i]];
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny) {
      if (+x !== +y) return +x - +y;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return a.length - b.length;
}

export function compare(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || comparePre(a.pre, b.pre);
}

/**
 * Versions that Cargo considers compatible share a key, and only one version per key is
 * built: `1.x.y` → `1`, `0.3.y` → `0.3`, `0.0.4` → `0.0.4`.
 */
export function compatKey(v: Version): string {
  return v.major > 0 ? `${v.major}` : v.minor > 0 ? `0.${v.minor}` : `0.0.${v.patch}`;
}

interface Comparator {
  op: '=' | '>' | '>=' | '<' | '<=' | '~' | '^';
  major: number;
  minor?: number;
  patch?: number;
  pre: string[];
}

type VersionReq = Comparator[];

export function parseReq(s: string): VersionReq {
  s = s.trim();
  if (s === '' || s === '*') return [];
  return s.split(',').flatMap((part): Comparator[] => {
    const m = /^\s*(=|>=|>|<=|<|~|\^)?\s*(\d+|\*|x|X)(?:\.(\d+|\*|x|X))?(?:\.(\d+|\*|x|X))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(part);
    if (!m) throw new Error(`invalid version requirement: ${s}`);
    const num = (x: string | undefined) => (x === undefined || /^[*xX]$/.test(x) ? undefined : +x);
    const major = num(m[2]);
    if (major === undefined) return []; // `*`
    const minor = num(m[3]);
    // A wildcard in a later position is the same as omitting it.
    const patch = minor === undefined ? undefined : num(m[4]);
    return [{ op: (m[1] ?? '^') as Comparator['op'], major, minor, patch, pre: m[5] ? m[5].split('.') : [] }];
  });
}

function matchesComparator(c: Comparator, v: Version): boolean {
  const lower: Version = { major: c.major, minor: c.minor ?? 0, patch: c.patch ?? 0, pre: c.pre };
  const cmp = compare(v, lower);
  switch (c.op) {
    case '=':
      return c.patch !== undefined
        ? cmp === 0
        : v.major === c.major && (c.minor === undefined || v.minor === c.minor);
    case '>':
      if (c.patch !== undefined) return cmp > 0;
      return c.minor !== undefined
        ? v.major > c.major || (v.major === c.major && v.minor > c.minor)
        : v.major > c.major;
    case '>=':
      return cmp >= 0;
    case '<':
      return cmp < 0;
    case '<=':
      if (c.patch !== undefined) return cmp <= 0;
      return c.minor !== undefined
        ? v.major < c.major || (v.major === c.major && v.minor <= c.minor)
        : v.major <= c.major;
    case '~':
      return cmp >= 0 && v.major === c.major && (c.minor === undefined || v.minor === c.minor);
    case '^':
      if (cmp < 0) return false;
      if (c.major > 0 || c.minor === undefined) return v.major === c.major;
      if (c.minor > 0 || c.patch === undefined) return v.major === 0 && v.minor === c.minor;
      return v.major === 0 && v.minor === 0 && v.patch === c.patch;
  }
}

export function matches(req: VersionReq, v: Version): boolean {
  if (!req.every((c) => matchesComparator(c, v))) return false;
  // Prereleases only match a requirement that names a prerelease of the same version.
  return (
    !v.pre.length ||
    req.some((c) => c.pre.length && c.major === v.major && c.minor === v.minor && c.patch === v.patch)
  );
}
