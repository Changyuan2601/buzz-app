// @vitest-environment node
// The real pi.sh in a throwaway home, with a fake npm, starting a stand-in
// host on this Node.
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import script from "./pi.sh?raw";

const run = promisify(execFile);
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

/** What the stand-in host says of where it runs. */
const HOST =
  "console.log(JSON.stringify({ cwd: process.cwd(), data: process.argv[1], host: process.env.BUZZ_PI_HOST }))";
const PACKAGE = '{"name":"buzz-pi-host","private":true}';
const LOCK = '{"lockfileVersion":3}';

async function disk(npm = 'mkdir -p "$prefix/node_modules"') {
  const home = await mkdtemp(join(tmpdir(), "buzz-pi-"));
  homes.push(home);
  const bin = join(home, "bin");
  await mkdir(bin);
  await symlink(process.execPath, join(bin, "node"));
  // Notes each install, then does what the test says, in the folder it got.
  await writeFile(
    join(bin, "npm"),
    `#!/bin/sh\necho "$*" >>"${home}/npm.log"\nwhile [ "$1" != --prefix ]; do shift; done\nprefix=$2\n${npm}\n`,
  );
  await chmod(join(bin, "npm"), 0o755);
  const dir =
    process.platform === "darwin"
      ? join(home, "Library/Application Support/Buzz/pi")
      : join(home, ".local/share/buzz/pi");
  const step = async (
    env: Readonly<Record<string, string>> = {},
    lock = LOCK,
  ) =>
    (
      await run("bash", ["-c", script, "pi.sh", HOST, PACKAGE, lock], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: home,
          SHELL: "/bin/false",
          ...env,
        },
      })
    ).stdout.trim();
  return {
    home,
    bin,
    dir,
    step,
    installs: async () =>
      (await readFile(join(home, "npm.log"), "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean),
    folders: async () => (await readdir(join(dir, "deps"))).sort(),
  };
}

it("installs the locked packages once, and runs the host in them", async () => {
  const pi = await disk();
  const first = JSON.parse(await pi.step());
  const [folder, ...others] = await pi.folders();
  expect(others).toEqual([]);
  expect(first).toEqual({
    cwd: expect.stringMatching(new RegExp(`/deps/${folder}$`)),
    data: pi.dir,
    host: "1",
  });
  expect(await pi.installs()).toEqual([
    expect.stringMatching(/^ci --prefix .+ --ignore-scripts --omit=dev /),
  ]);
  // The next start uses them as they are.
  expect(JSON.parse(await pi.step())).toEqual(first);
  expect(await pi.installs()).toHaveLength(1);
  // Packages pinned otherwise go beside them.
  await pi.step({}, '{"lockfileVersion":3,"packages":{}}');
  expect(await pi.folders()).toHaveLength(2);
});

it("leaves nothing of an install that failed, and installs again next time", async () => {
  const failing = await disk('mkdir -p "$prefix/node_modules"; exit 1');
  await expect(failing.step()).rejects.toThrow();
  expect(await failing.folders()).toEqual([]);
  await writeFile(
    join(failing.bin, "npm"),
    `#!/bin/sh\necho "$*" >>"${failing.home}/npm.log"\n`,
  );
  await failing.step();
  expect(await failing.installs()).toHaveLength(2);
  expect(await failing.folders()).toHaveLength(1);
});

it("says Pi needs a newer Node when the one it finds is too old", async () => {
  const pi = await disk();
  await rm(join(pi.bin, "node"));
  await writeFile(join(pi.bin, "node"), "#!/bin/sh\nexit 1\n");
  await chmod(join(pi.bin, "node"), 0o755);
  const failed = await pi
    .step()
    .catch((error: { code: number; stderr: string }) => error);
  expect(failed).toMatchObject({
    code: 127,
    stderr: expect.stringContaining("Pi needs Node.js 22.19 or later."),
  });
});
