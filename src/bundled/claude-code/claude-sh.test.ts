// The real claude.sh switching releases in a throwaway home, as Buzz builds
// sharing one folder do.
import { execFile, spawn } from "node:child_process";
import { watch } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import script from "./claude.sh?raw";

const run = promisify(execFile);
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

/** Buzz's claude-code folder in a new home, holding fake `releases` with `current`. */
async function disk(releases: readonly string[], current?: string) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "buzz-claude-")));
  homes.push(home);
  const dir =
    process.platform === "darwin"
      ? join(home, "Library/Application Support/Buzz/claude-code")
      : join(home, ".local/share/buzz/claude-code");
  for (const version of releases) {
    const binary = join(dir, version, "claude");
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, `#!/bin/sh\necho "${version}"\n`);
    await chmod(binary, 0o755);
  }
  if (current) await writeFile(join(dir, "current"), current);
  const step = (...args: string[]) =>
    run("bash", ["-c", script, "claude.sh", ...args], {
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

it("keeps Buzz sessions private while sharing settings and leaving terminal storage alone", async () => {
  const f = await disk(["0.1.0"], "0.1.0");
  const shared = join(f.home, ".claude");
  await mkdir(shared);
  await writeFile(join(shared, "settings.json"), '{"model":"opus"}');
  const binary = join(f.dir, "0.1.0/claude");
  await writeFile(
    binary,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    '#!/bin/sh\nroot="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"\nmkdir -p "$root/projects/work"\necho "$1" > "$root/projects/work/$1.jsonl"\n',
  );
  await Promise.all(
    Array.from({ length: 6 }, (_, i) => f.step("run", `buzz-${i}`)),
  );
  const own = join(f.dir, "../claude-home");
  expect(await readdir(join(shared, "projects")).catch(() => [])).toEqual([]);
  expect(await readFile(join(own, "projects/work/buzz-0.jsonl"), "utf8")).toBe(
    "buzz-0\n",
  );
  expect(await readlink(join(own, "settings.json"))).toBe(
    join(shared, "settings.json"),
  );
  await run(binary, ["terminal"], {
    env: { PATH: process.env.PATH, HOME: f.home },
  });
  expect(
    await readFile(join(shared, "projects/work/terminal.jsonl"), "utf8"),
  ).toBe("terminal\n");
  expect(await readdir(join(own, "projects/work"))).not.toContain(
    "terminal.jsonl",
  );
});

it("adopts only a resumed session, never overwriting Buzz's continued copy or the original", async () => {
  const f = await disk(["0.1.0"], "0.1.0");
  const project = join(f.home, ".claude/projects/work");
  await mkdir(join(project, "saved/subagents"), { recursive: true });
  await writeFile(join(project, "saved.jsonl"), '{"message":"original"}');
  await writeFile(join(project, "other.jsonl"), "unrelated\n");
  await writeFile(join(project, "saved/subagents/child.jsonl"), "child\n");
  await f.step("run", "--resume", "saved");
  const copy = join(f.dir, "../claude-home/projects/work/saved.jsonl");
  expect(await readFile(copy, "utf8")).toBe('{"message":"original"}\n');
  expect(
    await readFile(
      join(f.dir, "../claude-home/projects/work/saved/subagents/child.jsonl"),
      "utf8",
    ),
  ).toBe("child\n");
  await writeFile(copy, "continued\n");
  await f.step("run", "--resume", "saved");
  expect(await readFile(copy, "utf8")).toBe("continued\n");
  expect(await readFile(join(project, "saved.jsonl"), "utf8")).toBe(
    '{"message":"original"}',
  );
  expect(
    await readdir(join(f.dir, "../claude-home/projects/work")),
  ).not.toContain("other.jsonl");
  await expect(f.step("run", "--resume", "../saved")).rejects.toThrow();
});

it("refuses to replace a user's file in Buzz's Claude configuration", async () => {
  const f = await disk(["0.1.0"], "0.1.0");
  const own = join(f.dir, "../claude-home");
  await mkdir(own, { recursive: true });
  await writeFile(join(own, "settings.json"), "keep me");
  await expect(f.step("run")).rejects.toThrow();
  expect(await readFile(join(own, "settings.json"), "utf8")).toBe("keep me");
});

// Builds that fetched 0.2.0 and 0.3.0 switch in either order, or at once;
// none prunes what another made current.
it("keeps the newer release when it switches first", async () => {
  const first = await disk(["0.1.0", "0.2.0", "0.3.0"], "0.1.0");
  await first.step("use", "0.2.0");
  await first.step("use", "0.3.0");
  expect(await first.selected()).toBe("0.3.0");
});

it("keeps the newer release when an older one switches after it", async () => {
  const second = await disk(["0.1.0", "0.2.0", "0.3.0"], "0.1.0");
  await second.step("use", "0.3.0");
  await expect(second.step("use", "0.2.0")).rejects.toThrow();
  expect(await second.selected()).toBe("0.3.0");
});

it("keeps the release in use when builds switch at once", async () => {
  const both = await disk(["0.1.0", "0.2.0", "0.3.0"], "0.1.0");
  await Promise.allSettled([
    both.step("use", "0.2.0"),
    both.step("use", "0.3.0"),
  ]);
  const current = await readFile(join(both.dir, "current"), "utf8");
  expect(await both.selected()).toBe(current);
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
  expect(await selected()).toBe("0.1.0");
  holder.kill("SIGKILL");
  await switching;
  expect(await selected()).toBe("0.2.0");
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
  expect(await selected()).toBe("0.2.0");
});

it("starts the release in use when switches prune the one it read", async () => {
  const { home, step, folders } = await disk(
    ["0.1.0", "0.2.0", "0.3.0"],
    "0.1.0",
  );
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
    ["-c", script, "claude.sh", "run", "--version"],
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
    expect((await launching).stdout.trim()).toBe("0.3.0");
  } finally {
    watcher.close();
    await writeFile(join(bin, "go"), "");
    await launching.catch(() => {});
  }
});
