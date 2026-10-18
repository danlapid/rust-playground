// Main module of the Dynamic Worker that runs one compiled program. It is loaded with
// globalOutbound: null, so the program has no network access.
import { WorkerEntrypoint } from 'cloudflare:workers';
import createModule from './runtime.js';
import wasm from './main.wasm';

function collect(FS, path, out) {
  const { exists, object } = FS.analyzePath(path);
  if (!exists) return;
  if (FS.isDir(object.mode)) {
    for (const name of FS.readdir(path)) {
      if (name !== '.' && name !== '..') collect(FS, `${path}/${name}`, out);
    }
  } else {
    out[path] = FS.readFile(path);
  }
}

/**
 * Children of the program (see toolchain/runtime/process-host.js): `programs` it may
 * start, by path or name, which `spawn` runs (over RPC, outside this sandbox).
 */
function processHost(programs, spawn) {
  const base = (p) => p.slice(p.lastIndexOf('/') + 1);
  const has = (program) => programs.includes(program) || (!program.includes('/') && programs.some((p) => base(p) === program));
  return { has: (program) => !!spawn && has(program), run: (child) => spawn(child) };
}

export default class Runner extends WorkerEntrypoint {
  async run({ args = [], stdin = '', env = {}, files = {}, cwd, collect: paths = [], programs = [], spawn } = {}) {
    const output = [];
    let exitCode = null;
    const input = new TextEncoder().encode(stdin);
    let pos = 0;
    let module;
    try {
      module = await createModule({
        noInitialRun: true,
        processHost: processHost(programs, spawn),
        preRun: [
          (m) => {
            Object.assign(m.ENV, env);
            for (const [path, data] of Object.entries(files)) {
              m.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')) || '/');
              m.FS.writeFile(path, data);
            }
            if (cwd) {
              m.FS.mkdirTree(cwd);
              m.FS.chdir(cwd);
            }
          },
        ],
        thisProgram: 'main',
        print: (text) => output.push({ stream: 'stdout', text }),
        printErr: (text) => output.push({ stream: 'stderr', text }),
        onExit: (code) => {
          exitCode = code;
        },
        stdin: () => (pos < input.length ? input[pos++] : null),
        instantiateWasm(imports, done) {
          done(new WebAssembly.Instance(wasm, imports));
          return {};
        },
      });
      // A promise: main can suspend while children run.
      const code = await module.callMain([...args]);
      exitCode ??= code;
    } catch (e) {
      // ExitStatus is how emscripten unwinds on exit(); anything else is a trap or abort.
      if (exitCode === null) {
        exitCode = 134;
        output.push({ stream: 'stderr', text: `${e?.name ?? 'Error'}: ${e?.message ?? e}` });
      }
    }
    const out = {};
    if (module) for (const path of paths) collect(module.FS, path, out);
    return { output, exitCode, files: out };
  }
}
