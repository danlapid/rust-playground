#!/usr/bin/env bash
# Build rustc 1.98.1 for wasm32-unknown-emscripten (rustc that runs in a Worker), with
# the patches in toolchain/rustc-patches. Needs .build/llvm-wasm-install from
# build-lld.sh.
#
# Bootstrap runs as a local rebuild: stable 1.98.1 from rustup is stage 0, so it can
# compile the 1.98.1 compiler for the Emscripten host directly, against rustup's
# prebuilt Emscripten std. The resulting rustc reports the same version as stable, so it
# loads std built by rustup's 1.98.1: build-std.sh builds the one it runs with.
#
# Usage: build-rustc.sh [host-triple]   (default wasm32-unknown-emscripten; pass the
# native triple to build a native rustc with the same patches, for testing)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUST="$ROOT/.build/rust"
HOST="${1:-wasm32-unknown-emscripten}"
NATIVE="$(rustc -vV | sed -n 's/^host: //p')"
STABLE="$(rustc +1.98.1 --print sysroot 2>/dev/null || rustc --print sysroot)"
source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh" >/dev/null 2>&1

if [ ! -d "$RUST/.git" ]; then
  git clone -q --depth 1 --branch 1.98.1 https://github.com/rust-lang/rust.git "$RUST"
fi
# The only submodule the compiler workspace needs (bootstrap's own fetching is off).
git -C "$RUST" submodule update -q --init --depth 1 library/backtrace
if ! git -C "$RUST" rev-parse -q --verify playground >/dev/null; then
  git -C "$RUST" checkout -q -b playground
  git -C "$RUST" -c user.name=rust-playground -c user.email=rp@localhost am -q "$ROOT"/toolchain/rustc-patches/*.patch
fi

# crates.io dependencies that need fixes for an Emscripten host: each
# toolchain/rustc/crates/<name>-<version>.patch is applied to a vendored copy, which
# the workspace uses through [patch.crates-io].
CRATES="$ROOT/.build/crates"
PATCH_SECTION="[patch.crates-io]"
for p in "$ROOT"/toolchain/rustc/crates/*.patch; do
  crate="$(basename "$p" .patch)"
  name="${crate%-*}"
  if [ ! -d "$CRATES/$crate" ]; then
    mkdir -p "$CRATES/$crate"
    curl -sfL "https://crates.io/api/v1/crates/$name/${crate##*-}/download" \
      | tar xz -C "$CRATES/$crate" --strip-components 1
    patch -s -d "$CRATES/$crate" -p1 < "$p"
  fi
  PATCH_SECTION="$PATCH_SECTION
$name = { path = \"$CRATES/$crate\" }"
done
sed -i.bak '/^# playground-patches-begin$/,/^# playground-patches-end$/d' "$RUST/Cargo.toml" && rm "$RUST/Cargo.toml.bak"
printf '# playground-patches-begin\n%s\n# playground-patches-end\n' "$PATCH_SECTION" >> "$RUST/Cargo.toml"

# Only the native test compiler needs a native LLVM.
NATIVE_LLVM=""
if [ "$HOST" = "$NATIVE" ]; then
  NATIVE_LLVM="[target.$NATIVE]
llvm-config = \"$ROOT/.build/llvm-native/bin/llvm-config\""
fi

cat > "$RUST/bootstrap.toml" <<EOF
change-id = "ignore"

[build]
rustc = "$STABLE/bin/rustc"
cargo = "$STABLE/bin/cargo"
local-rebuild = true
# No "(built from a source tarball)": the version must match stable's exactly.
description = ""
host = ["$HOST"]
target = ["wasm32-unknown-emscripten"]
docs = false
extended = false
submodules = false
# Only matters for building std, which build-std.sh does instead.
optimized-compiler-builtins = false

[llvm]
download-ci-llvm = false
use-libcxx = true

[rust]
channel = "stable"
# The Worker that runs rustc.wasm has a size limit (64 MiB), which opt-level 3 exceeds.
optimize = "s"
codegen-backends = ["llvm"]
lld = false
llvm-tools = false
debug-assertions = false
overflow-checks = false
incremental = false
debuginfo-level = 0
jemalloc = false
# Vendored crates (toolchain/rustc/crates) build as path dependencies, so their
# warnings are not capped as they are for crates.io.
deny-warnings = false

$NATIVE_LLVM

[target.wasm32-unknown-emscripten]
llvm-config = "$ROOT/.build/llvm-wasm-install/bin/llvm-config"
cc = "emcc"
cxx = "em++"
ar = "emar"
ranlib = "emranlib"
# Adds the settings for running rustc as a factory module in a Worker or Node.
linker = "$ROOT/toolchain/rustc/emcc-link.sh"
EOF

# rustc_llvm bundles LLVM's static libraries into its rlib; rebuild it when they change.
LLVM_STAMP="$ROOT/.build/llvm-wasm-install/lib/libLLVMSupport.a"
if [ "$LLVM_STAMP" -nt "$RUST/build/.llvm-wasm-stamp" ]; then
  touch "$RUST/compiler/rustc_llvm/build.rs" "$RUST/build/.llvm-wasm-stamp"
fi

# The version string must be exactly stable 1.98.1's, commit hash included, or rustc
# rejects the prebuilt std. Bootstrap takes it from git, which would give the patched
# HEAD; without a .git it reads git-commit-info, as for a release tarball.
BASE="1.98.1^{commit}"
printf '%s\n%s\n%s\n' "$(git -C "$RUST" rev-parse "$BASE")" "$(git -C "$RUST" rev-parse --short=9 "$BASE")" \
  "$(git -C "$RUST" log -1 --format=%cd --date=short "$BASE")" > "$RUST/git-commit-info"
mv "$RUST/.git" "$RUST/.git-playground"
trap 'mv "$RUST/.git-playground" "$RUST/.git"' EXIT

cd "$RUST"
# After the compiler links, bootstrap goes on to assemble a stage1 sysroot, which does
# not work for an Emscripten host (and is not needed): judge by the output instead.
./x build --stage 1 compiler/rustc --host "$HOST" --target wasm32-unknown-emscripten || true
OUT="$RUST/build/$NATIVE/stage1-rustc/$HOST/release"
if [ "$HOST" = wasm32-unknown-emscripten ]; then
  [ "$OUT/rustc_main.wasm" -nt "$RUST/bootstrap.toml" ] || { echo "rustc_main.wasm was not built" >&2; exit 1; }
  ls -la "$OUT/rustc_main.wasm" "$OUT/rustc-main.js"
fi
