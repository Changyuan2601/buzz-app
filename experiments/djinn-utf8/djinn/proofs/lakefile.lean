import Lake
open Lake DSL

require aeneas from "../../../../../rust-djinn/tools/aeneas/backends/lean"

package «buzz-utf8-proof» {}

@[default_target] lean_lib «Utf8Tail» {}
