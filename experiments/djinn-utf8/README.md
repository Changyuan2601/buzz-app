# UTF-8 stream boundaries: a Buzz Djinn experiment

Buzz plugins receive native child-process stdout and stderr as text. OS reads can
split a scalar anywhere, including after malformed data. Concatenated event text
must equal `String::from_utf8_lossy` of all bytes when the pipe ends.

The old `host_process::take_text` looked only at the first UTF-8 error. For reads
`[FF E2]`, `[82 AC]`, it emitted `����`; splitting the same bytes as `[FF]`, `[E2]`,
`[82 AC]` emitted `�€`. At EOF, `[78 E2]` emitted `x`, dropping E2. Code review
identified these existing bugs; owner tests reproduced both before the fix.
Djinn did not discover the counterexample. `Counterexample.lean` formally rejects
the historical retained-length result zero for `[FF E2]` and accepts one.

The fix retains only the longest trailing suffix that is a **proper prefix of
some valid UTF-8 scalar encoding**. “Some” matters: E2 can become many scalars.
The suffix is at most three bytes. Lead bytes must be C2..F4; continuation bytes
must be 80..BF. E0 requires a second byte at least A0; ED at most 9F; F0 at least
90; F4 at most 8F. Impossible prefixes are decoded immediately.

`src/spec.rs` states this declaratively: `scalar_encoding` defines complete
multi-byte scalar encodings, `proper_suffix` existentially completes a suffix,
and `tail_len` requires a maximal such suffix (or zero if none exists). This
specification does not call any Rust validity helper. Its grammar is independent
of the kernel's choice of tail positions and control flow.

The production kernel reads at most the last three bytes. `TextDecoder` decodes
the remaining prefix once, borrows a complete ordinary read directly, and retains
its pending buffer when a scalar crosses reads. It flushes pending bytes on pipe
termination through the existing event/cancellation path, before final Exit.

## What is proved

`djinn/solution/mod.rs` includes the **actual production** `utf8_tail.rs` by path,
with only a forwarding wrapper. Charon follows that call; Aeneas translates the
production functions. The authored Lean proofs derive the finite byte predicates
from the completion grammar, establish maximality/unambiguity, and show that the
Rust implementation satisfies it for arbitrary slices, terminates and does not
panic in the pinned Aeneas model. Existence follows from implementation
correctness. Djinn regenerates and checks the required obligation types and
performs an axiom audit. No trusted generated model is hand-patched.

This is a proof of the boundary kernel. Standard-library lossy decoding, buffer
updates, asynchronous reads and Tauri events are outside it. The composition
property needed by the wrapper is, for lossy decode D and suffix t=tail(x):

```
D(x + y) = D(x without t) + D(t + y)
```

The UTF-8 grammar and std's lossy replacement behavior make this the intended
streaming contract; this composition property is **not machine-proved here**.
Owner tests and standalone exhaustive/random oracle checks exercise the actual
production wrapper against whole-stream std decoding. The trusted base includes
Djinn lowering/obligation generation, Charon/Aeneas translation and std models,
Lean's kernel, and the correspondence between this grammar and UTF-8. The audit
permits only upstream logical axioms `propext`, `Classical.choice`, `Quot.sound`.

A concrete upstream provenance limitation: the pinned Djinn compile gate hashes
specification tokens and checks report statuses, but does **not** hash solution
Rust. A later `cargo build` cannot establish that an edited solution was proved.
Run a fresh `cargo djinn verify` after final kernel changes and record source,
proof, generated-model and report hashes. The experiment provides `verify.sh`
for this purpose. Evidence belongs to that snapshot, not arbitrary future edits.

## Reproduce

This nested package has its own workspace; it is not a Buzz workspace member and
adds no Djinn, Lean, Aeneas, Z3 or nightly dependency to shipped builds. Clone
rust-djinn as a sibling of buzz-app and pin master to
`8a9ae17c9a6cdbc5220f1881f5ad69f7e2d7e047`. Follow its README,
`docs/INSTALL.md`, and `docs/FIRST_STEPS.md`; use Aeneas
`557eff83ecef5083b98a52a94ca7fae63d6c1dab`, Charon
`c8f15d7d658c86a95658f71ad99cddd4be002e04`, nightly-2026-09-17,
Lean 4.31.0 and manifest-pinned Mathlib 4.31.0. Activate that isolated environment:

```sh
# On the experiment Blox machine:
source /home/bloxer/djinn-toolchain/activate.sh
experiments/djinn-utf8/verify.sh
# Ordinary native validation uses Buzz's Hermit tools:
bin/cargo test -p buzz-foundation --lib host_process::tests --locked
bin/cargo clippy -p buzz-foundation --lib --locked -- -D warnings
experiments/djinn-utf8/bench.sh /tmp/utf8-benchmark
```

The operational Aeneas binary is the official release at the exact pinned commit;
its Lean backend was built locally. OCaml source rebuilding was blocked by
upstream distribution-host TLS failures. This does not bypass any verification
gate; the supplied sort example first passed through the same pinned verifier.
[Toolchain setup and binary hashes](evidence/toolchain.md) record the installed
pins, locations, installation checks and limitations without external reports.

## Measurements and limits

[Recorded measurements](evidence/measurements.md) include all workloads and sample ranges.
The final complete mixed-multibyte decoder gain is 2.16× at 64KiB reads; ASCII and
malformed-data gains are smaller. Raw trials and source hashes are included.

The standalone benchmark includes the production decoder and kernel directly.
`historical.rs` is the exact base function from
`9c90857e3c1048a08b7fdd571eb836ec3639791d` (visibility alone changed). The
correct full-scan reference continues past malformed sequences to find a final
incomplete scalar. All measured complete decoder outputs are checked against std
before timing. Historical cases with wrong output are omitted, never presented
as equivalent work.

Input allocation and output comparison are outside timing. Output allocation,
pending-buffer allocation and decoding are included in complete decoder timing;
text is consumed with `black_box`, as a streaming caller would consume events.
Warmup and adaptive calibration precede nine samples; implementation order rotates.
Raw elapsed nanoseconds and iterations are recorded. Kernel timing isolates the
tail decision and must not be mistaken for complete decoder or app performance.
Tauri serialization/event transport and process IO are not timed. No performance
threshold is added to CI. Results are local Blox measurements, not an app-wide
speedup, and synthetic malformed workloads are explicitly labeled.

Linux native owner tests cover both pipes, an event barrier forcing the malformed
prefix/split-scalar boundary, EOF before Exit, and existing process lifecycle
behavior. macOS/Windows builds and human/native app acceptance remain deferred.
EOF on a read error flushes bytes already received; it cannot recover unread data.
EOF alone may produce the final replacement event, as required by the corrected
contract. No UI, raw-byte/terminal adapter or process ownership policy changed.
