#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
repo_root=$(git rev-parse --show-toplevel)
upstream="$repo_root/../rust-djinn"
expected=8a9ae17c9a6cdbc5220f1881f5ad69f7e2d7e047
[[ $(git -C "$upstream" rev-parse HEAD) == "$expected" ]]
[[ $(git -C "$upstream/tools/aeneas" rev-parse HEAD) == 557eff83ecef5083b98a52a94ca7fae63d6c1dab ]]
[[ $(git -C "$upstream/tools/aeneas/charon" rev-parse HEAD) == c8f15d7d658c86a95658f71ad99cddd4be002e04 ]]
# Activate the isolated pinned toolchain before calling this script.
cargo djinn verify
counterexample_audit=$(cd djinn/proofs && lake env lean Counterexample.lean)
printf '%s\n' "$counterexample_audit"
python3 - "$counterexample_audit" <<'PY_AUDIT'
import re, sys
allowed = {"propext", "Classical.choice", "Quot.sound"}
found = re.findall(r"'([^']+)' depends on axioms: \[([^\]]*)\]", sys.argv[1])
assert {name for name, _ in found} == {"historical_result_rejected", "correct_result_accepted"}
for name, raw in found:
    axioms = {item.strip() for item in raw.split(',') if item.strip()}
    assert axioms <= allowed, (name, axioms - allowed)
print("Counterexample axiom audit PASS")
PY_AUDIT
sha256sum "$repo_root/src-tauri/src/host_process/utf8_tail.rs" \
  "$repo_root/src-tauri/src/host_process/text.rs" src/spec.rs \
  djinn/solution/mod.rs djinn/proofs/Utf8Tail/{Prefixes,Proofs,Spec,Obligations}.lean \
  djinn/proofs/Utf8Tail/Code/{Funs,Types}.lean djinn/proofs/Counterexample.lean \
  djinn/proofs/Utf8Tail/Audit.lean djinn/report.toml
