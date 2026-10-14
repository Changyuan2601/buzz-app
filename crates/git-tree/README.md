# Verified Git tree kernel

`buzz-git-tree` owns byte parsing and package admission for native Git plugin
imports and Projects repository reads. Cargo compiles the executable bodies
inside `verus!`; Verus checks those same bodies with proof/specification code
present. There is no second executable model.

Run `bin/just verify` (or `bin/just verify buzz-git-tree`). The task checks that
the named Cargo package explicitly enables Verus, configures Hermit's Rust
shared libraries, and runs `cargo verus verify -p buzz-git-tree --locked`.
Tools are checksum pinned to Verus `0.2026.10.04.426d8b0`, Rust `1.98.1`, and
vstd `0.0.0-2026-10-04-0306`. Cargo can reuse previously verified artifacts;
only output containing new verification results establishes a fresh proof count.
Without the task's metadata guard, cargo-verus can warn and succeed when no
selected package opts in. Existing CI runs executable Cargo checks/tests;
proof verification is the explicit task.

## Contracts

`parse` consumes complete NUL-terminated records of Git's
`ls-tree -r [-t] -l -z --full-tree` format. It preserves the bytes after the
first metadata tab, including tabs, newlines and non-UTF-8 filenames. Mode/type
pairs are checked; object IDs contain exactly 40 or 64 hexadecimal bytes;
blob sizes are checked decimal u64 values, with Git's space padding accepted;
nonblobs require `-`. Truncated/empty records, malformed metadata, duplicate
raw paths, and the caller's entry limit fail explicitly. Empty input succeeds.

Erased framing witnesses tie every entry's path, object ID, mode and size to
its original input record and account for the entire input. A verified index
mergesort retains the exact multiset of entry indices. Strict path ordering
rejects duplicates, and binary search proves both exact matches and absence
across the complete parsed snapshot. Sorting is necessary because recursive
`-t` output contains directory entries and is not ordered by raw full paths.
Runtime work is O(input bytes + entries log entries times compared path bytes).

`Tree::package` checks both release-marker paths before blob eligibility.
Unsigned selection proves that neither marker exists anywhere in the original
snapshot, regardless of mode. Signed/unsigned results identify regular or
executable blobs under the same exact parent prefix, with original object IDs
and sizes within the supplied file limit. Signed pairs take precedence;
incomplete/nonregular pairs produce a distinct rejection. Git imports use `-t`
to retain marker directories as well as symlinks and gitlinks. Projects keeps
its browsing policy of including symlink blobs. Both owners use checked UTF-8
conversion for presentation, so unsupported names fail instead of aliasing.

## Boundary of the proof

The verifier, SMT solver, vstd specifications of slices/vectors/multisets,
string bytes, integer wrapping and ordinary allocation are trusted. Four package-name arrays have a local byte-string
style exception because the pinned verifier treats byte-string literals as opaque;
parser strings use the existing vstd ASCII specification. There are no
`assume`, `admit`, or
`external_body` declarations in this kernel. Git's command output and object
store authenticity, subprocess limits/cleanup, authentication, UTF-8 adapters,
artifact parsing, hashing/signatures and installation/rollback remain with their
existing production owners. The proof does not establish those I/O or crypto
guarantees. The importer also retains ownership of parent discovery, ignored
`node_modules`/`target` components, preview limits and warnings.

Regression evidence uses committed Git fixtures through `Git::read_plugins`
and native `fetch_snapshot`: nonregular release markers previously became
unsigned candidates, and invalid UTF-8 paths previously aliased supported
Unicode names. A one-off faithful pre-fix admission control failed Verus's
original-marker obligation, after which source bytes were restored. No mutant
or mutation runner is part of the repository.
