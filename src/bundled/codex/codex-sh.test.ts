// The real codex.sh switching releases in a throwaway home, as Buzz builds
// sharing one folder do.
import { execFile, spawn } from "node:child_process";
import { watch } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import script from "./codex.sh?raw";

const run = promisify(execFile);
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

/** Buzz's codex folder in a new home, holding fake `releases` with `current`. */
async function disk(releases: readonly string[], current?: string) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "buzz-codex-")));
  homes.push(home);
  const dir =
    process.platform === "darwin"
      ? join(home, "Library/Application Support/Buzz/codex")
      : join(home, ".local/share/buzz/codex");
  for (const version of releases) {
    const binary = join(dir, version, "bin/codex");
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, `#!/bin/sh\necho "codex-cli ${version}"\n`);
    await chmod(binary, 0o755);
  }
  if (current) await writeFile(join(dir, "current"), current);
  const step = (...args: string[]) =>
    run("bash", ["-c", script, "codex.sh", ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: home },
    });
  return {
    home,
    dir,
    step,
    /** Leaves no doubt the release `current` names still runs. */
    selected: async () => (await step("run", "--version")).stdout.trim(),
    folders: async () =>
      (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(),
  };
}

// Builds that fetched 0.2.0 and 0.3.0 switch in either order, or at once;
// none prunes what another made current.
it("keeps the newer release when it switches first", async () => {
  const first = await disk(["0.1.0", "0.2.0", "0.3.0"], "0.1.0");
  await first.step("use", "0.2.0");
  await first.step("use", "0.3.0");
  expect(await first.selected()).toBe("codex-cli 0.3.0");
});

it("keeps the newer release when an older one switches after it", async () => {
  const second = await disk(["0.1.0", "0.2.0", "0.3.0"], "0.1.0");
  await second.step("use", "0.3.0");
  await expect(second.step("use", "0.2.0")).rejects.toThrow();
  expect(await second.selected()).toBe("codex-cli 0.3.0");
});

it("keeps the release in use when builds switch at once", async () => {
  const both = await disk(["0.1.0", "0.2.0", "0.3.0"], "0.1.0");
  await Promise.allSettled([
    both.step("use", "0.2.0"),
    both.step("use", "0.3.0"),
  ]);
  const current = await readFile(join(both.dir, "current"), "utf8");
  expect(await both.selected()).toBe(`codex-cli ${current}`);
});

it("prunes older releases but keeps a newer one another build may be testing", async () => {
  const { step, folders } = await disk(
    ["0.1.0", "0.2.0", "0.3.0", "0.10.0"],
    "0.2.0",
  );
  await step("use", "0.3.0");
  expect(await folders()).toEqual(["0.10.0", "0.2.0", "0.3.0"]);
});

/** Holds the switch lock, as a build that is switching does, until killed. */
async function hold(dir: string) {
  const holder = spawn("perl", [
    "-MFcntl=:flock",
    "-e",
    'open(my $l, ">>", $ARGV[0]) or die; flock($l, LOCK_EX) or die; $| = 1; print "held\\n"; sleep 60',
    join(dir, ".lock"),
  ]);
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  return holder;
}
/** Resolves once the switch with process `pid` is waiting for the lock. */
const waiting = (pid: number | undefined) =>
  expect
    .poll(() =>
      run("pgrep", ["-P", String(pid), "-x", "flock|perl"]).then(
        () => true,
        () => false,
      ),
    )
    .toBe(true);

it("waits for a switch in progress, and goes on once its holder is killed", async () => {
  const { dir, step, selected } = await disk(["0.1.0", "0.2.0"], "0.1.0");
  const holder = await hold(dir);
  const switching = step("use", "0.2.0");
  await waiting(switching.child.pid);
  expect(await selected()).toBe("codex-cli 0.1.0");
  holder.kill("SIGKILL");
  await switching;
  expect(await selected()).toBe("codex-cli 0.2.0");
});

it("leaves the release in use when its switch's release is pruned while it waits", async () => {
  const { dir, step, selected } = await disk(["0.1.0", "0.2.0"], "0.2.0");
  const holder = await hold(dir);
  const switching = step("use", "0.1.0");
  await waiting(switching.child.pid);
  // The holder's own prune removes the older release this switch named.
  await rm(join(dir, "0.1.0"), { recursive: true });
  holder.kill("SIGKILL");
  await expect(switching).rejects.toThrow("0.1.0 is no longer downloaded");
  expect(await selected()).toBe("codex-cli 0.2.0");
});

it("starts the release in use when switches prune the one it read", async () => {
  const { home, step, folders } = await disk(
    ["0.1.0", "0.2.0", "0.3.0"],
    "0.1.0",
  );
  // Complete home setup before observing the release-read boundary.
  await step("run", "--version");
  // A `cat` that stops after its first read, of `current`, until `go`.
  const bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "cat"),
    `#!/bin/sh\n/bin/cat "$@"\n[ -e "${bin}/read" ] && exit\n: >"${bin}/read"\nuntil [ -e "${bin}/go" ]; do sleep 0.05; done\n`,
  );
  await chmod(join(bin, "cat"), 0o755);
  let observed!: () => void;
  let failed!: (error: Error) => void;
  const read = new Promise<void>((resolve, reject) => {
    observed = resolve;
    failed = reject;
  });
  const watcher = watch(bin, (_event, name) => {
    if (name === "read") observed();
  });
  watcher.once("error", failed);
  const launching = run(
    "bash",
    ["-c", script, "codex.sh", "run", "--version"],
    {
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home },
    },
  );
  try {
    // Observe the actual read event; process startup is not the behavior under test.
    await Promise.race([
      read,
      launching.then(() => {
        throw new Error("Launcher exited before reading current");
      }),
    ]);
    // Two builds switch past the release the launcher read, pruning it.
    await step("use", "0.2.0");
    await step("use", "0.3.0");
    expect(await folders()).not.toContain("0.1.0");
    await writeFile(join(bin, "go"), "");
    expect((await launching).stdout.trim()).toBe("codex-cli 0.3.0");
  } finally {
    watcher.close();
    await writeFile(join(bin, "go"), "");
    await launching.catch(() => {});
  }
});

// Buzz's own Codex home keeps its conversations out of the user's Codex
// history, linking in only the settings, sign-in and instructions.
const shared = ["config.toml", "auth.json", "AGENTS.md", "rules", "skills"];

/** A release that prints the home and arguments it ran with. */
async function echoing() {
  const f = await disk(["0.1.0", "0.2.0"], "0.1.0");
  await writeFile(
    join(f.dir, "0.1.0/bin/codex"),
    '#!/bin/sh\nprintf "%s\\n" "$CODEX_HOME" "$@"\n',
  );
  return { ...f, own: `${f.dir}-home`, codex: join(f.home, ".codex") };
}

it("runs Codex in Buzz's own home, linked to the shared settings and sign-in", async () => {
  const f = await echoing();
  const { stdout } = await f.step("run", "app-server");
  expect(stdout.trim().split("\n")).toEqual([
    f.own,
    "-c",
    `sqlite_home=${f.own}`,
    "app-server",
  ]);
  for (const name of shared)
    expect(await readlink(join(f.own, name))).toBe(join(f.codex, name));
  // A sign-in refresh writes through the link, to the shared file.
  await writeFile(join(f.own, "auth.json"), "refreshed");
  expect(await readFile(join(f.codex, "auth.json"), "utf8")).toBe("refreshed");
  await f.step("run", "app-server");
});

it("sets up Buzz's home once when runs start at once", async () => {
  const f = await echoing();
  // A link made meanwhile to a folder must not lead a run to link inside it.
  await mkdir(join(f.codex, "skills"), { recursive: true });
  await mkdir(join(f.codex, "rules"));
  for (let round = 0; round < 3; round++) {
    await rm(f.own, { recursive: true, force: true });
    await Promise.all(Array.from({ length: 6 }, () => f.step("run")));
    for (const name of shared)
      expect(await readlink(join(f.own, name))).toBe(join(f.codex, name));
    expect(await readdir(join(f.codex, "skills"))).toEqual([]);
    expect(await readdir(join(f.codex, "rules"))).toEqual([]);
  }
}, 20_000);

it("makes the shared skills and rules folders a fresh home lacks", async () => {
  const f = await echoing();
  await f.step("run");
  // Codex fails to set up its skills through a link to nothing.
  for (const name of ["skills", "rules"])
    expect((await stat(join(f.own, name))).isDirectory()).toBe(true);
});

it("still runs Codex when the shared skills or rules can't be folders", async () => {
  const f = await echoing();
  await mkdir(f.codex, { recursive: true });
  await writeFile(join(f.codex, "skills"), "");
  await symlink(join(f.home, "gone"), join(f.codex, "rules"));
  const { stdout } = await f.step("run", "--version");
  expect(stdout.trim().split("\n").at(-1)).toBe("--version");
});

it("stops rather than replace a file in the way of a link", async () => {
  const f = await echoing();
  await mkdir(f.own, { recursive: true });
  await writeFile(join(f.own, "config.toml"), "keep me");
  await expect(f.step("run")).rejects.toMatchObject({
    stderr: expect.stringContaining("setup conflicts"),
  });
  expect(await readFile(join(f.own, "config.toml"), "utf8")).toBe("keep me");
});

it("keeps Buzz's conversations when switching releases", async () => {
  const f = await echoing();
  await f.step("run");
  await mkdir(join(f.own, "sessions"));
  await writeFile(join(f.own, "sessions/rollout.jsonl"), "history");
  await f.step("use", "0.2.0");
  expect(await readFile(join(f.own, "sessions/rollout.jsonl"), "utf8")).toBe(
    "history",
  );
  expect(await readlink(join(f.own, "skills"))).toBe(join(f.codex, "skills"));
});

it("copies a saved thread from the user's home once, never over Buzz's copy", async () => {
  const { home, dir, step } = await disk([]);
  const day = "sessions/2026/10/14";
  const name = "rollout-2026-10-14T14-32-19-thread-1.jsonl";
  await mkdir(join(home, ".codex", day), { recursive: true });
  // The Codex app is mid-write: the last line has no end yet.
  await writeFile(join(home, ".codex", day, name), '{"a":1}\n{"b"');
  await step("adopt", "thread-1");
  const copy = join(`${dir}-home`, day, name);
  expect(await readFile(copy, "utf8")).toBe('{"a":1}\n{"b"\n');
  await writeFile(copy, "continued in Buzz\n");
  await step("adopt", "thread-1");
  expect(await readFile(copy, "utf8")).toBe("continued in Buzz\n");
  // Nothing to copy is not an error.
  await step("adopt", "thread-2");
  await expect(step("adopt", "../thread-1")).rejects.toThrow("Invalid thread");
  expect(await readdir(join(`${dir}-home`, day))).toEqual([name]);
});
