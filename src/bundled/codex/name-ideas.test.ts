import { expect, it, vi } from "vitest";
import type { Spawn } from "./rpc";
import { defaults } from "./config";
import { suggestNames } from "./name-ideas";

it("asks real Codex for bounded ephemeral names without tools or user/project configuration", async () => {
  const kill = vi.fn(async () => {});
  const spawn: Spawn = vi.fn(async (_id, options) => {
    options?.onStdout?.(
      `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '["Welcome", "Taken", "Quibble", "quibble", "Tumble"]' } })}\n`,
    );
    return {
      write: async () => {},
      end: async () => {},
      kill,
      exited: Promise.resolve(0),
    };
  });
  expect(
    await suggestNames(
      spawn,
      { ...defaults, model: "chosen", effort: "low" },
      ["Taken"],
      new AbortController().signal,
    ),
  ).toEqual(["Quibble", "Tumble"]);
  expect(spawn).toHaveBeenCalledWith(
    "codex",
    expect.objectContaining({
      args: expect.arrayContaining([
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "read-only",
        "shell_tool",
        "unified_exec",
        "hooks",
        "--model",
        "chosen",
      ]),
    }),
  );
  expect(kill).toHaveBeenCalled();
});

it("kills a held Codex request on cancellation and rejects malformed output", async () => {
  let exit!: (code: number) => void;
  const kill = vi.fn(async () => exit(1));
  const spawn: Spawn = vi.fn(async () => ({
    write: async () => {},
    end: async () => {},
    kill,
    exited: new Promise<number>((resolve) => {
      exit = resolve;
    }),
  }));
  const controller = new AbortController();
  const result = suggestNames(spawn, defaults, [], controller.signal).catch(
    (error) => error,
  );
  await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
  controller.abort();
  expect(await result).toMatchObject({ name: "AbortError" });
  expect(kill).toHaveBeenCalled();
  const malformed: Spawn = async (_id, options) => {
    options?.onStdout?.("not JSON\n");
    return {
      write: async () => {},
      end: async () => {},
      kill: async () => {},
      exited: Promise.resolve(0),
    };
  };
  await expect(
    suggestNames(malformed, defaults, [], new AbortController().signal),
  ).rejects.toThrow();
});
