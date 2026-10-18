import { WorkerEntrypoint } from 'cloudflare:workers';
import createLld from './generated/lld.mjs';
import lldWasm from './generated/lld.wasm';
import link from './generated/link.json';

// Where the sysroot lands in node:fs, through find_additional_modules.
const SYSROOT = '/bundle/generated';

export interface LinkRequest {
  /** Object files (and rlibs) produced by rustc, in link order. */
  objects: Uint8Array[];
}

export interface LinkResult {
  ok: boolean;
  wasm?: Uint8Array;
  diagnostics: string;
}

/** Links wasm32-unknown-emscripten objects into a program with wasm-ld, the way emcc would. */
export class Linker extends WorkerEntrypoint {
  async link({ objects }: LinkRequest): Promise<LinkResult> {
    const diagnostics: string[] = [];
    const lld = await createLld({
      thisProgram: 'wasm-ld',
      print: (text: string) => diagnostics.push(text),
      printErr: (text: string) => diagnostics.push(text),
      instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance) => void) {
        done(new WebAssembly.Instance(lldWasm, imports));
        return {};
      },
    });
    const { FS, NODEFS } = lld;
    // workerd reports /bundle directories as 0444 (no search bit), which emscripten's
    // permission checks reject. Everything here is ours, so skip the checks.
    FS.ignorePermissions = true;
    FS.mkdir('/bundle');
    FS.mount(NODEFS, { root: '/bundle' }, '/bundle');
    FS.mkdir('/work');
    const inputs = objects.map((bytes, i) => {
      const path = `/work/${i}.o`;
      FS.writeFile(path, bytes);
      return path;
    });

    const args = link.args.flatMap((a: string) => {
      if (a === '{OBJECTS}') return inputs;
      if (a === '{RUST_LIBS}') return link.rustLibs.map((l: string) => `${SYSROOT}/rust/${l}`);
      if (a === '{JS_SYMBOLS}') return [`${SYSROOT}/js_symbols.stub`];
      return [a.replace('{EM_LIB}', `${SYSROOT}/em`)];
    });
    let code: number;
    try {
      code = lld.callMain(['-o', '/work/main.wasm', ...args]);
    } catch (e) {
      code = 1;
      diagnostics.push(String(e));
    }
    const ok = code === 0;
    return {
      ok,
      wasm: ok ? FS.readFile('/work/main.wasm') : undefined,
      diagnostics: diagnostics.join('\n'),
    };
  }
}

export default {
  fetch() {
    return new Response('rust-playground linker: use the Linker entrypoint over RPC', { status: 404 });
  },
} satisfies ExportedHandler;
