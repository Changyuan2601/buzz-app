import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import type { Spawn } from "./goose";
import { withHome } from "./storage";

const run = promisify(execFile);
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

async function fixture() {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "buzz-goose-storage-")),
  );
  homes.push(home);
  const shared = join(home, "custom-goose");
  await mkdir(join(shared, "config"), { recursive: true });
  await writeFile(
    join(shared, "config/config.yaml"),
    "GOOSE_PROVIDER: anthropic\n",
  );
  const spawn: Spawn = async (id, options) => {
    if (id === "storage") {
      try {
        const { stdout } = await run("bash", ["-c", ...(options?.args ?? [])], {
          env: { PATH: process.env.PATH, HOME: home, GOOSE_PATH_ROOT: shared },
        });
        options?.onStdout?.(stdout);
      } catch (error) {
        options?.onStderr?.((error as { stderr: string }).stderr);
        return {
          write: async () => {},
          end: async () => {},
          kill: async () => {},
          exited: Promise.resolve(1),
        };
      }
    } else if (id === "goose") {
      const root = options?.env?.GOOSE_PATH_ROOT || shared;
      // Simulate an executable's write at the documented Goose data boundary.
      await mkdir(join(root, "data/sessions"), { recursive: true });
      await writeFile(join(root, "data/sessions/turn"), "saved");
    }
    return {
      write: async () => {},
      end: async () => {},
      kill: async () => {},
      exited: Promise.resolve(0),
    };
  };
  const own =
    process.platform === "darwin"
      ? join(home, "Library/Application Support/Buzz/goose-home")
      : join(home, ".local/share/buzz/goose-home");
  return { home, shared, own, spawn };
}

it("isolates Buzz writes across concurrent starts and shares the existing provider configuration", async () => {
  const f = await fixture();
  const start = withHome(f.spawn);
  await Promise.all(Array.from({ length: 6 }, () => start("goose")));
  expect(await readFile(join(f.own, "data/sessions/turn"), "utf8")).toBe(
    "saved",
  );
  expect(
    await readFile(join(f.shared, "data/sessions/turn"), "utf8").catch(
      () => undefined,
    ),
  ).toBeUndefined();
  expect(await readlink(join(f.own, "config"))).toBe(join(f.shared, "config"));
  expect(await readFile(join(f.own, "config/config.yaml"), "utf8")).toContain(
    "anthropic",
  );
  await f.spawn("goose");
  expect(await readFile(join(f.shared, "data/sessions/turn"), "utf8")).toBe(
    "saved",
  );
});

it("stops on a conflicting Buzz config directory without replacing it", async () => {
  const f = await fixture();
  await mkdir(join(f.own, "config"), { recursive: true });
  await writeFile(join(f.own, "config/keep"), "untouched");
  await expect(withHome(f.spawn)("goose")).rejects.toThrow("conflicts");
  expect(await readFile(join(f.own, "config/keep"), "utf8")).toBe("untouched");
});
