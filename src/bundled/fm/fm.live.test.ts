// The runtime on this Mac's real `fm`, started as the manifest declares it:
//
//   FM_LIVE=1 bin/pnpm exec vitest run src/bundled/fm/fm.live.test.ts
//
// It needs macOS 26 or later with Apple Intelligence on. Each run is also
// denied the network with `sandbox-exec`, so a passing test shows the agent
// answers with no internet connection.
import { spawn as start } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { Host, HostProcessOptions } from "../../features/host/service";
import { message, reply, root, self, setup } from "./fm-testing";
import manifest from "./manifest.json";

const OFFLINE = "(version 1)(allow default)(deny network*)";

/** Starts a declared process as the desktop host does, with no network. */
const spawn: NonNullable<Host["spawn"]> = async (
  id: string,
  { onStdout, onStderr, args = [] }: HostProcessOptions = {},
) => {
  const declared = manifest.host.processes.find((item) => item.id === id);
  if (!declared) throw new Error("Process is not declared");
  const child = start(
    "sandbox-exec",
    ["-p", OFFLINE, declared.program, ...declared.args, ...args],
    { stdio: "pipe" },
  );
  child.stdout.setEncoding("utf8").on("data", (data) => onStdout?.(data));
  child.stderr.setEncoding("utf8").on("data", (data) => onStderr?.(data));
  const exited = new Promise<number | null>((resolve) =>
    child.on("close", (code) => resolve(code)),
  );
  return {
    write: async (data: string) => void child.stdin.write(data),
    end: async (data = "") => void child.stdin.end(data),
    kill: async () => void child.kill(),
    exited,
  };
};

describe.skipIf(!process.env.FM_LIVE)("fm agents on Apple's model", () => {
  it("reports the model available", async () => {
    const { runtime } = setup({ spawn });
    await expect(runtime.available()).resolves.toMatchObject({ ready: true });
  });

  it("answers a follow-up in a thread from what was said before", async () => {
    const thread = [
      message("1", "@Orchard what is the capital of France?", { id: root }),
      reply("2", "The capital of France is Paris.", { pubkey: self }),
    ];
    const { published, deliver } = setup({ spawn, thread });
    await deliver(reply("3", "@Orchard and of Spain?"));
    expect(published).toHaveLength(1);
    expect(published[0]?.content).toMatch(/Madrid/);
    expect(published[0]?.tags).toContainEqual(["e", root, "", "reply"]);
  }, 60_000);

  it("answers a message too dense for the model's context from its start", async () => {
    const dense = Array.from({ length: 2_000 }, (_, at) =>
      ((at * 2654435761) >>> 0).toString(16),
    ).join(" ");
    const { published, deliver } = setup({ spawn });
    await deliver(message("2", `@Orchard how long is this? ${dense}`));
    expect(published).toHaveLength(1);
    expect(published[0]?.content).not.toMatch(/couldn't finish/);
  }, 120_000);
});
