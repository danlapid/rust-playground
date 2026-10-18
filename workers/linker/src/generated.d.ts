declare module '*/generated/lld.mjs' {
  const createLld: (options: Record<string, unknown>) => Promise<any>;
  export default createLld;
}
declare module '*/generated/lld.wasm' {
  const module: WebAssembly.Module;
  export default module;
}
declare module '*/generated/link.json' {
  const link: { target: string; args: string[]; rustLibs: string[] };
  export default link;
}
