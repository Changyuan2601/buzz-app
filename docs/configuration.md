# Deployment configuration: current-feature parity

Buzz Foundation supports configuration for capabilities that exist here, not a
port of every OG Buzz feature. Keep deployment values in local/CI configuration,
not in source. Build defaults are readable binary data, **never secret storage**.

## Supported inputs and surfaces

| Input | Consumer and boundary |
| --- | --- |
| `BUZZ_BUILD_AGENT_ENV` | Native build: allowlisted multiline Databricks host/model/filter defaults. Runtime, OAuth/discovery and editor share one compiled floor. |
| `BUZZ_BUILD_BUZZ_AGENT_PROVIDER` | Native build: lowest-precedence Buzz Agent provider, never a default for other harnesses. |
| `BUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY` | Native build: presence-only local listener policy clamp, including saved/imported agents. |
| `BUZZ_BUILDERLAB_URL` | Shared frontend/native build: public login URL and the bundled plugin's exact HTTPS host grant; no runtime override. |
| `BUZZ_RELAY_URL` | Live development broker's default community, not an agent relay override or a packaged default. |
| `BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY` | Presence-only alias for fresh-viewer community selection in live development only. Saved viewer choice wins. |
| `BUZZ_DEV_OPEN_RELAY` | Development-specific override of that alias: only `1` enables; `0` explicitly opts out. Requires a relay URL and live viewer pin to have an effect. |
| `BUZZ_DEV_VIEWER`, `BUZZ_COMMUNITY_ALIASES`, `BUZZ_DEV_NOTIFICATIONS` | Existing public viewer pin, public routing aliases and dev notification override; unchanged. See the [development setup](contributing.md). |
| `BUZZ_UPDATER_PUBLIC_KEY`, `BUZZ_UPDATER_ENDPOINT` | Native release build, process environment only: two non-empty values register the updater plugin. The same public key and endpoint must reach `tauri build --config` as `plugins.updater`, and update archives must be signed by the matching private key. The macOS prerelease workflow supplies both (see [releases](releases.md)); other builds report automatic updates as unavailable. |

The three native agent inputs read only repository-root `.env.local` plus explicit
process values. Process presence wins, even empty. No `.env.production`, arbitrary
environment passthrough or runtime environment inheritance is added. See the
[agent-default precedence and example](agent-control.md#nonsecret-build-defaults).
Restart/rebuild native code to change compiled defaults. Restart Vite to change
broker/routing configuration. Browser-only builds have no native agent controller;
production frontend builds neither load the dev broker nor expose the auto-open
seed. Native settings do not enter Vite `define` or runtime-resource builds.

Cargo watches `.env.local` even when it is absent so creating it later is detected.
A missing watched file makes Cargo rerun the controller build script on each
invocation and can rebuild dependent native crates. To avoid that cost when no
local defaults are needed, create an empty repository-root `.env.local` once
(`touch .env.local` preserves existing contents). Do not touch it on every build;
normal edits and removal must continue to invalidate compiled defaults.

An unset provider build flag does not select Databricks on behalf of an existing
blank agent. The Create form retains its existing Databricks suggestion when no
provider floor exists. Supplying a provider floor leaves the saved selector blank
so later build defaults can take effect. Saved explicit settings remain explicit.

## Builderlab URL build input

Set `BUZZ_BUILDERLAB_URL` in repository-root `.env.local` for development, or in
the process running `bin/pnpm build` / `bin/pnpm tauri build` for packaging:

```sh
BUZZ_BUILDERLAB_URL=https://app.builderlab.xyz bin/pnpm tauri build
```

Vite uses its existing environment loader; the native plugin-manager build reads
repository-root `.env.local` and process values using the native dotenv pattern.
For desktop, supply the full URL in `.env.local` or the build process environment
so both stages receive it. Vite's additional `.env` and mode-specific files do
not configure native grants. Process values take precedence, including an
explicit empty value. When unset or empty, login is unconfigured and no network
origin is granted. The repository supplies no deployment default.

Any HTTPS host is supported, including an explicit port or deployment path. URL
credentials, query parameters and fragments are rejected by the native build.
The desktop's native plugin catalog supplies the effective manifest, granting
only the configured URL's exact origin. Never put credentials in this input.

The bundled Builderlab login consumes this public URL and appends `/api/goose`.

Restart desktop development after changing this input so Vite and the native
grant rebuild together; browser-only development needs a Vite restart. Production
web and desktop frontend builds substitute the value into compiled code: changing `.env.local`
or the launched app's environment afterward cannot override it. Rebuild and
redistribute to change a packaged value.

## Whole-video limit

The desktop app reads relay video from its origin one bounded `Range` at a
time. When an origin ignores it and answers a video with a whole `200`, the app
copies that video to a temporary file, up to the development broker's 500 MiB
video limit, and answers the player's requests from the file as bytes arrive.
The limit is the compile-time constant `WHOLE_VIDEO_MAX` in
`src-tauri/src/relay.rs`; edit it and rebuild to change it.

- A video of exactly the limit plays. A larger `Content-Length` is rejected with
  413 before any download; without one, the download stops and is rejected once
  it passes the limit. Without a `Content-Length`, playback starts once the
  whole video has arrived, since a range answer needs the total size.
- At most two such files exist at once, each anonymous and deleted by the OS
  when it closes. Opening a third drops the least recently used one. A file is
  kept while a player's connection to it is open or a read waits for its
  bytes, and for 60 seconds after; then it is dropped, stopping its download,
  and playing the video again downloads it again.

## Deliberate exclusions

Inventory source: `block/buzz-releases` at
`af57fbf40b50941c03cef2466b1e6970ab6bc779` (`.buildkite/pipeline*.yml`,
`scripts/build-macos.sh`, mobile helpers, `scripts/lib.sh` and publishing helpers),
compared with OG `block/buzz` at
`99c2acf90cfbb1cb2d3a8bd900c0ec1642e20540` (`desktop/src-tauri/build.rs` and its
runtime consumers). No deployment-specific values from those repositories are
copied here.

| OG/release input | Why it is not implemented here |
| --- | --- |
| `BUZZ_DESKTOP_BUILD_RELAY_URL`; packaged auto-connect | No packaged default or auto-join is configured. Native macOS, Windows and Linux use the persisted identity and restore only the selected saved community; new admission uses Add a community. Windows/Linux installed-app acceptance remains unverified. The dev broker and saved agent destinations remain separate. See [packaged identity](identity.md). |
| `BUZZ_BUILD_RELAY_RECONNECT_CMD` | No reconnect-command feature; arbitrary deployment command execution is not added. |
| Updater helper fallback aliases | Only the two canonical updater names above are read. Private signing keys never belong in app defaults. |
| `--features mesh-llm` | No mesh/provider integration in this local controller; unsupported imported mesh/team/remote agents still fail closed. |
| `BUZZ_BUILD_OBSERVER_ARCHIVE_DEFAULT`, `BUZZ_BUILD_AGENT_METRIC_ARCHIVE_DEFAULT` | Already no-ops in inspected OG: its archive capability checks return true for all builds. This app does not claim equivalent archive collection by accepting inert flags. |
| Build-command `BUZZ_ACP_ALLOWED_RESPOND_TO`, `BUZZ_ACP_ALLOWED_CHANNEL_ADD_POLICIES` | OG consumers are runtime-only; setting these around compilation does not bake them. The supported owner-only capability uses the existing local listener enforcement boundary instead. |
| Mobile `BUZZ_AGE_GATING_ENABLED`, Android `BUZZ_ANDROID_RELEASE_SIGNING=external` | No corresponding Flutter/Android target in this app. |
| CI version/tag metadata, artifact paths/upload controls, signing teams/profiles, Apple/App Store/Artifactory/Play credentials, Android signer roles/sockets, SDK/JDK/toolchain settings, Tauri bundle/config arguments | Release infrastructure and packaging controls, not product defaults. No new build-variable forwarding API. |

Ignored `.env.local` can contain unrelated development settings, but the native
agent build compiles only its three allowlisted keys. Unrelated syntax is ignored;
quoted multiline records are skipped as a whole, including the rest of the file when
an unrelated quote is unclosed. Selected, non-overridden build assignments still
require valid dotenv syntax. Unknown keys **inside**
`BUZZ_BUILD_AGENT_ENV` fail closed instead of silently implying support. Do not
use any build input for private keys, tokens or raw agent configuration.
