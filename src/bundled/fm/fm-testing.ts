// A fake community and `fm` for the runtime's tests; the live test brings
// the real `fm` to the same community.
import { vi } from "vitest";
import type { Delivery } from "../../features/agents/service";
import type { Host, HostProcessOptions } from "../../features/host/service";
import type { EventData, RelayEvent } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import { DEFAULT_CONFIG, FmRuntime } from "./runtime";

export const self = "c".repeat(64);
export const alice = "a".repeat(64);
export const bob = "b".repeat(64);
export const channel = "chan-1";
export const root = "1".repeat(64);
export const message = (
  id: string,
  content: string,
  extra: Partial<EventData> = {},
): RelayEvent =>
  ({
    id: id.repeat(64).slice(0, 64),
    pubkey: alice,
    kind: 9,
    created_at: 100 + Number(id),
    content,
    tags: [
      ["h", channel],
      ["p", self],
    ],
    sig: "",
    ...extra,
  }) as RelayEvent;
export const reply = (
  id: string,
  content: string,
  extra: Partial<EventData> = {},
) =>
  message(id, content, {
    tags: [
      ["h", channel],
      ["e", root, "", "root"],
      ["e", root, "", "reply"],
    ],
    ...extra,
  });

export type Answer = Readonly<{
  stdout?: string;
  stderr?: string;
  code?: number | null;
}>;
export type Run = {
  id: string;
  args: readonly string[];
  stdin: string;
  killed: boolean;
};

/** A runtime for Alice's agent `Orchard` in `channel`, with a fake `fm`
 * answering each run with the next of `answers`, or holding until killed,
 * unless `spawn` brings another. */
export function setup(
  options: Readonly<{
    answers?: (Answer | "hold")[];
    thread?: readonly EventData[];
    channelType?: string;
    spawn?: NonNullable<Host["spawn"]>;
  }> = {},
) {
  const answers = [...(options.answers ?? [{ stdout: "Four.\n" }])];
  const runs: Run[] = [];
  const spawn = vi.fn(async (id: string, opts: HostProcessOptions = {}) => {
    const run: Run = { id, args: opts.args ?? [], stdin: "", killed: false };
    runs.push(run);
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      exit = resolve;
    });
    return {
      write: async (data: string) => {
        run.stdin += data;
      },
      end: async (data = "") => {
        run.stdin += data;
        const answer =
          id === "available"
            ? { stdout: "System model available\n" }
            : answers.shift();
        if (!answer || answer === "hold") return;
        if (answer.stdout) opts.onStdout?.(answer.stdout);
        if (answer.stderr) opts.onStderr?.(answer.stderr);
        exit(answer.code === undefined ? 0 : answer.code);
      },
      kill: async () => {
        run.killed = true;
        exit(null);
      },
      exited,
    };
  });
  const host = {
    spawn: options.spawn ?? spawn,
    request: vi.fn(),
  } as unknown as Host;
  const read = vi.fn(
    async (_filters: readonly object[], _options?: object) =>
      options.thread ?? [],
  );
  const session = {
    read,
    channels: {
      list: () => ({
        status: "ready",
        channels: [
          {
            id: channel,
            name: "general",
            channelType: options.channelType ?? "stream",
            members: [],
          },
        ],
      }),
    },
    names: {
      resolve: (pubkey: string) =>
        pubkey === alice ? "Alice" : pubkey === bob ? "Bob" : undefined,
    },
    profiles: { ensure: vi.fn(async () => {}), snapshot: () => new Map() },
  };
  const relay = {
    snapshot: () => ({ status: "ready", session, viewer: alice }),
  } as unknown as RelayData;
  const runtime = new FmRuntime(host, () => relay);
  const published: { kind: number; content: string; tags: string[][] }[] = [];
  const agent = {
    pubkey: self,
    name: "Orchard",
    owner: alice,
    publish: vi.fn(async (template: (typeof published)[number]) => {
      published.push(template);
      return { ...message("9", template.content), ...template };
    }),
  };
  const deliver = (event: RelayEvent, extra: Partial<Delivery> = {}) =>
    runtime.run({
      trigger: { type: "mention", event },
      channelId: channel,
      agent,
      config: { ...DEFAULT_CONFIG, instructions: "Be brief." },
      signal: new AbortController().signal,
      workingUntil: () => undefined,
      ...extra,
    } as unknown as Delivery);
  return { runtime, runs, published, read, deliver, spawn };
}
