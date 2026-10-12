#!/bin/sh
# Builds the pinned GDK `buzz-agent` used as the Mesh agent helper and stages it
# for `--config src-tauri/tauri.mesh.conf.json`, which bundles it into the app
# as `buzz-mesh-agent` (Contents/MacOS, found before PATH by host processes).
#
# Usage: scripts/mesh-helper/build.sh /path/to/block/buzz/checkout
# Pin: micn/buzz-agent-goose-core at $BASE plus acp-session-id.patch.
set -eu

BASE=6a7c51a5a9367c9e868c6a2cff5706c8a061cf28
if [ "$#" -ne 1 ]; then
  echo "Usage: $0 /path/to/block/buzz/checkout" >&2
  exit 2
fi
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(git -C "$here" rev-parse --show-toplevel)
source=$(git -C "$1" rev-parse --show-toplevel)
git -C "$source" cat-file -e "$BASE^{commit}" 2>/dev/null ||
  git -C "$source" fetch origin micn/buzz-agent-goose-core
work=$(mktemp -d "${TMPDIR:-/tmp}/buzz-mesh-helper.XXXXXX")
cleanup() {
  git -C "$source" worktree remove --force "$work/src" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
git -C "$source" worktree add --detach "$work/src" "$BASE" >/dev/null
git -C "$work/src" apply --index "$here/acp-session-id.patch"
CARGO_TARGET_DIR="$work/target" cargo build --release --locked \
  --manifest-path "$work/src/Cargo.toml" -p buzz-agent
host=$(rustc -vV | sed -n 's/^host: //p')
mkdir -p "$root/src-tauri/binaries"
out="$root/src-tauri/binaries/buzz-mesh-agent-$host"
cp "$work/target/release/buzz-agent" "$out"
shasum -a 256 "$out"
