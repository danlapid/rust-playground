// Main module of the Dynamic Worker that runs one proc-macro module (see
// toolchain/proc-macro/shim.rs) for rustc, which runs in the compiler Worker. Loaded with
// globalOutbound: null: proc macros are arbitrary code from crates.io.
import { WorkerEntrypoint } from 'cloudflare:workers';
import createModule from './runtime.js';
import wasm from './macro.wasm';

let instance;
// The request in flight: its reply comes from rustc, asynchronously.
let current;

async function load() {
  let exports;
  await createModule({
    noInitialRun: true,
    print: (text) => current?.log.push(text),
    printErr: (text) => current?.log.push(text),
    instantiateWasm(imports, done) {
      imports.proc_macro_host = {
        dispatch: new WebAssembly.Suspending(async (ptr, len) => {
          const request = new Uint8Array(exports.memory.buffer, ptr, len).slice();
          const reply = await current.dispatch(request);
          new Uint8Array(exports.memory.buffer, exports.pm_alloc(reply.length), reply.length).set(reply);
          return reply.length;
        }),
      };
      const inst = new WebAssembly.Instance(wasm, imports);
      exports = inst.exports;
      done(inst);
      return {};
    },
  });
  return { exports, run: WebAssembly.promising(exports.pm_run) };
}

export default class ProcMacro extends WorkerEntrypoint {
  async count() {
    instance ??= await load();
    return instance.exports.pm_count();
  }

  /**
   * Runs macro `index` on a bridge input buffer. `dispatch` sends a bridge request to
   * rustc and resolves to its reply.
   */
  async run(index, input, forceShowPanics, dispatch) {
    instance ??= await load();
    const { exports } = instance;
    if (current) throw new Error('proc macro already running');
    current = { dispatch, log: [] };
    try {
      new Uint8Array(exports.memory.buffer, exports.pm_alloc(input.length), input.length).set(input);
      const len = await instance.run(index, forceShowPanics ? 1 : 0);
      return { output: new Uint8Array(exports.memory.buffer, exports.pm_output(), len).slice(), log: current.log };
    } finally {
      current = undefined;
    }
  }
}
