# Packaged voice calls

Proposed distribution, October 28, 2026.

Buzz can ship Berd Call without the Berd desktop app. The distribution consists of a self-contained plugin module and manifest, small launchers, and the standalone native `berd-call` executable. Plugin code remains maintained outside Buzz against the author contract.

The intended release pin records an exact source revision and SHA-256 digest for each artifact. A release must not follow a branch or select the latest version at runtime. Buzz's application update owns the installed version; the packaged plugin does not run a personal configuration repository updater.

The initial native target is macOS on Apple silicon. Native resources use the existing plugin process `bundled: true` grant, which resolves exclusively to `bin` inside Buzz's resources. Model downloads remain in the user's cache. Berd.app, Goose, and a globally installed CLI are not runtime dependencies.

The standalone release archive contract is `berd-call_<version>_darwin-aarch64.tar.gz`, containing one regular executable named `berd-call` at its root. The matching release provenance records the archive digest. The executable keeps the upstream Developer ID signature until the containing Buzz release's signing workflow handles it.

The plugin distribution must preserve the current plugin settings-file location, read endpoint credentials through Keychain, and invoke the adjacent packaged executable. Packaging must not substitute a binary found on PATH. The host's existing plugin enable/disable state remains authoritative, including when replacing a formerly installed copy with the same plugin ID.

This document records the intended integration. The first compatible plugin/native release and their concrete pins are still being prepared. No signed Buzz release or first-run permission acceptance is established by these notes.

## Pinned plugin artifact

`runtime/berd-call-plugin.json` records the plugin source commit and checksums. The three files under `runtime/berd-call-plugin/` are copied byte for byte from the upstream [bundled distribution](https://github.com/squareup/jtennant-agent-config/tree/f5cb6bd51f0e7e5eb64cf72e974aebbc907b9a1c/buzz-plugins/berd-call/bundled). Update them by reading that directory from an exact Git commit, rebuilding upstream when behavior needs changing, and updating all three digests in the same review. Do not edit or reformat the built artifacts in Buzz.

`node scripts/stage-berd-call-plugin.mjs` verifies all three files before staging `berd-call-start` into the app's native `bin` resources. It removes a stale launcher on unsupported targets. The launcher invokes only its adjacent executable and retains upstream Keychain and settings-file handling.

Neither staging command is wired into ordinary app builds yet, and this plugin is not registered in the catalog. Activation, replacement of an existing external installation and preservation of its disabled state must land together with a compatible native release pin. The unpublished internal archive used for producer/consumer testing is not a release pin.
