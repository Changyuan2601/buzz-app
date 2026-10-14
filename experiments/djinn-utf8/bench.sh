#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
repo_root=$(git rev-parse --show-toplevel)
output_dir=${1:?usage: bench.sh OUTPUT_DIRECTORY}
mkdir -p "$output_dir"
output_dir=$(cd "$output_dir" && pwd)
"$repo_root/bin/rustc" --edition=2021 -C opt-level=3 src/bench.rs -o "$output_dir/bench"
"$repo_root/bin/rustc" -Vv > "$output_dir/compiler.txt"
lscpu > "$output_dir/cpu.txt"
cat /sys/fs/cgroup/cpu.max > "$output_dir/cpu-quota.txt"
sha256sum src/{bench,historical}.rs "$repo_root/src-tauri/src/host_process/"{text,utf8_tail}.rs > "$output_dir/bench-source-sha256.txt"
"$output_dir/bench" > "$output_dir/bench.csv" 2> "$output_dir/bench-checks.log"
