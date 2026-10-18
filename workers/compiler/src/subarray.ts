// In Workers, a typed array is at most as long as the isolate's ArrayBuffer allocator will
// allocate, its 128 MB memory limit, and `subarray` checks its start against that, while
// WebAssembly memory may grow past it. So above 128 MB of rustc's memory, emscripten's
// `HEAP8.subarray(ptr, end)` (in every file write, e.g.) throws "Invalid array buffer
// length". The same view, made with the constructor, doesn't: that's what this falls back
// to. Imported first, so it's in place before emscripten's code runs.

const relative = (index: number | undefined, length: number, otherwise: number) => {
  if (index === undefined) return otherwise;
  const i = Math.trunc(Number(index)) || 0;
  return i < 0 ? Math.max(length + i, 0) : Math.min(i, length);
};

for (const T of [
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
  Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
]) {
  const { subarray } = T.prototype as { subarray(begin?: number, end?: number): ArrayBufferView };
  Object.defineProperty(T.prototype, 'subarray', {
    configurable: true,
    writable: true,
    value: function (this: InstanceType<typeof T>, begin?: number, end?: number) {
      try {
        return subarray.call(this, begin, end);
      } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        const start = relative(begin, this.length, 0);
        const stop = relative(end, this.length, this.length);
        return new T(this.buffer, this.byteOffset + start * T.BYTES_PER_ELEMENT, Math.max(stop - start, 0));
      }
    },
  });
}

export {};
