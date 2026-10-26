// Builds the buzzodz plugin manager and stages it beside goose-acp, so every
// package ships it in its `bin` resources. Tauri names the target it builds for
// in TAURI_ENV_TARGET_TRIPLE; without it, buzzodz is built for this machine.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const triple = process.env.TAURI_ENV_TARGET_TRIPLE || undefined;
const name = (
  triple
    ? triple.includes("windows")
    : process.platform === "win32"
)
  ? "buzzodz.exe"
  : "buzzodz";
const result = spawnSync(
  "cargo",
  [
    "build",
    "--locked",
    "--release",
    "-p",
    "buzzodz-plugins",
    "--bin",
    "buzzodz",
    ...(triple ? ["--target", triple] : []),
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0)
  throw new Error(`cargo build failed (${result.status})`);
const destination = join(root, "src-tauri/resources/bin");
const binary = join(destination, name);
// Replace the binary whole, as build-goose-acp.mjs does.
mkdirSync(destination, { recursive: true });
copyFileSync(
  join(root, "target", triple ?? "", "release", name),
  `${binary}.new`,
);
chmodSync(`${binary}.new`, 0o755);
renameSync(`${binary}.new`, binary);
console.log(`buzzodz staged at ${binary}`);
