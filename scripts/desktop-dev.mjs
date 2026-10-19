import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { desktopOverlay, options } from "./desktop-config.mjs";
import {
  eraseSandbox,
  sandboxConfig,
  sandboxPaths,
  validSandbox,
  webviewStore,
} from "./desktop-sandbox.mjs";
import { portForPath, worktreePort } from "./worktree-port.mjs";

// --fresh and --fresh-keep-identity take no value, so they leave before
// options(), which would read the next argument as one.
const all = process.argv.slice(2);
const end = all.includes("--") ? all.indexOf("--") : all.length;
const fresh = all.slice(0, end).filter((arg) => arg.startsWith("--fresh"));
const args = all.filter((arg, index) => index >= end || !fresh.includes(arg));
const { values, forwarded, rest } = options(args, ["port", "sandbox"]);
const sandbox = values.sandbox;
if (sandbox !== undefined && !validSandbox(sandbox)) {
  console.error("--sandbox must be 1-32 lowercase letters, digits or hyphens.");
  process.exit(1);
}
const unknown = fresh.find(
  (arg) => arg !== "--fresh" && arg !== "--fresh-keep-identity",
);
if (unknown || (fresh.length && sandbox === undefined) || fresh.length > 1) {
  console.error(
    unknown
      ? `Unknown option ${unknown}.`
      : fresh.length > 1
        ? "Pass only one of --fresh and --fresh-keep-identity."
        : `${fresh[0]} erases a sandbox; name one with --sandbox <name>.`,
  );
  process.exit(1);
}
if (
  values.port !== undefined &&
  (!/^[0-9]+$/.test(values.port) ||
    Number(values.port) < 1 ||
    Number(values.port) > 65535)
) {
  console.error("--port must be an integer between 1 and 65535.");
  process.exit(1);
}
const port = values.port === undefined ? undefined : Number(values.port);

const help = forwarded.some((arg) => arg === "--help" || arg === "-h");
// Build the bundled goose-acp before Tauri compiles, so a cold build does not
// count against its dev-server timeout. Local runs skip the size optimizations.
if (!help) {
  // Build for the target Tauri is given, as Tauri tells beforeBuildCommand.
  const at = forwarded.findIndex((arg) => arg === "--target" || arg === "-t");
  const triple =
    at === -1
      ? forwarded.find((arg) => arg.startsWith("--target="))?.slice(9)
      : forwarded[at + 1];
  const goose = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./build-goose-acp.mjs", import.meta.url)), "--dev"],
    {
      stdio: "inherit",
      env: triple
        ? { ...process.env, TAURI_ENV_TARGET_TRIPLE: triple }
        : process.env,
    },
  );
  if (goose.error) console.error(goose.error.message);
  if (goose.signal) process.kill(process.pid, goose.signal);
  // Work that never touches Goose should still start; Goose then says
  // goose-acp is missing.
  if (goose.status !== 0)
    console.warn("goose-acp did not build; Goose agents will not start.");
}
const root = fileURLToPath(new URL("../", import.meta.url));
const config = desktopOverlay(root);
// Tauri's own --port controls its static-file server, not our Vite server.
// Without --port, each worktree derives its own stable port; vite.config.ts
// derives the same one, so devUrl and Vite's strict port cannot disagree.
// A sandbox gets its own port too, so its WebView origin differs from this
// worktree's ordinary dev app and the two can run side by side.
const devPort =
  port ??
  (sandbox === undefined
    ? worktreePort(root)
    : portForPath(`${root}#sandbox:${sandbox}`));
const env = { ...process.env };
if (sandbox !== undefined && !help) {
  if (process.platform !== "darwin") {
    console.error("--sandbox is supported on macOS only.");
    process.exit(1);
  }
  if (fresh.length) {
    if (!(await free(devPort))) {
      console.error(
        `Sandbox ${sandbox} looks like it is running (port ${devPort} is in use); quit it before erasing.`,
      );
      process.exit(1);
    }
    const { removed, keychain } = eraseSandbox(sandbox, {
      keepIdentity: fresh[0] === "--fresh-keep-identity",
    });
    console.log(
      `Erased sandbox ${sandbox}: ${removed.length} folders or files, ` +
        `${keychain.length ? keychain.join(", ") : "no Keychain items"}.`,
    );
  }
  const paths = sandboxPaths(sandbox);
  const conf = JSON.parse(
    readFileSync(
      new URL("../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  );
  Object.assign(config, sandboxConfig(sandbox, conf));
  Object.assign(env, {
    BUZZ_DEV_SANDBOX: sandbox,
    BUZZ_DEV_WEBVIEW_STORE: webviewStore(paths),
    // Plugin storage, which otherwise lives in the shared app folder.
    BUZZODZ_HOME: paths.appData,
  });
  delete env.BUZZODZ_PROFILE;
  console.log(
    `Sandbox ${sandbox}: ${paths.identifier}. ` +
      "Run again with --fresh to start over from first run.",
  );
}
config.build = {
  devUrl: `http://localhost:${devPort}`,
  beforeDevCommand: `pnpm dev:desktop --port ${devPort}`,
};
if (!help)
  console.log(
    `Desktop dev server on ${config.build.devUrl}` +
      (port === undefined
        ? " (derived from the worktree path; pass --port to override)"
        : ""),
  );
// Prepend: Tauri treats everything after a bare positional as runner args.
// Explicit user configs merge afterward and retain precedence.
forwarded.unshift("--config", JSON.stringify(config));
// Runner/application arguments after -- belong to Tauri, including any --port.
forwarded.push(...rest);
// Vite normally reads .env.local only in its own process. Give Rust the same
// effective public pin (including an explicit empty override), so native agent
// starts select the signer that the development frontend actually uses.
// A sandbox is a clean install, so it never borrows the development viewer.
const viewer =
  sandbox === undefined
    ? (loadEnv("development", process.cwd(), "BUZZ_DEV_VIEWER")
        .BUZZ_DEV_VIEWER ?? "")
    : "";
const result = spawnSync("pnpm", ["tauri", "dev", ...forwarded], {
  stdio: "inherit",
  env: { ...env, BUZZ_DEV_VIEWER: viewer },
});
if (result.error) console.error(result.error.message);
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);

function free(port) {
  return new Promise((resolve) => {
    const server = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "localhost");
  });
}
