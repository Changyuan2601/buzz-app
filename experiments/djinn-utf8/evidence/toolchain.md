# Pinned toolchain and installation evidence

This experiment ran on the Linux x86_64 Blox checkout `/home/bloxer/buzz-app`,
with sibling upstream `/home/bloxer/rust-djinn`. Experimental installations live
under `/home/bloxer/djinn-toolchain`; they do not change shell profiles, credentials,
Buzz build configuration or the shipped dependency graph.

| Tool | Exact version/revision | Installed location |
| --- | --- | --- |
| rust-djinn | `8a9ae17c9a6cdbc5220f1881f5ad69f7e2d7e047` | sibling `rust-djinn`; command `rust-djinn/target/debug/cargo-djinn` |
| Aeneas | `557eff83ecef5083b98a52a94ca7fae63d6c1dab`, release `nightly-2026.10.06-557eff8` | upstream `tools/aeneas/bin/aeneas`; exact-source Lean backend |
| Charon | `c8f15d7d658c86a95658f71ad99cddd4be002e04`, crate 0.1.279 | upstream `tools/aeneas/charon/bin/{charon,charon-driver}` |
| Translation Rust | nightly-2026-09-17, rustc 1.100.0-nightly `923c95cdf5ba65cea505aa2ea829f578e1506ed8`, LLVM23.1.1 | isolated rustup toolchain; cargo 1.100.0-nightly `495c385d0` |
| Lean / Lake | Lean 4.31.0 `68218e876d2a38b1985b8590fff244a83c321783`, Lake 5.0.0-src+68218e8 | isolated `lean-4.31.0-linux/bin`, linked by elan 4.2.4 |
| Mathlib | v4.31.0 `fabf563a7c95a166b8d7b6efca11c8b4dc9d911f` | manifest-pinned Aeneas backend packages |
| Z3 | 4.8.12 | `/usr/bin/z3` |
| Source-build tools | OCaml 5.4.0, opam 2.1.5, dune 3.24.2 | isolated opam switch, `/usr/bin/opam` |
| Buzz native / benchmark Rust | Hermit rustc 1.98.1 `48a229ceaefd4985c50990b14116b6d856af0985`, LLVM22.1.8; cargo 1.98.1 `797e8a9bc` | Buzz `bin/{rustc,cargo,rustfmt}` |

Follow the pinned upstream [installation guide](https://github.com/shenniger/rust-djinn/blob/8a9ae17c9a6cdbc5220f1881f5ad69f7e2d7e047/docs/INSTALL.md)
and [first steps](https://github.com/shenniger/rust-djinn/blob/8a9ae17c9a6cdbc5220f1881f5ad69f7e2d7e047/docs/FIRST_STEPS.md).
Keep the sibling checkout layout required by the package's relative paths.
Install translation nightly components (including rustc-dev, llvm-tools and
rust-src) in a separate RUSTUP_HOME/CARGO_HOME, and Lean in a separate ELAN_HOME.
Build the exact Aeneas Lean backend and its manifest-pinned packages; an existing
built package cache can be supplied with DJINN_LAKE_PACKAGES. On this Blox, the
activation script sets those isolated homes and puts cargo-djinn, experimental
Cargo and elan on PATH. It is local configuration, intentionally not committed.
On another machine activate equivalent pinned installations, then run `verify.sh`.

Installation checks: Djinn workspace built successfully with locked dependencies;
Charon's Rust tests passed **547 tests**, with 19 upstream ignored. The Aeneas
Lean backend built **1711 jobs** after downloading 8542 Mathlib cache files.
The unchanged upstream `example/sort` completed `cargo djinn verify` through
axiom audit **PASS** on 2026-10-14 22:31:40 UTC (47s): all ten obligations proved,
two functions fully verified, only `propext`, `Classical.choice`, `Quot.sound`.
This checks the supplied example in the pinned models, not toolchain correctness.

Local OCaml dependency downloads failed TLS connections at distribution hosts;
source-only Aeneas OCaml rebuilding and Charon's OCaml tests remain incomplete.
The operational Aeneas is the official binary at the **same pinned commit**;
its locally built Lean backend uses that commit. No trusted source/model patches,
checksum/TLS bypasses or alternate revisions were used. The official Aeneas
[release](https://github.com/AeneasVerif/aeneas/releases/tag/nightly-2026.10.06-557eff8)
archive SHA256 was `ae80a471e974fafed4a9b5e98e775992fb21177006f46acdf11a302768a39154`;
Lean's official archive SHA256 was `07a633cc8d9151cbc08825ea4cdda50d4b02a2c9cb852c0131b13046f49cad7f`.
Native Linux tests needed GTK3, WebKit2GTK4.1, librsvg, Ayatana appindicator and
libxdo development packages installed with ordinary APT. No live identity was used.

Installed binary SHA256 values (observed again before publication; locally built
Djinn/Charon hashes identify these builds, not universal reproducible binaries):

```text
8b7abc687516ec6a21ed8dc2f55138fa100fd50b814f32faaead57b9bea14488  cargo-djinn
4756c6a51b519932b207a7badc51d7ef2c4183d6ec74c659326acee27f13a618  aeneas
5a73b3a67f119f921014ecca4d8556d73949e4cdb0c54b63b61c6e846e999ab0  charon
e9e2dd5e791afa6421f91c7fca0d22a49f1b57c3017f432453057512b73cf968  charon-driver
e8baaa71855a616dc351028f3ad2200051b0671f423a1696a100e809302d5550  lean
60330ab6f07dce20f3fa9ebb08e8b984ea9549eac172afeb15d9d2227060e2b3  lake
f6636ed825b134896bdbff0b433a0d064df766971b8b6610db5e18165d166aee  translation-rustc
c05be002097e2f2106efeeac03e58032e3f5cca10104f95d7a0ddc0bd3f907cb  z3
```
