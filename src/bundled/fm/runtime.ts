// Turns Agents mentions into answers from Apple's on-device Foundation Model.
// Each turn reads the conversation from the community, asks `fm respond` on
// this computer with a compact prompt, and posts its answer as the agent.
// Nothing is kept between turns: the conversation is the memory, so a restart
// loses nothing. The model never leaves the computer, so it answers offline.
import {
  fromOwner,
  type AgentHandle,
  type Delivery,
} from "../../features/agents/service";
import { soloChat } from "../../features/agents/solo-chat";
import type { Host } from "../../features/host/service";
import type { EventData } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import { threadReference } from "../../features/relay/thread-reference";
import {
  errorLine,
  instructions,
  type Line,
  overflowed,
  prompt,
  SHORT_LATEST_CHARS,
} from "./prompt";

export type Config = Readonly<{ instructions: string }>;
export const DEFAULT_CONFIG: Config = Object.freeze({ instructions: "" });
export const config = (value: unknown): Config => ({
  ...DEFAULT_CONFIG,
  ...(value && typeof value === "object" ? (value as Partial<Config>) : {}),
});

const CHAT = [9, 40002];
/** Messages a DM or Solo chat turn reads back. */
const RECENT_LIMIT = 30;
const READ_TIMEOUT_MS = 4_000;
const NAMES_TIMEOUT_MS = 2_000;
/** A turn's deadline: `fm` answers in seconds, but a first load of the model
 * can be slow. */
export const TURN_MINUTES = 3;

/** What one `fm respond` run gave: its answer or its error. */
type Generated = Readonly<{ text: string }> | Readonly<{ error: string }>;

export class FmRuntime {
  constructor(
    private readonly host: Host,
    /** The owner's connection to each agent's own community. */
    private readonly relay: (pubkey: string) => RelayData | undefined,
  ) {}

  /** Whether the model can answer on this computer, in `fm`'s own words. */
  async available(): Promise<Readonly<{ ready: boolean; detail: string }>> {
    if (!this.host.spawn)
      return { ready: false, detail: "Only the desktop app runs fm." };
    const output: string[] = [];
    try {
      const process = await this.host.spawn("available", {
        onStdout: (data) => output.push(data),
        onStderr: (data) => output.push(data),
      });
      await process.end().catch(() => undefined);
      const code = await process.exited;
      const detail = output.join("").trim();
      return {
        ready: code === 0 && /^System model available$/m.test(detail),
        detail: detail || `fm exited with ${code}`,
      };
    } catch {
      return {
        ready: false,
        detail:
          "This computer has no fm command. It comes with macOS 26 or later on Macs with Apple Intelligence.",
      };
    }
  }

  async run({
    trigger,
    agent,
    config: raw,
    channelId,
    signal,
    ignored,
    acknowledged,
    interruptible,
  }: Delivery) {
    // Without Buzz tools there is nothing a watch, timer or plugin wake could
    // be answered with: only mentions run.
    if (trigger.type !== "mention") return ignored?.();
    const { event } = trigger;
    const snapshot = this.relay(agent.pubkey)?.snapshot();
    const session = snapshot?.status === "ready" ? snapshot.session : undefined;
    if (
      !(await fromOwner(event, agent.owner, {
        agent: agent.pubkey,
        authority: session?.workflowAuthority,
        profiles: session?.profiles,
      }))
    )
      return ignored?.();
    signal.throwIfAborted();
    const channel =
      channelId ?? event.tags.find((tag) => tag[0] === "h")?.[1] ?? undefined;
    if (!channel) return;
    const topLevel = await soloChat(
      () => this.relay(agent.pubkey),
      agent.owner,
      channel,
      signal,
    );
    let process: { kill(): Promise<void> } | undefined;
    let stopped = false;
    let ownerStopped = false;
    const stop = async () => {
      stopped = true;
      await process?.kill();
    };
    signal.addEventListener("abort", () => void stop(), { once: true });
    interruptible?.(() => {
      ownerStopped = true;
      return stop();
    });
    // The owner's Stop, or the agent going away, posts nothing; running past
    // the deadline says so, so nobody waits on it.
    const ended = () =>
      !ownerStopped &&
      (signal.reason as { name?: unknown } | undefined)?.name === "TimeoutError"
        ? this.report(
            agent,
            channel,
            event,
            `fm took longer than ${TURN_MINUTES} minutes.`,
            topLevel,
          )
        : undefined;
    try {
      const turn = await this.conversation(agent, event, channel, topLevel);
      signal.throwIfAborted();
      acknowledged?.();
      const system = instructions({
        name: agent.name,
        owner: turn.name(agent.owner) ?? "your owner",
        instructions: config(raw).instructions,
      });
      // A conversation too long for the model is answered on the latest
      // message alone, and then on the start of that message.
      const attempts = [
        prompt({
          place: turn.place,
          earlier: turn.earlier,
          latest: turn.latest,
        }),
        prompt({ place: turn.place, earlier: [], latest: turn.latest }),
        prompt({
          place: turn.place,
          earlier: [],
          latest: turn.latest,
          latestChars: SHORT_LATEST_CHARS,
        }),
      ].filter((text, at, all) => text !== all[at - 1]);
      let answer: Generated | undefined;
      for (const text of attempts) {
        answer = await this.generate(system, text, (started) => {
          process = started;
          if (stopped) void started.kill();
        });
        if (stopped || !("error" in answer) || !overflowed(answer.error)) break;
      }
      if (stopped) return await ended();
      if (!answer) return;
      if ("error" in answer)
        return await this.report(agent, channel, event, answer.error, topLevel);
      await (answer.text
        ? this.post(agent, channel, event, answer.text, topLevel)
        : this.report(agent, channel, event, "fm gave no answer.", topLevel));
    } catch (error) {
      if (signal.aborted) return await ended();
      await this.report(
        agent,
        channel,
        event,
        error instanceof Error ? error.message : String(error),
        topLevel,
      );
    }
  }

  /** Runs `fm respond` once, `text` on its stdin. */
  private async generate(
    system: string,
    text: string,
    started: (process: { kill(): Promise<void> }) => void,
  ): Promise<Generated> {
    if (!this.host.spawn)
      throw new Error("Foundation Model agents run only in the desktop app");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const process = await this.host.spawn("respond", {
      args: [`--instructions=${system}`],
      onStdout: (data) => stdout.push(data),
      onStderr: (data) => stderr.push(data),
    });
    started(process);
    // It may exit before reading everything, such as on a bad argument.
    await process.end(text).catch(() => undefined);
    const code = await process.exited;
    const output = stdout.join("").trim();
    if (code !== 0)
      return { error: errorLine(stderr.join("") || output, code) };
    return { text: output };
  }

  /** The conversation the mention is in, as the model is shown it. */
  private async conversation(
    agent: AgentHandle,
    event: EventData,
    channelId: string,
    topLevel: boolean,
  ) {
    const snapshot = this.relay(agent.pubkey)?.snapshot();
    const session = snapshot?.status === "ready" ? snapshot.session : undefined;
    const summary =
      session?.channels.list().channels.find((item) => item.id === channelId) ??
      session?.channels.get?.(channelId);
    const dm = summary?.channelType === "dm";
    const thread = threadReference(event);
    let earlier: readonly EventData[] = [];
    // A thread is read whole; a DM or Solo chat is one conversation, read
    // back as far as the prompt can carry. A mention starting a thread has
    // nothing before it.
    if (session && (topLevel || dm || thread))
      try {
        const events = await session.read(
          thread && !topLevel
            ? [
                { ids: [thread.rootId], limit: 1 },
                {
                  kinds: CHAT,
                  "#h": [channelId],
                  "#e": [thread.rootId],
                  limit: 200,
                },
              ]
            : [{ kinds: CHAT, "#h": [channelId], limit: RECENT_LIMIT + 1 }],
          { signal: AbortSignal.timeout(READ_TIMEOUT_MS) },
        );
        earlier = events
          .filter(
            (item) =>
              CHAT.includes(item.kind) &&
              item.id !== event.id &&
              item.created_at <= event.created_at,
          )
          .sort((a, b) => a.created_at - b.created_at);
      } catch (error) {
        console.warn("fm could not read the conversation", error);
      }
    const pubkeys = [
      ...new Set([
        agent.owner,
        event.pubkey,
        ...earlier.map((item) => item.pubkey),
      ]),
    ];
    if (session)
      await Promise.race([
        session.profiles.ensure(pubkeys, "foreground").catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, NAMES_TIMEOUT_MS)),
      ]);
    const members = summary?.members ?? [];
    const name = (pubkey: string) =>
      session?.names.resolve(pubkey, undefined, members) ??
      session?.profiles.snapshot().get(pubkey)?.name ??
      undefined;
    const author = (pubkey: string) =>
      pubkey === agent.pubkey
        ? `You (${agent.name})`
        : (name(pubkey) ?? pubkey.slice(0, 8));
    const line = (item: EventData): Line => ({
      author: author(item.pubkey),
      text: item.content,
    });
    return {
      place: topLevel
        ? "your Solo chat"
        : dm
          ? "a DM"
          : `${summary?.name ? `#${summary.name}` : "a channel"}${thread ? ", in a thread" : ""}`,
      earlier: earlier.map(line),
      latest: line(event),
      name,
    };
  }

  /** Says in the thread that a turn failed, so nobody waits on it. */
  private report(
    agent: AgentHandle,
    channel: string,
    event: EventData,
    error: string,
    topLevel: boolean,
  ) {
    return this.post(
      agent,
      channel,
      event,
      `⚠️ I couldn't finish that: ${error.slice(0, 500)}`,
      topLevel,
      [["p", agent.owner]],
    );
  }

  /** Replies as the agent in the event's thread, or at a Solo chat's top
   * level. */
  private post(
    agent: AgentHandle,
    channel: string,
    event: EventData,
    content: string,
    topLevel: boolean,
    tags: string[][] = [],
  ) {
    return agent
      .publish({
        kind: 9,
        content,
        tags: [
          ["h", channel],
          ...(topLevel
            ? []
            : [["e", threadReference(event)?.rootId ?? event.id, "", "reply"]]),
          ...tags,
        ],
      })
      .then(() => undefined)
      .catch((failure) => console.warn("fm could not post", failure));
  }
}
