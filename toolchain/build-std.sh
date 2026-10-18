#!/usr/bin/env bash
# Builds Rust's std for wasm32-unknown-emscripten from the 1.98.1 sources, with the
# patches in toolchain/std: so far, std::process::Command spawns with posix_spawn (which
# the runtime provides; see toolchain/runtime) rather than fork, which Emscripten lacks.
#
# Built with rustup's 1.98.1, so its metadata matches what rustc.wasm (also 1.98.1)
# expects. Output: .build/std/sysroot, a sysroot with only this target's libraries.
#
# As rustup's std is, it's built with -Zno-embed-metadata: each crate's metadata is a
# .rmeta file of its own, and its .rlib has only object code. rustc.wasm reads the
# metadata a page at a time; linkers read the .rlib, all of it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/.build/std"
RUST="$ROOT/.build/rust"
TARGET=wasm32-unknown-emscripten
TOOLCHAIN=1.98.1
OUT="$WORK/sysroot/lib/rustlib/$TARGET/lib"

rm -rf "$WORK/src" "$WORK/crates"
mkdir -p "$WORK/src" "$WORK/crates"
git -C "$RUST" archive "$TOOLCHAIN" library | tar -x -C "$WORK/src"
# Submodules, at the commits 1.98.1 pins.
git -C "$RUST" ls-tree -r "$TOOLCHAIN" library | awk '$2 == "commit" { print $3, $4 }' | while read -r rev dir; do
  git -C "$RUST/$dir" archive --prefix="$dir/" "$rev" | tar -x -C "$WORK/src"
done
patch -s -d "$WORK/src" -p1 < "$ROOT/toolchain/std/std.patch"

# Patched dependencies of std, from crates.io: toolchain/std/<name>-<version>.patch.
for p in "$ROOT"/toolchain/std/*-[0-9]*.patch; do
  crate="$(basename "$p" .patch)"
  name="${crate%-*}" ver="${crate##*-}"
  curl -sfL "https://crates.io/api/v1/crates/$name/$ver/download" | tar -xz -C "$WORK/crates"
  patch -s -d "$WORK/crates/$crate" -p1 < "$p"
  sed -i.bak "/^\[patch.crates-io\]/a\\
$name = { path = '$WORK/crates/$crate' }
" "$WORK/src/library/Cargo.toml" && rm "$WORK/src/library/Cargo.toml.bak"
done

# -Zbuild-std needs a crate to build std for; this one is empty.
mkdir -p "$WORK/build/src"
cat > "$WORK/build/Cargo.toml" <<'EOF'
[package]
name = "sysroot-build"
version = "0.0.0"
edition = "2024"

[profile.release]
debug = 0
EOF
: > "$WORK/build/src/lib.rs"

# Paths in std (panic locations, debug info) as rustup's std has them, not this machine's.
COMMIT="$(git -C "$RUST" rev-parse "$TOOLCHAIN^{commit}")"
(
  cd "$WORK/build"
  RUSTC_BOOTSTRAP=1 __CARGO_TESTS_ONLY_SRC_ROOT="$WORK/src/library" \
    RUSTFLAGS="--remap-path-prefix=$WORK/src=/rustc/$COMMIT --remap-path-prefix=$WORK/crates=/rust/deps" \
    cargo "+$TOOLCHAIN" build --release --target "$TARGET" \
    -Zbuild-std=std,panic_abort,panic_unwind,proc_macro -Zno-embed-metadata
)

rm -rf "$WORK/sysroot"
mkdir -p "$OUT"
for f in "$WORK/build/target/$TARGET/release/deps"/*.rlib "$WORK/build/target/$TARGET/release/deps"/*.rmeta; do
  case "$(basename "$f")" in libsysroot_build-*) continue ;; esac
  cp "$f" "$OUT/"
done
ls "$OUT"
