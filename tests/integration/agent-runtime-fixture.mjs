import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Real preparation script and manifest; only the compiler toolchain is synthetic.
export function runtimeFixture(directory) {
  for (const name of ["scripts", "runtime", "bin"])
    mkdirSync(path.join(directory, name), { recursive: true });
  for (const name of [
    "scripts/build-agent-runtime.mjs",
    "scripts/runtime-build-platform.mjs",
    "scripts/runtime-patch.mjs",
    "runtime/agent-runtime.json",
  ])
    copyFileSync(
      new URL(`../../${name}`, import.meta.url),
      path.join(directory, name),
    );
  const spec = JSON.parse(
    readFileSync(path.join(directory, "runtime/agent-runtime.json"), "utf8"),
  );
  if (spec.patch) {
    mkdirSync(path.dirname(path.join(directory, spec.patch.path)), {
      recursive: true,
    });
    copyFileSync(
      new URL(`../../${spec.patch.path}`, import.meta.url),
      path.join(directory, spec.patch.path),
    );
  }
  const tool = (name, body) =>
    writeFileSync(
      path.join(directory, "bin", name),
      `#!${process.execPath}\n${body}\n`,
      { mode: 0o755 },
    );
  tool("rustc", 'console.log("host: fixture-target");');
  // Cargo runs inside the fetched source checkout, so fixture state is absolute.
  tool(
    "cargo",
    `
(async () => {
const fs = require("node:fs");
const path = require("node:path");
const fixture = ${JSON.stringify(directory)};
fs.appendFileSync(path.join(fixture, "build-calls.jsonl"), JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + "\\n");
const hold = path.join(fixture, "hold-build");
if (fs.existsSync(hold)) {
  const port = Number(fs.readFileSync(hold, "utf8"));
  fs.unlinkSync(hold);
  await new Promise((resolve, reject) => {
    const socket = require("node:net").connect(port, "127.0.0.1");
    socket.once("data", () => { socket.end(); resolve(); });
    socket.once("error", reject);
  });
}
if (fs.existsSync(path.join(fixture, "fail-build"))) process.exit(17);
// Shell compiler overrides must not reach a build whose bundle other worktrees reuse.
if (["RUSTFLAGS", "RUSTC_WRAPPER", "CARGO_PROFILE_RELEASE_OPT_LEVEL"].some((key) => key in process.env)) process.exit(18);
// Lets a test run another worktree's preparation while this build is in flight.
const during = path.join(fixture, "during-build");
if (fs.existsSync(during)) require("node:child_process").execFileSync(process.execPath,
  ["scripts/build-agent-runtime.mjs"], { cwd: fs.readFileSync(during, "utf8"), stdio: "ignore" });
// Like Cargo, --target (or a user-level build.target) nests the output by triple.
const flag = process.argv.indexOf("--target");
const configured = path.join(fixture, "config-build-target");
const triple = flag >= 0 ? process.argv[flag + 1]
  : fs.existsSync(configured) ? fs.readFileSync(configured, "utf8") : "";
const profileFlag = process.argv.indexOf("--profile");
const output = path.join(process.env.CARGO_TARGET_DIR, triple,
  // Like Cargo, the dev profile writes to "debug".
  profileFlag < 0 ? "release" : process.argv[profileFlag + 1] === "dev" ? "debug" : process.argv[profileFlag + 1]);
fs.mkdirSync(output, { recursive: true });
// Compilation progress that an interrupted build leaves for the next one.
const progress = path.join(process.env.CARGO_TARGET_DIR, "progress");
fs.appendFileSync(path.join(fixture, "resumed.jsonl"), JSON.stringify(fs.existsSync(progress)) + "\\n");
fs.writeFileSync(progress, "");
if (fs.existsSync(path.join(fixture, "interrupt-build"))) process.exit(130);
// Like Cargo, emit only the requested binaries, not the final bundle's inventory.
const binFlag = process.argv.indexOf("--bin");
const names = binFlag >= 0 ? [process.argv[binFlag + 1]]
  : process.argv.flatMap((arg, index) => arg === "-p"
    ? [process.argv[index + 1] === "buzz-cli" ? "buzz" : process.argv[index + 1]] : []);
for (const name of names) fs.writeFileSync(path.join(output,
  process.platform === "win32" ? name + ".exe" : name), "fixture " + name + " " + fixture, { mode: 0o755 });
})().catch((error) => { console.error(error); process.exit(1); });
`,
  );
  tool(
    "otool",
    'console.log("fixture:\\n\\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)");',
  );
  // Source fetches succeed offline; a git-common-dir file opts into the shared cache.
  tool(
    "git",
    `
const fs = require("node:fs");
const path = require("node:path");
const common = path.join(${JSON.stringify(directory)}, "git-common-dir");
// Stands in for a checkout an interrupted run left locked.
if (fs.existsSync("broken-checkout")) process.exit(128);
if (!process.argv.includes("rev-parse")) process.exit(0);
if (!fs.existsSync(common)) process.exit(128);
console.log(fs.readFileSync(common, "utf8"));
`,
  );
}
