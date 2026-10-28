import { spawnSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { stageBerdCallPlugin } from "./stage-berd-call-plugin.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const roots = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "Buzz Preview.app "));
  roots.push(root);
  await cp(join(repository, "runtime"), join(root, "runtime"), {
    recursive: true,
  });
  return {
    root,
    target: "aarch64-apple-darwin",
    launcher: join(root, "src-tauri/resources/bin/berd-call-start"),
  };
}

it("stages the verified launcher and runs only the adjacent CLI in a spaced path", async () => {
  const test = await fixture();
  expect(await stageBerdCallPlugin(test)).toMatchObject({ supported: true });
  expect((await stat(test.launcher)).mode & 0o777).toBe(0o755);
  const bin = join(test.root, "src-tauri/resources/bin");
  await writeFile(
    join(bin, "berd-call"),
    '#!/bin/sh\nprintf "%s\\n" "$BERD_CALL_SETTINGS_FILE" "$@"\n',
    { mode: 0o755 },
  );
  const decoy = join(test.root, "decoy");
  await mkdir(decoy);
  await writeFile(join(decoy, "berd-call"), "#!/bin/sh\nexit 99\n", {
    mode: 0o755,
  });
  const result = spawnSync(test.launcher, ["", "--port", "9999"], {
    env: {
      ...process.env,
      PATH: `${decoy}:/usr/bin:/bin`,
      XDG_CONFIG_HOME: test.root,
      XDG_DATA_HOME: test.root,
    },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim().split("\n")).toEqual([
    join(test.root, "berd-call/buzz.json"),
    "start",
    "--stream",
    "--port",
    "9999",
  ]);
});

it.each(["plugin/plugin.js", "plugin/manifest.json", "bin/berd-call-start"])(
  "rejects modified %s before replacing the launcher",
  async (file) => {
    const test = await fixture();
    await stageBerdCallPlugin(test);
    const previous = await readFile(test.launcher);
    await writeFile(
      join(test.root, "runtime/berd-call-plugin", file),
      "modified",
    );
    await expect(stageBerdCallPlugin(test)).rejects.toThrow(
      "checksum mismatch",
    );
    expect(await readFile(test.launcher)).toEqual(previous);
  },
);

it("requires an immutable source revision", async () => {
  const test = await fixture();
  const path = join(test.root, "runtime/berd-call-plugin.json");
  const pin = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...pin, revision: "main" }));
  await expect(stageBerdCallPlugin(test)).rejects.toThrow(
    "exact source commit",
  );
});

it("removes a stale launcher on an unsupported target", async () => {
  const test = await fixture();
  await stageBerdCallPlugin(test);
  expect(
    await stageBerdCallPlugin({ ...test, target: "x86_64-unknown-linux-gnu" }),
  ).toEqual({ supported: false });
  await expect(stat(test.launcher)).rejects.toMatchObject({ code: "ENOENT" });
});

it("pins a self-contained author module and bundled process manifest", async () => {
  const module = await import("../runtime/berd-call-plugin/plugin/plugin.js");
  expect(typeof module.apply).toBe("function");
  const manifest = JSON.parse(
    await readFile(
      join(repository, "runtime/berd-call-plugin/plugin/manifest.json"),
      "utf8",
    ),
  );
  expect(manifest.id).toBe("berd-call");
  expect(manifest.host.processes.some((p) => p.id === "update")).toBe(false);
  expect(
    manifest.host.processes
      .filter((p) => p.program.startsWith("berd-call"))
      .every((p) => p.bundled),
  ).toBe(true);
});
