// Build only. Never launches the app, authenticates, or reads an old Buzz library.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFile,
  lstat,
  access,
  constants,
  mkdir,
  copyFile,
  chmod,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import { rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeBuildPlatform } from "./runtime-build-platform.mjs";
import { verifiedRuntimePatch } from "./runtime-patch.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(
  await readFile(join(root, "runtime/agent-runtime.json"), "utf8"),
);
const patchBytes = await verifiedRuntimePatch(root, spec.patch);
// `just desktop` skips the pin's size optimizations; packaged builds keep them.
const goose = process.argv.includes("--dev")
  ? { ...spec.goose, profile: spec.gooseDevProfile }
  : spec.goose;
const { env, cargo, rustc } = runtimeBuildPlatform(root);
async function run(command, args, capture = false, cwd = root, childEnv = env) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: childEnv,
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    });
    let output = "";
    child.stdout?.on("data", (data) => {
      output += data;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? accept(output)
        : reject(new Error(`Runtime build failed (${code})`)),
    );
  });
}
const toolchain = await run(rustc, ["-vV"], true);
const target = toolchain.match(/^host: (.+)$/m)?.[1]?.trim();
if (!target) throw new Error("Could not resolve pinned Rust target");
const destination = join(root, "src-tauri/resources/agent-runtime");
const filenames = spec.tools.map((name) =>
  process.platform === "win32" ? `${name}.exe` : name,
);
// One source revision and one frozen workspace lock, no local path/ambient tools.
// A single build shares dependency compilation across the five tools.
const packages = [
  "buzz-acp",
  "buzz-agent",
  "buzz-dev-mcp",
  "buzz-cli",
  "git-credential-nostr",
];
// An explicit host target fixes the output directory even when a user-level
// Cargo config sets build.target.
const buildArgs = [
  "build",
  "--release",
  "--locked",
  "--bins",
  "--target",
  target,
].concat(...packages.map((name) => ["-p", name]));
const gooseBuildArgs = [
  "build",
  "--locked",
  "-p",
  "goose",
  "--bin",
  "goose-acp",
  "--profile",
  goose.profile,
  "--no-default-features",
  "--features",
  goose.features,
  "--target",
  target,
];
// Worktrees of one clone share finished bundles built from identical inputs.
function cachedBundle() {
  let common;
  try {
    common = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return undefined;
  }
  const key = createHash("sha256")
    .update(JSON.stringify([spec, toolchain, buildArgs, gooseBuildArgs]))
    .digest("hex")
    .slice(0, 16);
  return join(common, "buzz-agent-runtime", key);
}
async function verifiedBundle(directory) {
  try {
    if (!(await lstat(directory)).isDirectory()) return false;
    const manifestPath = join(directory, "manifest.json");
    const meta = await lstat(manifestPath);
    if (!meta.isFile() || meta.size > 16384) return false;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (
      Object.keys(manifest).length !== (spec.patch ? 6 : 5) ||
      manifest.version !== 2 ||
      JSON.stringify(manifest.goose) !== JSON.stringify(goose) ||
      manifest.revision !== spec.revision ||
      (manifest.patch ?? null) !== (spec.patch?.sha256 ?? null) ||
      manifest.target !== target ||
      Object.keys(manifest.files).length !== filenames.length
    )
      return false;
    for (const filename of filenames) {
      const path = join(directory, filename);
      if (!(await lstat(path)).isFile()) return false;
      await access(path, constants.X_OK);
      const hash = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
      if (manifest.files[filename] !== hash) return false;
    }
    return true;
  } catch {
    return false;
  }
}
// Copy files first and publish the manifest last: an interrupted copy is
// detected as mismatched, not ready. APFS and similar filesystems clone.
async function publish(source, directory) {
  await mkdir(directory, { recursive: true });
  const files = {};
  for (const filename of filenames) {
    const temporary = join(directory, `${filename}.new`);
    await copyFile(
      join(source, filename),
      temporary,
      constants.COPYFILE_FICLONE,
    );
    await chmod(temporary, 0o755);
    files[filename] = createHash("sha256")
      .update(await readFile(temporary))
      .digest("hex");
    await rename(temporary, join(directory, filename));
  }
  const manifest = {
    version: 2,
    revision: spec.revision,
    goose,
    target,
    files,
    ...(spec.patch ? { patch: spec.patch.sha256 } : {}),
  };
  await writeFile(
    join(directory, "manifest.json.new"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await rename(
    join(directory, "manifest.json.new"),
    join(directory, "manifest.json"),
  );
  return manifest;
}
async function prepare() {
  if (await verifiedBundle(destination)) {
    console.log(`Agent runtime ready (${spec.revision}, ${target})`);
    return;
  }
  const cache = cachedBundle();
  const existing = cache && (await lstat(cache).catch(() => undefined));
  const cached = existing && (await verifiedBundle(cache));
  if (cached) {
    // A copy that fails (e.g. the entry was removed mid-copy) rebuilds below.
    const restored = await publish(cache, destination).catch(() => undefined);
    if (restored) {
      console.log(
        `Verified inputs restored from ${cache} (${spec.revision}, ${target})`,
      );
      return;
    }
  } else if (existing) {
    // Seen before verifying: entries appear whole by rename, so this one was
    // edited. A key missing at check time is never removed, since a concurrent
    // build may publish it.
    await rm(cache, { recursive: true, force: true });
  }
  console.log(
    "Preparing the agent runtime; the first build can take several minutes.",
  );
  // Sources persist at stable paths beside the build target, so after a pin bump
  // Cargo recompiles only crates whose files changed, and an interrupted build
  // resumes. This checkout's Cargo config applies but only sets the target
  // directory, which CARGO_TARGET_DIR overrides.
  const sources = join(root, "target/agent-runtime-src");
  async function checkout(directory, repository, revision) {
    // A checkout interrupted mid-command can leave Git locks behind; start over once.
    for (const retry of [false, true]) {
      try {
        await mkdir(directory, { recursive: true });
        await run("git", ["init", "--quiet"], false, directory);
        await run(
          "git",
          ["fetch", "--quiet", "--depth", "1", repository, revision],
          false,
          directory,
        );
        await run(
          "git",
          ["checkout", "--quiet", "--force", "--detach", revision],
          false,
          directory,
        );
        return;
      } catch (error) {
        if (retry) throw error;
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
  const source = join(sources, "buzz");
  await checkout(source, spec.repository, spec.revision);
  if (patchBytes) {
    const patchPath = join(sources, "verified.patch");
    await writeFile(patchPath, patchBytes, { mode: 0o600 });
    await run("git", ["apply", "--check", patchPath], false, source);
    await run("git", ["apply", patchPath], false, source);
  }
  await run(cargo, buildArgs, false, source);
  // Goose is an independent upstream pin, built with the same locked toolchain.
  const gooseSource = join(sources, "goose");
  await checkout(gooseSource, goose.repository, goose.revision);
  await run(cargo, gooseBuildArgs, false, gooseSource, {
    ...env,
    OPENSSL_STATIC: "1",
    OPENSSL_NO_VENDOR: "0",
  });
  const output = join(env.CARGO_TARGET_DIR, target, "release");
  const gooseBinary = join(
    env.CARGO_TARGET_DIR,
    target,
    // Cargo names the dev profile's output directory "debug".
    goose.profile === "dev" ? "debug" : goose.profile,
    process.platform === "win32" ? "goose-acp.exe" : "goose-acp",
  );
  if (process.platform === "darwin") {
    const libraries = await run("otool", ["-L", gooseBinary], true);
    for (const line of libraries.trim().split("\n").slice(1)) {
      const library = line.trim().split(" (compatibility version")[0];
      if (
        !library.startsWith("/usr/lib/") &&
        !library.startsWith("/System/Library/")
      )
        throw new Error(`Unbundled Goose dependency: ${library}`);
    }
  }
  await copyFile(gooseBinary, join(output, basename(gooseBinary)));
  await publish(output, destination);
  console.log(
    `Verified inputs staged at ${destination} (${spec.revision}, ${target})`,
  );
  // Entries are published whole by rename; caching is best-effort.
  if (cache && !cached) {
    const entry = `${cache}.${process.pid}.new`;
    try {
      await publish(destination, entry);
      // Renaming onto an existing entry fails: a concurrent build published first.
      await rename(entry, cache);
    } catch {
      // Keep the other build's entry.
    } finally {
      await rm(entry, { recursive: true, force: true });
    }
  }
}

// Fail closed on overlap: never remove another process's Git checkout or staging
// files. A force-killed process can leave Cargo/Git children alive, so its stale
// lock requires explicit cleanup after those processes have stopped.
const preparationLock = join(root, "target/agent-runtime-prepare.lock");
await mkdir(dirname(preparationLock), { recursive: true });
try {
  await mkdir(preparationLock);
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  throw new Error(
    `Runtime preparation already in progress: ${preparationLock}. Retry after it finishes. If it was force-killed, stop its Git/Cargo processes before removing this lock.`,
  );
}
// Ctrl-C skips `finally`; the terminal signals Git and Cargo too.
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    rmSync(preparationLock, { recursive: true, force: true });
    process.exit(1);
  });
try {
  await writeFile(join(preparationLock, "owner"), `${process.pid}\n`);
  await prepare();
} finally {
  await rm(preparationLock, { recursive: true, force: true });
}
