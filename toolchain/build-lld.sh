#!/usr/bin/env bash
# Build LLVM and lld (wasm-ld) for emscripten, from the LLVM that Rust 1.98.1 ships.
# Output: dist/linker/lld.{mjs,wasm}, and .build/llvm-wasm-install for build-rustc.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LLVM_SHA=52ed14fcd56afc30f9cccd8ca8ce237c2eef7e04 # rust-lang/rust 1.98.1 src/llvm-project
SRC="$ROOT/.build/llvm-project"
NATIVE="$ROOT/.build/llvm-native"
WASM="$ROOT/.build/llvm-wasm"
source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh" >/dev/null 2>&1

if [ ! -d "$SRC/.git" ]; then
  git init -q "$SRC"
  git -C "$SRC" remote add origin https://github.com/rust-lang/llvm-project.git
  git -C "$SRC" sparse-checkout set llvm lld cmake third-party libunwind/include
  git -C "$SRC" fetch -q --depth 1 origin "$LLVM_SHA"
  git -C "$SRC" checkout -q FETCH_HEAD
fi

# setjmp/longjmp (CrashRecoveryContext) as wasm exceptions, matching Rust's emscripten
# std, which uses -fwasm-exceptions; emscripten's default JS-based sjlj cannot be mixed in.
SJLJ="-sSUPPORT_LONGJMP=wasm"

# Host tablegen, needed to cross-compile LLVM.
cmake -G Ninja -S "$SRC/llvm" -B "$NATIVE" -DCMAKE_BUILD_TYPE=Release \
  -DLLVM_TARGETS_TO_BUILD=WebAssembly -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF >/dev/null
ninja -C "$NATIVE" llvm-tblgen llvm-min-tblgen

emcmake cmake -G Ninja -S "$SRC/llvm" -B "$WASM" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DLLVM_ENABLE_PROJECTS=lld \
  -DLLVM_TARGETS_TO_BUILD=WebAssembly \
  -DLLVM_TABLEGEN="$NATIVE/bin/llvm-tblgen" \
  -DLLVM_NATIVE_TOOL_DIR="$NATIVE/bin" \
  -DLLVM_ENABLE_THREADS=OFF \
  -DLLVM_ENABLE_PIC=OFF \
  -DLLVM_BUILD_TOOLS=OFF -DLLVM_INCLUDE_TOOLS=ON \
  -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_LIBXML2=OFF -DLLVM_ENABLE_TERMINFO=OFF \
  -DLLVM_ENABLE_LIBEDIT=OFF -DLLVM_ENABLE_LIBPFM=OFF -DLLVM_ENABLE_BACKTRACES=OFF -DLLVM_ENABLE_CRASH_OVERRIDES=OFF \
  -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-unknown-emscripten \
  -DCMAKE_C_FLAGS="$SJLJ" -DCMAKE_CXX_FLAGS="$SJLJ" \
  -DCMAKE_EXE_LINKER_FLAGS="-sALLOW_MEMORY_GROWTH=1 -sEXIT_RUNTIME=1 -sENVIRONMENT=node -sNODERAWFS=1 -sSTACK_SIZE=1048576" \
  >/dev/null
ninja -C "$WASM"
cmake --install "$WASM" --prefix "$ROOT/.build/llvm-wasm-install" >/dev/null

# Link a wasm-ld-only driver for Workers: a factory module (MODULARIZE) that a Worker
# instantiates per link, with MEMFS as root and NODEFS available to mount /bundle.
OUT="$ROOT/dist/linker"
mkdir -p "$OUT"
em++ -Os -std=c++17 -fno-exceptions -fno-rtti \
  -I"$SRC/llvm/include" -I"$WASM/include" -I"$SRC/lld/include" -I"$WASM/tools/lld/include" \
  -c "$ROOT/toolchain/lld/wasm-ld-main.cpp" -o "$WASM/wasm-ld-main.o"
em++ -Os "$WASM/wasm-ld-main.o" -o "$OUT/lld.mjs" \
  -Wl,--start-group "$WASM"/lib/liblld*.a "$WASM"/lib/libLLVM*.a -Wl,--end-group \
  $SJLJ -sMODULARIZE=1 -sEXPORT_ES6 -sEXPORT_NAME=createLld -sENVIRONMENT=node -sASSERTIONS=0 \
  -sALLOW_MEMORY_GROWTH=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sSTACK_SIZE=2097152 \
  -lnodefs.js -sFORCE_FILESYSTEM -sEXPORTED_RUNTIME_METHODS=FS,NODEFS,callMain
# Workers module URLs are not file: URLs; nothing here should depend on them.
sed -i.bak 's#import\.meta\.url#"file:///bundle/lld.mjs"#g' "$OUT/lld.mjs"
# workerd has no process.binding(); node:fs exports the same open(2) flags.
sed -i.bak 's#process\.binding("constants")\["fs"\]#require("node:fs").constants#g' "$OUT/lld.mjs"
rm "$OUT/lld.mjs.bak"
ls -la "$OUT"
