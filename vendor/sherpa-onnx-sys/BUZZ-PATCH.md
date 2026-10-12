# Verified native speech libraries

This is sherpa-onnx-sys 1.13.4 from crates.io, Apache-2.0.
Upstream crate SHA-256: ffc951af03dc0653c0622158ca8a585a6f2bc43b7b06048cf0e5b5020005c227. The FFI sources
are unchanged apart from repository rustfmt formatting. The workspace patch applies to the safe wrapper's transitive
dependency as well as Buzz's direct dependency, including direct Cargo builds.

The build script pins the five supported static release archives in
archives.sha256. Initial digests came from the GitHub release asset digest
metadata at https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.4.
These pins prevent later asset replacement; they do not attest upstream source
reproducibility. Updating a version requires reviewing and updating these pins.

Downloaded and locally supplied archives are copied into a private snapshot,
SHA-256 checked before extraction, and extracted afresh into the build's OUT_DIR.
Previously extracted caches are never consumed. Cargo watches both the archive
and individual resulting library files for changes. Watching the newly created
directory would invalidate every warm build; archived file mtimes remain intact. Unverified SHERPA_ONNX_LIB_DIR
overrides and unpinned targets/link modes fail closed. SHERPA_ONNX_ARCHIVE_DIR
remains available for offline builds, subject to the same pins. DOCS_RS does not
bypass verification.

Run the regression tests with:
`bin/cargo test -p sherpa-onnx-sys --test archive`

Remove this vendor patch when the pinned upstream build script enforces equivalent
archive verification and cache handling. Keep the binding declarations unchanged.
