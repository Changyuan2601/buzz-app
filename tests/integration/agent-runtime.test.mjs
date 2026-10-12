import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runtimeFixture } from "./agent-runtime-fixture.mjs";
import { verifiedRuntimePatch } from "../../scripts/runtime-patch.mjs";

test("runtime patch checksum is checked before cached resources can be reused", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "buzz-runtime-patch-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  runtimeFixture(directory);
  const spec = JSON.parse(
    readFileSync(path.join(directory, "runtime/agent-runtime.json"), "utf8"),
  );
  const patch = await verifiedRuntimePatch(directory, spec.patch);
  const original = readFileSync(path.join(directory, spec.patch.path));
  assert.deepEqual(patch, original);
  writeFileSync(path.join(directory, spec.patch.path), "changed after review");
  // Builds apply these retained bytes, even if the original changes during fetch.
  const staged = path.join(directory, "verified.patch");
  writeFileSync(staged, patch);
  assert.deepEqual(readFileSync(staged), original);
  await assert.rejects(
    verifiedRuntimePatch(directory, spec.patch),
    /checksum mismatch/,
  );
  await assert.rejects(
    verifiedRuntimePatch(directory, { path: "../outside.patch", sha256: "" }),
    /inside the repository/,
  );
});

test("native library and bundled tools pin the same immutable source", () => {
  const spec = JSON.parse(
    readFileSync(
      new URL("../../runtime/agent-runtime.json", import.meta.url),
      "utf8",
    ),
  );
  // Let Cargo parse its own manifest rather than duplicating TOML parsing here.
  const metadata = spawnSync(
    fileURLToPath(new URL("../../bin/cargo", import.meta.url)),
    ["metadata", "--format-version=1", "--no-deps", "--locked", "--offline"],
    {
      cwd: new URL("../../", import.meta.url),
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.ifError(metadata.error);
  assert.equal(metadata.status, 0, metadata.stderr);
  const app = JSON.parse(metadata.stdout).packages.find(
    (pkg) => pkg.name === "buzz-foundation",
  );
  assert.ok(app, "native app package must be present");
  const agent = app.dependencies.find(
    (dependency) => dependency.name === "buzz-agent",
  );
  assert.ok(agent, "native app must declare its buzz-agent dependency");
  assert.match(spec.revision, /^[0-9a-f]{40}$/);
  assert.equal(
    agent.source,
    `git+${spec.repository}?rev=${spec.revision}`,
    "Update src-tauri/Cargo.toml and runtime/agent-runtime.json together",
  );
});

test("runtime preparation builds missing resources, reuses verified files, and repairs stale or corrupt bundles", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "buzz-agent-runtime-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  runtimeFixture(directory);
  const run = () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/build-agent-runtime.mjs"],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const bundle = path.join(directory, "src-tauri/resources/agent-runtime");
  const manifestPath = path.join(bundle, "manifest.json");
  const count = () =>
    readFileSync(path.join(directory, "build-calls.jsonl"), "utf8")
      .trim()
      .split("\n").length;
  assert.match(run(), /Verified inputs staged/);
  assert.equal(count(), 2);
  assert.match(run(), /Agent runtime ready/);
  assert.equal(count(), 2, "warm preparation must not invoke Cargo");
  const filename =
    process.platform === "win32" ? "buzz-agent.exe" : "buzz-agent";
  const binary = path.join(bundle, filename);
  for (const mutation of [
    () => writeFileSync(binary, "corrupt"),
    () => rmSync(binary),
    () => writeFileSync(manifestPath, "not json"),
    () =>
      writeFileSync(
        manifestPath,
        " ".repeat(16385) + readFileSync(manifestPath, "utf8"),
      ),
    () => {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.unexpected = true;
      writeFileSync(manifestPath, JSON.stringify(manifest));
    },
    ...["revision", "target", "version", "goose"].map((key) => () => {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest[key] = "outdated";
      writeFileSync(manifestPath, JSON.stringify(manifest));
    }),
    ...(process.platform === "win32" ? [] : [() => chmodSync(binary, 0o644)]),
  ]) {
    const before = count();
    mutation();
    assert.match(run(), /Verified inputs staged/);
    assert.equal(count(), before + 2);
    assert.ok(existsSync(binary));
    assert.match(run(), /Agent runtime ready/);
    assert.equal(count(), before + 2);
  }
});

test("desktop dev builds Goose with the dev profile; packaged preparation keeps the pinned one", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "buzz-agent-runtime-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  runtimeFixture(directory);
  const spec = JSON.parse(
    readFileSync(path.join(directory, "runtime/agent-runtime.json"), "utf8"),
  );
  assert.notEqual(spec.gooseDevProfile, spec.goose.profile);
  const run = (...args) => {
    const result = spawnSync(
      process.execPath,
      ["scripts/build-agent-runtime.mjs", ...args],
      { cwd: directory, encoding: "utf8", timeout: 10_000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const calls = () =>
    readFileSync(path.join(directory, "build-calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const recorded = () =>
    JSON.parse(
      readFileSync(
        path.join(directory, "src-tauri/resources/agent-runtime/manifest.json"),
        "utf8",
      ),
    ).goose;
  const sources = path.join(directory, "target/agent-runtime-src");
  // Packaging after desktop dev must replace the dev bundle, never accept it.
  for (const [args, profile] of [
    [[], spec.goose.profile],
    [["--dev"], spec.gooseDevProfile],
    [[], spec.goose.profile],
  ]) {
    assert.match(run(...args), /Verified inputs staged/);
    assert.deepEqual(recorded(), { ...spec.goose, profile });
    const gooseBuild = calls().at(-1);
    assert.equal(
      gooseBuild.args[gooseBuild.args.indexOf("--profile") + 1],
      profile,
    );
    assert.match(run(...args), /Agent runtime ready/);
  }
  // Rebuilds reuse stable source checkouts, so Cargo can skip unchanged crates.
  assert.deepEqual(
    [...new Set(calls().map((call) => call.cwd))],
    [path.join(sources, "buzz"), path.join(sources, "goose")].map((dir) =>
      realpathSync(dir),
    ),
  );
});

// Starts dev preparation and resolves once its first compiler call is held open.
async function heldPreparation(t, directory, options = {}) {
  const server = createServer();
  const started = once(server, "connection");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  writeFileSync(
    path.join(directory, "hold-build"),
    String(server.address().port),
  );
  const child = spawn(
    process.execPath,
    ["scripts/build-agent-runtime.mjs", "--dev"],
    { cwd: directory, stdio: ["ignore", "ignore", "pipe"], ...options },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completed = once(child, "close");
  const [socket] = await Promise.race([
    started,
    completed.then(([code]) => {
      throw new Error(
        `Preparation exited before reaching the compiler (${code}): ${stderr}`,
      );
    }),
  ]);
  return { child, socket, completed, stderr: () => stderr };
}

test("overlapping preparation cannot replace another build's source checkout", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "buzz-agent-runtime-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  runtimeFixture(directory);
  const { socket, completed, stderr } = await heldPreparation(t, directory);
  const marker = path.join(
    directory,
    "target/agent-runtime-src/buzz/broken-checkout",
  );
  try {
    writeFileSync(marker, "owned by the first preparation");
    const competing = spawnSync(
      process.execPath,
      ["scripts/build-agent-runtime.mjs"],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.ifError(competing.error);
    assert.notEqual(
      competing.status,
      0,
      "overlapping preparation must be rejected",
    );
    assert.match(competing.stderr, /Runtime preparation already in progress/);
    assert.equal(
      readFileSync(marker, "utf8"),
      "owned by the first preparation",
    );
    assert.equal(
      readFileSync(path.join(directory, "build-calls.jsonl"), "utf8")
        .trim()
        .split("\n").length,
      1,
    );
  } finally {
    socket.end("release");
    const [code] = await completed;
    assert.equal(code, 0, stderr());
  }
  // A force-killed preparation's lock is retained until explicitly cleared.
  const lock = path.join(directory, "target/agent-runtime-prepare.lock");
  mkdirSync(lock);
  const abandoned = spawnSync(
    process.execPath,
    ["scripts/build-agent-runtime.mjs"],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.ifError(abandoned.error);
  assert.notEqual(abandoned.status, 0);
  assert.match(
    abandoned.stderr,
    /stop its Git\/Cargo processes before removing this lock/,
  );
  assert.ok(existsSync(marker));
  rmSync(lock, { recursive: true });
  const next = spawnSync(
    process.execPath,
    ["scripts/build-agent-runtime.mjs"],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(next.status, 0, next.stderr);
  const manifest = JSON.parse(
    readFileSync(
      path.join(directory, "src-tauri/resources/agent-runtime/manifest.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.goose.profile, "lean");
  assert.ok(
    !existsSync(marker),
    "the later preparation can repair its own checkout",
  );
});

test("interrupting preparation releases its lock", {
  skip: process.platform === "win32" && "POSIX process-group signal",
}, async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "buzz-agent-runtime-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  runtimeFixture(directory);
  // Its own process group, like a terminal's foreground job.
  const { child, socket, completed } = await heldPreparation(t, directory, {
    detached: true,
  });
  const lock = path.join(directory, "target/agent-runtime-prepare.lock");
  assert.ok(existsSync(lock));
  const compilerStopped = once(socket, "close");
  // Ctrl-C signals the whole foreground process group, compiler included.
  process.kill(-child.pid, "SIGINT");
  const [[code]] = await Promise.all([completed, compilerStopped]);
  assert.notEqual(code, 0);
  assert.ok(!existsSync(lock));
  const next = spawnSync(
    process.execPath,
    ["scripts/build-agent-runtime.mjs", "--dev"],
    { cwd: directory, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(next.status, 0, next.stderr);
});

test("runtime output ignores a user-level build target and survives an interrupted build", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "buzz-agent-runtime-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  runtimeFixture(directory);
  // Even a build.target equal to the host must not move the output.
  writeFileSync(path.join(directory, "config-build-target"), "fixture-target");
  writeFileSync(path.join(directory, "interrupt-build"), "");
  const run = () =>
    spawnSync(process.execPath, ["scripts/build-agent-runtime.mjs"], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
    });
  assert.notEqual(run().status, 0);
  rmSync(path.join(directory, "interrupt-build"));
  const retry = run();
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /Verified inputs staged/);
  assert.deepEqual(
    readFileSync(path.join(directory, "resumed.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    [false, true, true],
    "the retry reuses the interrupted build's target",
  );
});

test("worktrees of one clone reuse a verified runtime built from identical inputs", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "buzz-agent-runtime-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const common = path.join(directory, "common");
  const worktrees = ["one", "two"].map((name) => {
    const root = path.join(directory, name);
    runtimeFixture(root);
    writeFileSync(path.join(root, "git-common-dir"), common);
    return root;
  });
  const run = (root) => {
    const result = spawnSync(
      process.execPath,
      ["scripts/build-agent-runtime.mjs"],
      { cwd: root, encoding: "utf8", timeout: 10_000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const built = (root) => existsSync(path.join(root, "build-calls.jsonl"));
  const [one, two] = worktrees;
  const bundle = (root) => path.join(root, "src-tauri/resources/agent-runtime");
  assert.match(run(one), /Verified inputs staged/);
  assert.match(run(two), /Verified inputs restored/);
  assert.ok(!built(two), "a matching cached runtime must not invoke Cargo");
  assert.deepEqual(
    readFileSync(path.join(bundle(two), "manifest.json"), "utf8"),
    readFileSync(path.join(bundle(one), "manifest.json"), "utf8"),
  );
  // A corrupt cache entry is rebuilt, never copied into a worktree.
  const [entry] = readdirSync(path.join(common, "buzz-agent-runtime"));
  writeFileSync(path.join(common, "buzz-agent-runtime", entry, "buzz"), "bad");
  rmSync(bundle(two), { recursive: true });
  assert.match(run(two), /Verified inputs staged/);
  assert.ok(built(two));
  rmSync(bundle(one), { recursive: true });
  assert.match(run(one), /Verified inputs restored/, "repair republishes");
  // Different pinned inputs use a different entry.
  const specPath = path.join(one, "runtime/agent-runtime.json");
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  writeFileSync(
    specPath,
    JSON.stringify({ ...spec, revision: "0".repeat(40) }),
  );
  assert.match(run(one), /Verified inputs staged/);
  assert.equal(readdirSync(path.join(common, "buzz-agent-runtime")).length, 2);
  writeFileSync(
    specPath,
    JSON.stringify({
      ...spec,
      goose: { ...spec.goose, revision: "1".repeat(40) },
    }),
  );
  assert.match(run(one), /Verified inputs staged/);
  assert.equal(readdirSync(path.join(common, "buzz-agent-runtime")).length, 3);
  assert.match(run(one), /Agent runtime ready/);
});

test("a build that finishes after a concurrent publish keeps the published entry", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "buzz-agent-runtime-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const common = path.join(directory, "common");
  const [one, two] = ["one", "two"].map((name) => {
    const root = path.join(directory, name);
    runtimeFixture(root);
    writeFileSync(path.join(root, "git-common-dir"), common);
    return root;
  });
  // While two compiles, one builds and publishes the same key.
  writeFileSync(path.join(two, "during-build"), one);
  const result = spawnSync(
    process.execPath,
    ["scripts/build-agent-runtime.mjs"],
    {
      cwd: two,
      encoding: "utf8",
      timeout: 10_000,
      // Per-shell compiler overrides are scrubbed, so the fixture Cargo succeeds.
      env: {
        ...process.env,
        RUSTFLAGS: "-C target-cpu=native",
        RUSTC_WRAPPER: "sccache",
        CARGO_PROFILE_RELEASE_OPT_LEVEL: "0",
      },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const entries = path.join(common, "buzz-agent-runtime");
  assert.equal(readdirSync(entries).length, 1, "no leftover staging entries");
  const [entry] = readdirSync(entries);
  const tool = (dir) => readFileSync(path.join(dir, "buzz"), "utf8");
  assert.ok(
    tool(path.join(entries, entry)).endsWith(one),
    "first publish wins",
  );
  assert.ok(
    tool(path.join(two, "src-tauri/resources/agent-runtime")).endsWith(two),
  );
});

test("packaged desktop build prepares runtime before frontend compilation", () => {
  const config = JSON.parse(
    readFileSync(
      new URL("../../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    config.build.beforeBuildCommand,
    "node scripts/build-agent-runtime.mjs && pnpm build",
  );
});
