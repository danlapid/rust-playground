declare module '*/generated/rustc.mjs' {
  const createRustc: (options: Record<string, unknown>) => Promise<any>;
  export default createRustc;
}
declare module '*/generated/rustc.wasm' {
  const module: WebAssembly.Module;
  export default module;
}
declare module '*/generated/link.json' {
  const link: { target: string; args: string[]; rustLibs: string[] };
  export default link;
}
declare module '*/generated/sysroot.json' {
  const manifest: import('./sysroot').SysrootManifest;
  export default manifest;
}
