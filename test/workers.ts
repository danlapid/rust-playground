// Miniflare options for the pipeline-step Workers, from their `wrangler deploy --dry-run` bundles.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function bundle(name: string) {
  const configDir = path.join(ROOT, 'workers', name);
  const outdir = path.join(ROOT, 'dist', `${name}-bundle`);
  fs.rmSync(outdir, { recursive: true, force: true });
  execFileSync(path.join(ROOT, 'node_modules/.bin/wrangler'), ['deploy', '--dry-run', '--outdir', outdir], {
    cwd: configDir,
    stdio: 'ignore',
  });
  const files = (fs.readdirSync(outdir, { recursive: true }) as string[])
    .filter((f) => fs.statSync(path.join(outdir, f)).isFile() && !/\.(map|md)$/.test(f));
  const config = JSON.parse(
    fs.readFileSync(path.join(configDir, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
  );
  return {
    name: config.name,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    bindings: config.vars,
    workerLoaders: Object.fromEntries((config.worker_loaders ?? []).map((l: { binding: string }) => [l.binding, {}])),
    serviceBindings: Object.fromEntries(
      (config.services ?? []).map((s: { binding: string; service: string; entrypoint?: string }) => [
        s.binding,
        { name: s.service, entrypoint: s.entrypoint },
      ]),
    ),
    // Static assets, read through their binding.
    ...(config.assets && {
      assets: { directory: path.join(configDir, config.assets.directory), binding: config.assets.binding, run_worker_first: config.assets.run_worker_first },
    }),
    modulesRoot: outdir,
    modules: [
      { type: 'ESModule' as const, path: path.join(outdir, 'index.js') },
      ...files
        .filter((f) => f !== 'index.js')
        .map((f) => ({
          type: f.endsWith('.wasm')
            ? ('CompiledWasm' as const)
            : // Sources the Worker hands to Dynamic Workers (its Text rule).
              /(runtime\.mjs|entry\.js)$/.test(f)
              ? ('Text' as const)
              : ('Data' as const),
          path: path.join(outdir, f),
        })),
    ],
  };
}

export const linkerWorker = () => bundle('linker');

/** Whether rustc.wasm has been built and staged into the compiler Worker. */
export const hasCompiler = () => fs.existsSync(path.join(ROOT, 'workers/compiler/src/generated/rustc.wasm'));

/** The compiler Worker, or a stand-in that satisfies the COMPILER binding until rustc is built. */
export const compilerWorker = () =>
  hasCompiler()
    ? // workerd here has no memory limit, and the tests build crates that need more.
      { ...bundle('compiler'), bindings: { RUSTC_MEMORY_MIB: '4096' } }
    : {
        name: 'rust-playground-compiler',
        compatibilityDate: '2026-10-01',
        modules: true,
        script: `import { WorkerEntrypoint } from 'cloudflare:workers';
          export class Compiler extends WorkerEntrypoint {
            compile() { throw new Error('rustc.wasm is not built: run pnpm toolchain:rustc && pnpm toolchain:stage'); }
          }
          export default { fetch: () => new Response(null, { status: 503 }) };`,
      };
