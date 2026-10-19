// Archive and recover for config channels (plan §8.1): a durable intent,
// retried on reconnect and restart until strong relay metadata confirms it.
// It rolls back only after a definite refusal plus a strong read showing the
// old state; anything uncertain keeps it pending and starts blocked.
import { PublishRejected } from "../relay/outbox";
import { refusal } from "./agent-config-artifacts";
import type { ConfigChannels } from "./config-channels";

export const LIFECYCLE_STORAGE_KEY = "buzz.agents.config.lifecycle.v1";

export type Lifecycle = "active" | "archiving" | "archived" | "recovering";
type Entry = Readonly<{ state: Exclude<Lifecycle, "active">; channel: string }>;

/** Per `community\nsubject` (agent pubkey or team id); absent is `active`. */
export class LifecycleJournal {
  private entries: Record<string, Entry> = {};
  constructor(private readonly storage: Storage = localStorage) {
    try {
      const value = JSON.parse(
        storage.getItem(LIFECYCLE_STORAGE_KEY) ?? "null",
      ) as { version?: unknown; entries?: unknown } | null;
      if (
        value?.version === 1 &&
        value.entries &&
        typeof value.entries === "object"
      )
        this.entries = value.entries as Record<string, Entry>;
    } catch {
      /* Start fresh after malformed local data. */
    }
  }
  get = (community: string, subject: string): Lifecycle =>
    this.entries[`${community}\n${subject}`]?.state ?? "active";
  pending = (community: string) =>
    Object.entries(this.entries).flatMap(([key, entry]) => {
      const [at, subject] = key.split("\n");
      return at === community &&
        subject &&
        (entry.state === "archiving" || entry.state === "recovering")
        ? [{ subject, ...entry }]
        : [];
    });
  put(community: string, subject: string, entry: Entry | undefined) {
    const key = `${community}\n${subject}`;
    if (entry) this.entries[key] = entry;
    else delete this.entries[key];
    this.storage.setItem(
      LIFECYCLE_STORAGE_KEY,
      JSON.stringify({ version: 1, entries: this.entries }),
    );
  }
}

/** A relay answer that refuses the request outright, as opposed to one
 * that may still have taken effect (timeout, lost OK, rate limit). */
function definite(error: unknown) {
  if (!(error instanceof PublishRejected)) return false;
  const kind = refusal(error.reason ?? error.message);
  return kind !== "unknown" && kind !== "rate-limited" && kind !== "duplicate";
}

export type LifecycleDeps = Readonly<{
  channels: Pick<ConfigChannels, "archive" | "unarchive" | "archived">;
  journal: LifecycleJournal;
  community: string;
  signal?: AbortSignal;
}>;

/** Persists the intent, then drives it once. Call `drive` again to retry. */
export function begin(
  deps: LifecycleDeps,
  subject: string,
  channel: string,
  action: "archive" | "recover",
) {
  deps.journal.put(deps.community, subject, {
    state: action === "archive" ? "archiving" : "recovering",
    channel,
  });
  return drive(deps, subject, channel);
}

/** One request and strong metadata read for a pending intent. */
export async function drive(
  deps: LifecycleDeps,
  subject: string,
  channel: string,
): Promise<Lifecycle> {
  const { journal, community, channels, signal } = deps;
  const state = journal.get(community, subject);
  if (state !== "archiving" && state !== "recovering") return state;
  const archiving = state === "archiving";
  let refused = false;
  try {
    await (archiving
      ? channels.archive(channel, signal)
      : channels.unarchive(channel, signal));
  } catch (error) {
    refused = definite(error);
  }
  let archived: boolean;
  try {
    archived = await channels.archived(channel, signal);
  } catch {
    return state;
  }
  return settle(deps, subject, channel, archived, refused);
}

/** Applies strong (or live-discovered) metadata to a pending intent. */
export function settle(
  deps: LifecycleDeps,
  subject: string,
  channel: string,
  archived: boolean,
  refused = false,
): Lifecycle {
  const { journal, community } = deps;
  const state = journal.get(community, subject);
  if (state === "archiving") {
    if (archived)
      journal.put(community, subject, { state: "archived", channel });
    else if (refused) journal.put(community, subject, undefined);
    return journal.get(community, subject);
  }
  if (state === "recovering") {
    if (!archived) journal.put(community, subject, undefined);
    else if (refused)
      journal.put(community, subject, { state: "archived", channel });
    return journal.get(community, subject);
  }
  return state;
}

/** Applies discovered metadata, whoever changed it: a pending intent settles,
 * and with none pending the channel's own state is admitted, so an archive or
 * recovery made on another device holds here too. */
export function observe(
  deps: LifecycleDeps,
  subject: string,
  channel: string,
  archived: boolean,
): Lifecycle {
  const { journal, community } = deps;
  const state = journal.get(community, subject);
  if (state === "archiving" || state === "recovering")
    return settle(deps, subject, channel, archived);
  journal.put(
    community,
    subject,
    archived ? { state: "archived", channel } : undefined,
  );
  return journal.get(community, subject);
}

/** Retries every pending intent in the community: on reconnect and restart. */
export const resumeAll = (deps: LifecycleDeps) =>
  Promise.all(
    deps.journal
      .pending(deps.community)
      .map(({ subject, channel }) => drive(deps, subject, channel)),
  );
