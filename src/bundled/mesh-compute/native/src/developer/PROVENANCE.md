# Goose Developer/Skills extraction

Source: https://github.com/aaif-goose/goose at
`69de89c50cc01d4e0187d6645bf3618729873f74` (Apache-2.0, license in `LICENSE`).

Developer source comes from `crates/goose/src/agents/platform_extensions/developer/`:
`shell.rs` and `shell_output_streaming.rs`, including upstream tests.
Tree and file-edit implementations are deliberately omitted. Local catalog: shell, load_skill.

Adaptations: local module imports; explicit timeout instead of Goose global config;
Unix process group/drop cleanup; authentication-environment scrubbing; bounded
256 KiB shell capture before line splitting and collector cleanup on future drop.
The parent module supplies the small notification/subprocess interfaces. Formatting
matches the Buzz workspace. This is not an unchanged upstream extension binary.

Sibling `../skills/` extracts the filesystem scanner, frontmatter/argument rendering
and Unix supporting-file reader from Goose's platform Skills implementation at the
same revision. Its adapter takes explicit roots, with no global Config, built-in
catalog, plugin installer, relay discovery, agent/session manager or database.
Supporting-file reads retain upstream confinement; general shell access
is deliberately not sandboxed. Filesystem tools run with the user's authority.
