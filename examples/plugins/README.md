# Example plugins

All example plugins live here with `manifest.json` and prebuilt `plugin.js` files:

- `counter` and `notes`: offline playgrounds.
- `shortcut-counter`: offline keyboard-shortcut consumer; Command+Shift+K /
  Control+Shift+K increments through the injected host service. Requires `shortcuts`.
- `broken-page`: intentionally fails when its page renders to exercise error handling.
- `remote-ackbot`: a hosted Agents agent type, with a provider server to run on this
  computer. See its README.

## Try the offline playgrounds

Counter and Notes are **ready-to-install**, readable API v1 modules that need no
build tools or runtime dependencies. They use the host's React instance and page service. Neither
makes network requests, writes files, nor reads your account. Plugins generally are
trusted unsandboxed code; these examples do not change that trust model.

1. Open the desktop app → Settings → Plugins → **Load from folder**.
2. Choose this `examples/plugins` folder to see the examples, or choose
   `counter` / `notes` directly for a single result.
3. Choose **Counter playground**, then **Install plugin**. It starts disabled.
4. Enable it in the plugin list, then open its navigation tab and click the counter.
5. Return to Settings, load this parent folder again, install and enable **Notes
   playground**, then type a scratch note on its page.
6. Disable either plugin to remove only its tab; Delete removes its installation.

Counter and note state are ephemeral and reset when leaving their page. To try an
update, change visible text in `counter/plugin.js`, load it again, and choose
**Update plugin**. An enabled plugin stays enabled and its replacement can run
immediately. **Roll back** restores the previous installed revision. Source files
are copied into the installation snapshot, not watched.

To try Git import after these files are pushed, enter this repository's supported
HTTPS/SSH URL and its branch/tag, then select `examples/plugins/counter` or
`examples/plugins/notes`. Private HTTPS authentication is not provided by this
slice; use authenticated SSH with an existing agent and known host when available.
