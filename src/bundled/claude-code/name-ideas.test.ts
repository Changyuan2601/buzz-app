import { expect, it, vi } from "vitest";
import { fakeSpawn, flush } from "./claude-testing";
import { DEFAULT_CONFIG } from "./runtime";
import { suggestNames } from "./name-ideas";

it("gets private name ideas in tools-free safe mode, filters repeats and stops the unsaved process", async () => {
  const f = fakeSpawn();
  const spawn: typeof f.spawn = async (id, options) => {
    const child = await f.spawn(id, options);
    const original = child.write;
    return {
      ...child,
      write: async (data) => {
        const message = JSON.parse(data);
        if (message.type !== "user") return original(data);
        f.processes[0]?.emit({
          type: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: '["Fizz", "Juniper", "Quibble", "quibble", "Tumble", "bad\\nname"]',
              },
            ],
          },
        });
        f.processes[0]?.emit({ type: "result", subtype: "success" });
      },
    };
  };
  await expect(
    suggestNames(
      spawn,
      DEFAULT_CONFIG,
      ["Juniper"],
      new AbortController().signal,
    ),
  ).resolves.toEqual(["Quibble", "Tumble"]);
  const process = f.processes[0];
  expect(process?.options.args).toEqual(
    expect.arrayContaining([
      "--safe-mode",
      "--tools",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
    ]),
  );
  expect(process?.options.args).not.toContain("--permission-mode");
  expect(process?.options.args).not.toContain("--mcp-config");
  expect(process?.killed).toBe(true);
});

it("rejects malformed provider output without falling back to invented names", async () => {
  const f = fakeSpawn();
  await expect(
    suggestNames(f.spawn, DEFAULT_CONFIG, [], new AbortController().signal),
  ).rejects.toThrow();
  expect(f.processes[0]?.killed).toBe(true);
});

it("cancels a held suggestion request and never returns a late name", async () => {
  const f = fakeSpawn();
  const spawn: typeof f.spawn = async (id, options) => {
    const child = await f.spawn(id, options);
    if (f.processes[0]) f.processes[0].hold = true;
    return child;
  };
  const controller = new AbortController();
  const result = suggestNames(
    spawn,
    DEFAULT_CONFIG,
    [],
    controller.signal,
  ).catch((error) => error);
  await vi.waitFor(() => expect(f.processes[0]?.prompts).toHaveLength(1));
  controller.abort();
  expect(await result).toMatchObject({ name: "AbortError" });
  await flush();
  expect(f.processes[0]?.killed).toBe(true);
});
