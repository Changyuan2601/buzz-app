#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export VERUS_USE_RUSTUP=0
export DYLD_LIBRARY_PATH="$(bin/rustc --print sysroot)/lib:${DYLD_LIBRARY_PATH:-}"
export LD_LIBRARY_PATH="$(bin/rustc --print sysroot)/lib:${LD_LIBRARY_PATH:-}"
# cargo-verus otherwise merely warns and succeeds when verification is disabled.
metadata=$(bin/cargo metadata --no-deps --format-version 1 --locked)
policy=$(printf '%s' "$metadata" | bin/node -e '
let input = ""; process.stdin.on("data", data => input += data);
process.stdin.on("end", () => {
 const owner = JSON.parse(input).packages.find(p => p.name === "buzz-pairing-policy");
 if (!owner || owner.metadata?.verus?.verify !== true) process.exit(1);
 process.stdout.write(owner.manifest_path);
});')
test "$policy" = "$PWD/crates/pairing-policy/Cargo.toml"
# Directly verify the whole production root too: absent opt-in/tools or zero
# verified functions must fail, even if cargo-verus changes its report behavior.
bin/verus --crate-type lib crates/pairing-policy/src/lib.rs --output-json > /tmp/buzz-pairing-verification-$$.json
trap 'rm -f /tmp/buzz-pairing-verification-$$.json' EXIT
bin/node -e '
const fs = require("fs"); const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const result = report["verification-results"];
if (!result?.success || !(result.verified > 0) || result.errors !== 0) process.exit(1);
console.log(`Pairing policy: ${result.verified} verified, ${result.errors} errors`);
' /tmp/buzz-pairing-verification-$$.json
bin/cargo verus verify -p buzz-pairing-policy --locked
