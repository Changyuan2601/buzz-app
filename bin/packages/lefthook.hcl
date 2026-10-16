// Temporary worktree-recovery fix; see lefthook-recovery.md before changing this pin.
description = "Lefthook with isolated worktree recovery"
repository = "https://github.com/evilmartians/lefthook"
binaries = ["lefthook-runner"]
requires = ["go-1.27.0"]
strip = 1
source = "https://codeload.github.com/evilmartians/lefthook/tar.gz/eb4e504b7c1d1ea6cb1fd29542431cb6d1a93a03"
sha256 = "4673f65cdd9ef336dce25f0f0d66823aa4217630741cc265fec1a8522a5196ed"
version "2.2.3-buzz.1" {}

on "unpack" {
  copy { from = "lefthook-recovery.patch" to = "${root}/recovery.patch" }
  run {
    cmd = "/bin/sh"
    args = ["-s"]
    stdin = "set -eu; unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR; export GIT_CEILING_DIRECTORIES=\"$(dirname \"$PWD\")\"; git apply recovery.patch"
  }
  // bin/lefthook provisions Go before entering Hermit's unpack lock.
  run {
    cmd = "/bin/sh"
    args = ["-s", "--", "${root}/../go-1.27.0/bin/go"]
    stdin = "export GOTOOLCHAIN=local CGO_ENABLED=0; unset GOROOT; exec \"$1\" build -trimpath -buildvcs=false -o lefthook-runner ."
  }
}
