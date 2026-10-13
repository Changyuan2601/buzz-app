#!/bin/sh
# Builds lean upstream goose's ACP-only binary (`goose-acp`, goose #11961) for
# the Mesh agent type and stages it for `--config src-tauri/tauri.mesh.conf.json`,
# which bundles it into the app as `buzz-mesh-goose` (Contents/MacOS, found
# before PATH by host processes).
#
# Usage: scripts/mesh-goose/build.sh [/path/to/goose/checkout]
# Pin: aaif-goose/goose at $REVISION, `lean` profile, the feature set Buzz used
# for its earlier bundled goose-acp.
set -eu

REPOSITORY=https://github.com/aaif-goose/goose.git
REVISION=69de89c50cc01d4e0187d6645bf3618729873f74
FEATURES=native-tls,system-keyring,online-model-meta,openssl/vendored

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(git -C "$here" rev-parse --show-toplevel)
work=$(mktemp -d "${TMPDIR:-/tmp}/buzz-mesh-goose.XXXXXX")
cleanup() {
  if [ -n "${source:-}" ]; then
    git -C "$source" worktree remove --force "$work/src" >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT
if [ "$#" -ge 1 ]; then
  source=$(git -C "$1" rev-parse --show-toplevel)
  git -C "$source" cat-file -e "$REVISION^{commit}" 2>/dev/null ||
    git -C "$source" fetch "$REPOSITORY" "$REVISION"
  git -C "$source" worktree add --detach "$work/src" "$REVISION" >/dev/null
else
  git init -q "$work/src"
  git -C "$work/src" fetch -q --depth 1 --filter=blob:none "$REPOSITORY" "$REVISION"
  git -C "$work/src" checkout -q --detach FETCH_HEAD
fi
CARGO_TARGET_DIR="$work/target" cargo build --locked \
  --manifest-path "$work/src/Cargo.toml" -p goose --bin goose-acp \
  --profile lean --no-default-features --features "$FEATURES"
host=$(rustc -vV | sed -n 's/^host: //p')
mkdir -p "$root/src-tauri/binaries"
out="$root/src-tauri/binaries/buzz-mesh-goose-$host"
cp "$work/target/lean/goose-acp" "$out"
shasum -a 256 "$out"
