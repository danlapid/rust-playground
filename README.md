# Rust Playground on Cloudflare Workers

**The whole Rust toolchain, running on Cloudflare Workers.** rustc, the linker, Cargo's
dependency resolution, build scripts and proc macros all run in Workers. There are no
containers, no VMs and no build servers. Write a snippet, add crates from crates.io, press
Run, and watch each Worker do its part.

Try it: <https://rust-playground.runtime-playground.workers.dev>

```rust
---
[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
---
#[derive(serde::Serialize)]
struct Point { x: i32, y: i32 }

fn main() {
    println!("{}", serde_json::to_string(&Point { x: 1, y: 2 }).unwrap());
}
```

Dependencies are declared in the snippet itself, in cargo-script frontmatter. The
snippet above pulls in eleven crates. It builds them, builds serde's derive macro and runs
it on your code, then compiles, links and runs the program. The first time, that takes a few seconds. After that, the
crates come from the cache and the whole round trip takes about two seconds, most of it
rustc compiling your code.

## What happens when you press Run

```
Browser ─► Playground Worker ── resolves crates.io versions, plans the build, streams progress
             ├─► Compiler Worker ──── rustc, compiled to WebAssembly
             │     └─► Dynamic Workers   proc macros, each in a sandbox of its own
             ├─► Dynamic Workers ──── build scripts, and your program, with no network
             ├─► Linker Worker ────── wasm-ld, compiled to WebAssembly
             └─► Workers Cache + R2 ─ everything built once, reused by everyone
```

1. **Resolve.** The playground Worker reads the frontmatter and resolves it against the
   crates.io index the way Cargo does, with semver, features, optional and renamed
   dependencies, and platform-specific dependencies.
2. **Build the dependencies.** Each crate is downloaded, and rustc in the compiler
   Worker compiles it, several at a time. A crate with a build script compiles it into a
   program, runs it in a Dynamic Worker with Cargo's environment, and applies what it
   prints. A proc-macro crate becomes a module that runs in a Dynamic Worker of its own.
3. **Compile the snippet.** rustc compiles your code against the crates.
4. **Link.** The linker Worker links your code and the crates into one WebAssembly
   program.
5. **Run.** The program runs in a fresh Dynamic Worker that can't reach the network. It
   still gets standard input, arguments, a filesystem, panics and exit codes, as it
   would natively.

Every step is cached by a hash of everything that went into it, so a crate is compiled
once, for everyone. The playground also streams each step back as it happens, and the
page draws it: which Worker is busy, and whether each cache lookup hit.

## How it works, and why

### rustc, compiled to WebAssembly

rustc is a big native program that expects threads, processes, shared libraries and
memory-mapped files. Here it is built for `wasm32-unknown-emscripten` and runs inside a
Worker. Emscripten gives it what it needs from an operating system: a libc, a
filesystem, and stdin and stdout. Seven small patches to rustc cover the rest
(`toolchain/rustc-patches`). Without them, rustc would spawn threads, run its linker as a
separate process, load proc macros as shared libraries, and map whole files into memory.
Each patch is small enough to read in one sitting. Apart from them, and two small fixes
to crates rustc depends on, this is rustc 1.98.1 as released. The linker is lld, built
the same way.

Programs are built for the same target, the one Rust on Workers uses. That's why a
program gets a real standard library, files and exit codes, rather than a stripped-down
WebAssembly environment.

### Untrusted code never touches the network

A playground runs code from strangers, and crates.io adds code from more strangers: a
build script or proc macro can do anything. Each of them, and each program, runs in a
**Dynamic Worker**. That's an isolate created on demand from the code that was just
compiled, with `globalOutbound: null`, so it can't make network requests. Nothing it
does can reach the compiler's memory or another user's run.

### Proc macros, across isolates

When rustc reaches `#[derive(Serialize)]`, it has to run serde's derive macro, which is
code from crates.io. Natively, rustc loads proc macros as shared libraries, into its own
process. Here, the macro runs in its own sandboxed Dynamic Worker. rustc pauses
mid-compile while the macro runs. The macro asks rustc questions about the code it's
expanding, and those calls come back over RPC to the paused rustc, which answers and
waits again. That pausing comes from JavaScript Promise Integration (JSPI), which lets
synchronous WebAssembly wait on asynchronous work. The protocol between rustc and the
macro is rustc's own; only its bytes cross from one isolate to the other.

### Build scripts that run rustc

Many build scripts run `rustc` to see what it supports. That means a program running in
a Dynamic Worker has to start a process, and Emscripten has no `fork`. The playground's
std spawns processes with `posix_spawn` instead (`toolchain/std`). The runtime hands the
child to the host, which runs it in the compiler Worker. Meanwhile the build script
pauses (JSPI again) until the child exits.

### Linking with no emcc

Emscripten programs are normally linked by emcc, a Python program that also writes
JavaScript glue for each program. Nothing like that can run in a Worker. Instead,
`toolchain/build-runtime.mjs` runs emcc once, at build time, and records what it does:
the exact linker arguments, its libraries, and one JavaScript runtime general enough
for any program. At request time, linking is just wasm-ld, and every program runs on
that same runtime.

### Compiled once, for everyone

What's slow is done once. Resolved versions, each built crate, all of a snippet's
dependencies together, and the snippet's own build are all stored in **R2**, keyed by
a hash of their inputs, rustc included. **Workers Cache** sits in front, so most lookups
are answered at the edge without running any code. A popular crate is compiled the
first time anyone needs it. After that, every snippet that uses it gets it in
milliseconds, and an unchanged snippet skips the compiler entirely. Its program still
runs fresh every time.

### A compiler in 128 MB

A Worker gets 128 MB of memory, and rustc is used to having gigabytes. To fit:

- rustc reads crate metadata a page at a time, instead of loading whole files. std's
  metadata alone is 75 MiB.
- That metadata ships as the compiler's static assets, compressed, and is inflated a page
  at a time as rustc reads it.
- The final link happens in a separate Worker, so your code and the crates' object code
  never have to fit in the compiler's memory too.

Every example compiles its program in 64 MiB or less. A few popular crates take more than
a Worker allows to compile, even with all this. zerocopy, pulled in by `rand`, takes
almost 300 MiB. The examples' dependencies are prebuilt into the cache with
`pnpm warm-cache`, which runs the same Workers locally, where memory isn't limited.

## Using the API

```sh
curl https://rust-playground.runtime-playground.workers.dev/api/run \
  -d '{"code": "fn main() { println!(\"hello\"); }"}'
```

`POST /api/run` takes `code`, and optionally `edition` (default `"2024"`), `optLevel`
(`"0"` to `"3"`, `"s"` or `"z"`; default `"0"`), `check` (stop after type checking),
`stdin` and `args`. It returns each stage's diagnostics and timings, and the program's
output and exit code (`PlaygroundResult` in `src/pipeline.ts`). With `Accept:
application/x-ndjson`, it streams progress events first, one JSON object per line, and
the result last.

## Limitations

- Programs run on one thread and can't reach the network.
- Crates that take rustc more than 150 MiB to compile can't be built in a Worker. They
  work only if they're already in the cache, as the examples' dependencies are.
- Dependencies come from crates.io only, in `[dependencies]` or a platform's
  `[target.*.dependencies]`. There are no git or path dependencies, and the snippet
  can't declare features of its own.

## The code

| | |
|---|---|
| `src/` | the playground Worker: `/api/run`, caching, and running programs |
| `src/cargo/` | Cargo, reimplemented: resolving, fetching and building crates |
| `public/` | the page |
| `workers/compiler/` | rustc, and the sandboxes that run proc macros |
| `workers/linker/` | wasm-ld |
| `toolchain/` | building rustc, lld, std and the runtime, and the patches to them |
| `scripts/` | deploying, prebuilding the examples' crates, recording the page's replay |
| `test/` | tests, run in workerd |

## Building and deploying

You need Node 22 or later, pnpm, [emsdk](https://emscripten.org/docs/getting_started/downloads.html)
(in `~/emsdk`, or set `EMSDK`), rustup with Rust 1.98.1 and its
`wasm32-unknown-emscripten` target, cmake, and ninja. The toolchain takes a few hours to
build, most of it LLVM and rustc.

```sh
pnpm install
pnpm toolchain      # build lld, rustc, std and the runtime, and stage them into the Workers
pnpm test           # the tests, in workerd
pnpm dev            # the playground on http://localhost:8787
```

To deploy, you need a paid Workers plan (the compiler can take minutes of CPU on a big
crate) and Dynamic Workers:

```sh
pnpm exec wrangler login
pnpm run deploy     # all three Workers, and the R2 bucket if it's missing
pnpm warm-cache     # prebuild the examples' dependencies into the deployed cache
```

After changing rustc or std, bump `RUSTC_ID` in `src/cargo/build.ts`, so that nothing
built by the old one is reused.

## License

MIT; see `LICENSE`. The patches to Rust in `toolchain/` are offered under Rust's own
terms, MIT or Apache-2.0.
