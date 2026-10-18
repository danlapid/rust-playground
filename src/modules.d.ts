declare module '*/runtime.mjs' {
  const source: string;
  export default source;
}
declare module '*/runner/entry.js' {
  const source: string;
  export default source;
}
declare module '*.rs' {
  const source: string;
  export default source;
}
declare module '*/proc-macro/entry.js' {
  const source: string;
  export default source;
}

// JSPI (WebAssembly JavaScript Promise Integration), not yet in TypeScript's lib.
declare namespace WebAssembly {
  class Suspending {
    constructor(fn: (...args: any[]) => Promise<unknown>);
  }
  function promising<F extends (...args: any[]) => unknown>(fn: F): (...args: Parameters<F>) => Promise<ReturnType<F>>;
}
