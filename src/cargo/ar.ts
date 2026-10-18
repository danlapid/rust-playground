// Just enough of the ar format for rlibs, which are archives of object files and a
// `lib.rmeta` member (the crate's metadata, or with -Zembed-metadata=no a stub naming it).

const MAGIC = '!<arch>\n';
const HEADER = 60;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** The member `name` of the archive, or undefined. */
function member(archive: Uint8Array, name: string): Uint8Array | undefined {
  if (dec.decode(archive.subarray(0, MAGIC.length)) !== MAGIC) throw new Error('not an ar archive');
  for (let pos = MAGIC.length; pos + HEADER <= archive.length; ) {
    const header = dec.decode(archive.subarray(pos, pos + HEADER));
    const size = Number(header.slice(48, 58).trim());
    // GNU archives end short names with '/'; BSD ones pad with spaces.
    if (header.slice(0, 16).trim().replace(/\/$/, '') === name) return archive.subarray(pos + HEADER, pos + HEADER + size);
    pos += HEADER + size + (size % 2);
  }
}

/**
 * An rlib with only the original's `lib.rmeta`. Compiling a program that depends on a
 * crate needs the crate's rlib, but rustc that stops before linking (-Zno-link) only
 * reads that member of it: the object code goes to the linker instead.
 */
export function stubRlib(rlib: Uint8Array): Uint8Array {
  const rmeta = member(rlib, 'lib.rmeta');
  if (!rmeta) throw new Error('rlib has no lib.rmeta');
  const field = (s: string, n: number) => s.padEnd(n, ' ');
  const header = field('lib.rmeta/', 16) + field('0', 12) + field('0', 6) + field('0', 6) + field('644', 8) + field(String(rmeta.length), 10) + '`\n';
  const out = new Uint8Array(MAGIC.length + HEADER + rmeta.length + (rmeta.length % 2));
  out.set(enc.encode(MAGIC + header));
  out.set(rmeta, MAGIC.length + HEADER);
  if (rmeta.length % 2) out[out.length - 1] = 0x0a;
  return out;
}
