// Crate metadata as compressed pages, and files in rustc's filesystem that are read
// through them. rustc reads metadata a page at a time (see toolchain/rustc-patches), so
// only the pages it decodes are ever inflated. Plain TypeScript (erasable syntax only),
// so that Node can run it too, for try-rustc.
import { deflateSync, inflateSync } from 'fflate';

/** The size of the pages: the size rustc reads metadata in. */
export const PAGE = 16 * 1024;

/**
 * A file compressed a page at a time, in one buffer: its size, the number of pages, where
 * each page starts (and the last ends), all u32 little-endian, then the pages.
 */
export function compressPages(data: Uint8Array): Uint8Array {
  const pages: Uint8Array[] = [];
  for (let pos = 0; pos < data.length; pos += PAGE) pages.push(deflateSync(data.subarray(pos, pos + PAGE), { level: 6 }));
  const header = 4 * (2 + pages.length + 1);
  const out = new Uint8Array(header + pages.reduce((n, p) => n + p.length, 0));
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, true);
  view.setUint32(4, pages.length, true);
  let at = header;
  pages.forEach((p, i) => {
    view.setUint32(8 + 4 * i, at, true);
    out.set(p, at);
    at += p.length;
  });
  view.setUint32(8 + 4 * pages.length, at, true);
  return out;
}

// Pages are inflated into one buffer, and a read within a page (most are) returns a view
// of it: no garbage, which counts against a Worker's memory limit until it's collected.
// The view is only good until the next read; the caller copies it into rustc's memory.
const scratch = new Uint8Array(PAGE);

/** Reads `length` bytes at `position` of a `size`-byte file, from its compressed pages. */
export function readPages(size: number, page: (index: number) => Uint8Array, position: number, length: number): Uint8Array {
  const end = Math.min(position + length, size);
  const first = Math.floor(position / PAGE);
  if (end <= (first + 1) * PAGE) {
    return inflateSync(page(first), { out: scratch }).subarray(position - first * PAGE, end - first * PAGE);
  }
  const out = new Uint8Array(Math.max(0, end - position));
  for (let p = first; p * PAGE < end; p++) {
    const bytes = inflateSync(page(p), { out: scratch });
    const from = Math.max(position, p * PAGE);
    const to = Math.min(end, (p + 1) * PAGE);
    out.set(bytes.subarray(from - p * PAGE, to - p * PAGE), from - position);
  }
  return out;
}

/** A file from `compressPages`: its size, and its pages. */
function pagedFile(blob: Uint8Array) {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const size = view.getUint32(0, true);
  const offset = (p: number) => view.getUint32(8 + 4 * p, true);
  return { size, page: (p: number) => blob.subarray(offset(p), offset(p + 1)) };
}

// Emscripten's errno values.
const EIO = 29;
const ENODEV = 43;

/**
 * Creates a file at `path` whose bytes rustc gets from `read` (see
 * toolchain/rustc/remote-files.js): rustc suspends until the promise resolves, so `read`
 * can fetch them, but it should rarely have to (see sysroot.ts).
 */
export function mountRemote(FS: any, path: string, size: number, read: (position: number, length: number) => Promise<Uint8Array>) {
  FS.mkdirTree(path.slice(0, path.lastIndexOf('/')) || '/');
  FS.writeFile(path, new Uint8Array(0));
  const node = FS.lookupPath(path).node;
  node.usedBytes = size;
  node.remote = { read, pending: null };
  node.stream_ops = {
    ...node.stream_ops,
    // Copies in the bytes remote-files.js got from `read`.
    read(stream: any, buffer: Uint8Array, offset: number, length: number, position: number) {
      const fetched = stream.node.remote.pending;
      const start = position - (fetched?.position ?? 0);
      if (!fetched || start < 0 || start + length > fetched.bytes.length) throw new FS.ErrnoError(EIO);
      buffer.set(fetched.bytes.subarray(start, start + length), offset);
      return length;
    },
    mmap() {
      throw new FS.ErrnoError(ENODEV);
    },
  };
}

/** Creates `path` from a `compressPages` buffer, read in place. */
export function mountPaged(FS: any, path: string, blob: Uint8Array) {
  const file = pagedFile(blob);
  mountRemote(FS, path, file.size, async (position, length) => readPages(file.size, file.page, position, length));
}
