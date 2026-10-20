# Temporary Lefthook recovery package

This override builds [Lefthook](https://github.com/evilmartians/lefthook) at
`eb4e504b7c1d1ea6cb1fd29542431cb6d1a93a03` (v2.2.2) with
`lefthook-recovery.patch`. The source archive is SHA-256 pinned in `lefthook.hcl`.
Hermit pins Go 1.27.0 and generates the tool proxies.
The small `bin/lefthook` launcher provisions Go before invoking the generated
`bin/lefthook-runner` proxy: lazy Hermit execution otherwise unpacks Lefthook
before Go, and recursively invoking Hermit inside unpack deadlocks. Hermit 0.52.3 also unpacks explicit installs in parallel: run
`bin/go version` before `bin/hermit install` if provisioning all packages manually.
Normal hook setup uses the launcher and needs no separate Go command.
The build uses `CGO_ENABLED=0`, `-trimpath`, and the upstream Go module checksums.
No private package service, fork release, or global tool replacement is required.

Upstream 2.2.1 isolates worktree patches. Upstream 2.2.2 matches its backup hash,
then drops the captured positional stash ref; an intervening sibling stash can
shift that position and be deleted instead. This patch retains create-only,
compare-and-delete backup refs without changing upstream's patch isolation.
It refuses cleanup without an owned hash, including after a failed save.
Shared owned refs retain backups
during garbage collection from another worktree. The patch includes upstream
unit/integration tests, recovery documentation, and an explicit version change
to `2.2.3-buzz.1` (the version is a source constant, not a linker variable).
The next-patch prerelease version lets `min_version` reject stock 2.2.2;
this is still upstream 2.2.2, not an upstream 2.2.3 release.
Concurrent runs within the same worktree remain unsupported.

## Revalidate or replace

Never change the patch/build under the same package version: Hermit's shared
cache keys by package version. Bump the package, source version edit, repository
`min_version`, and generated proxies together after any change. Do not invoke
`bin/lefthook-runner` directly: `bin/lefthook` is the first-use entry point.

A Git checkout of this PR replaces the old Lefthook symlink/pin with the launcher
and new package pin; no `hermit uninstall` migration is needed. To test a cold
checkout, use a disposable copy with empty `HERMIT_STATE_DIR`, `HOME`, `GOPATH`
and `GOCACHE`, then run `bin/lefthook version` followed by `bin/just hooks` (only
without lhm). Do not clear the machine’s shared cache to perform this check.

To validate independently, unpack the pinned archive into a disposable directory,
apply `git apply /path/to/lefthook-recovery.patch`, and run with Go 1.27.0:

```sh
# Use the resolved toolchain binary: a Hermit proxy prepends repo bin/ to PATH,
# which would make testscript invoke the launcher inside its /no-home sandbox.
go_bin="$(go env GOROOT)/bin/go"
"$go_bin" test -cpu 24 -race -count=1 -timeout=30s ./...
"$go_bin" build -trimpath -buildvcs=false -o lefthook .
PATH="$PWD:$PATH" "$go_bin" test -cpu 24 -race -count=1 -timeout=30s -tags=integration integration_test.go
```

In buzz-app run `bin/node --test tests/integration/*.test.mjs`, including real
lhm by setting `BUZZ_REAL_LHM` to its executable and `BUZZ_STOCK_LEFTHOOK` to the
official 2.2.2 executable. The cleanup regression inserts a sibling stash after
the vulnerable runner's list snapshot, or immediately before the patched runner's
atomic ref deletion. It verifies stash ownership, the index and unstaged edits.
Set `BUZZ_RECOVERY_RUNNER` to an official 2.2.2 executable and run that test alone
to demonstrate the expected failure. No global hooks/configuration are changed.

At the next upstream release, check whether it includes all these protections.
`min_version` rejects stock 2.2.2, **not future stock 2.2.3+**. Remove
the override/patch and the temporary Go pin only after an official version passes
the cleanup-interleaving, overlap, recovery, GC, legacy-stash and machine-policy
regressions. Do not
replace this pin with an unverified newer stock binary.

## License

Lefthook is MIT licensed; its full copyright notice and license accompany this
patch in `lefthook-LICENSE`. The downloaded source and built package retain that
license too.
