import { getEventHash, verifyEvent, type EventTemplate } from "nostr-tools";
import type { createAgentChoices } from "../agents/choices";
import { attestedOwner } from "../agents/owner-attestation";
import { deliver, type SnapshotRead } from "../agents/agent-config-artifacts";
import type { ChannelDetailsCapability } from "../relay/channel-details";
import type { ChannelDetails } from "../relay/channel-details-protocol";
import { channelLabelTags } from "../relay/channel-labels";
import {
  lifecycleChannelId,
  lifecycleRecord,
} from "../relay/channel-lifecycle-protocol";
import type { ChannelSummary, Profile } from "../relay/contracts";
import type { RelayEvent } from "../relay/events";
import type { RelayWriter } from "../relay/transport";
import { SOLO_LABEL } from "./labels";

export const PRIMARY_LABEL = "buzz.solo.primary";
const TYPE = "buzz.solo.primary";
const PIN = "buzz.solo.p:";
// Base36 keeps a full 256-bit event id inside NIP-CL's 64-character label limit.
export const primaryPin = (id: string) =>
  PIN + BigInt(`0x${id}`).toString(36).padStart(50, "0");
function pinned(labels: readonly string[] = []) {
  const pins = labels.filter((label) => label.startsWith(PIN));
  const value = pins[0]?.slice(PIN.length);
  if (pins.length !== 1 || !value || !/^[0-9a-z]{50}$/.test(value))
    return undefined;
  let id = 0n;
  for (const digit of value) id = id * 36n + BigInt(parseInt(digit, 36));
  const hex = id.toString(16).padStart(64, "0");
  return HEX.test(hex) ? hex : undefined;
}
const HEX = /^[0-9a-f]{64}$/;
export type PrimaryBinding = Readonly<{
  version: 1;
  owner: string;
  identity: string;
  mode: "automatic" | "mention-only";
  defaults: "harness-default";
}>;
export type PrimaryState = Readonly<{
  adopted?: true;
  revision?: string;
  binding?: PrimaryBinding;
}>;
export type PrimaryReceipt = Readonly<{
  identity: string;
  revision: string;
  targeting: "implicit" | "explicit";
}>;
export type EffectiveRecipients = Readonly<{
  recipients: readonly string[];
  unadopted?: true;
  primary?: PrimaryReceipt;
  notice?: string;
}>;
/** Source can restrict delivery, never authorize execution on another signer's behalf. */
export type PrimarySender = Readonly<{
  pubkey: string;
  source: "human" | "agent-reply" | "cross-session";
}>;
const tag = (event: RelayEvent, name: string) => {
  const found = event.tags.filter(([label]) => label === name);
  return found.length === 1 && found[0]?.length === 2 ? found[0][1] : undefined;
};
export const primaryTags = (receipt?: PrimaryReceipt): string[][] =>
  receipt
    ? [["primary", receipt.identity, receipt.revision, receipt.targeting]]
    : [];

/** Session-owned configuration/admission; channel membership and runner authorization remain their existing owners'. */
export function createSoloPrimary({
  viewer,
  relayAuthor,
  signal: lifetime,
  read,
  writer,
  details,
  membership,
  choices,
  profiles,
}: {
  viewer: string;
  relayAuthor?: string | undefined;
  signal: AbortSignal;
  read?: SnapshotRead | undefined;
  writer?: RelayWriter | undefined;
  details: ChannelDetailsCapability;
  membership(channel: string): Promise<ChannelSummary>;
  choices: Pick<
    ReturnType<typeof createAgentChoices>,
    "ensure" | "refresh" | "snapshot"
  >;
  profiles: { snapshot(): ReadonlyMap<string, Profile> };
}) {
  function owned<T>(
    work: (signal: AbortSignal) => Promise<T>,
    caller?: AbortSignal,
  ) {
    const signal = caller ? AbortSignal.any([lifetime, caller]) : lifetime;
    signal.throwIfAborted();
    return work(signal).then((value) => {
      signal.throwIfAborted();
      return value;
    });
  }
  // A complete owner reset takes effect after reconnect/restart, not Reload primary;
  // this session retains its adoption veto rather than trusting missing evidence.
  const observed = new Set<string>();
  async function adoption(channel: string, signal: AbortSignal) {
    if (!read || !relayAuthor)
      throw new Error("Chat response settings are unavailable.");
    const events = await read(
      [
        {
          kinds: [39000],
          authors: [relayAuthor],
          "#d": [channel],
          limit: 1,
          consistency: "strong",
        },
      ],
      { signal },
    );
    signal.throwIfAborted();
    const labels =
      events[0]?.tags
        .filter(([name]) => name === "t")
        .map(([, value]) => value ?? "") ?? [];
    if (
      labels.some((label) => label === PRIMARY_LABEL || label.startsWith(PIN))
    )
      observed.add(channel);
    if (observed.has(channel)) return true;
    // History only vetoes legacy inference; it never supplies binding authority.
    // Redacting every revision and removing both labels is an explicit owner reset.
    const unavailable = new Error(
      "Primary adoption evidence is unavailable. The chat owner must restore its primary labels in channel settings, then reload primary.",
    );
    const heads = await read(
      [
        {
          kinds: [45010, 45011],
          "#h": [channel],
          limit: 64,
          consistency: "strong",
        },
      ],
      { signal },
    ).catch(() => {
      throw unavailable;
    });
    signal.throwIfAborted();
    if (heads.length >= 64) throw unavailable;
    const relevant = heads.filter(
      (event) =>
        tag(event, "type") === TYPE ||
        (event.kind === 45011 && event.pubkey === relayAuthor),
    );
    if (!relevant.length) return false;
    const owner = (await roster(channel, signal)).creator;
    for (const event of relevant) {
      const d = tag(event, "d");
      if (!d || tag(event, "h") !== channel || tag(event, "ar") !== "1")
        throw unavailable;
      const history = await read(
        [
          {
            kinds: [45010],
            "#h": [channel],
            "#d": [d],
            artifact: "history",
            limit: 64,
          },
        ],
        { signal },
      ).catch(() => {
        throw unavailable;
      });
      signal.throwIfAborted();
      if (!history.length || history.length >= 64) throw unavailable;
      if (
        history.some(
          (revision) =>
            revision.kind === 45010 &&
            revision.pubkey === owner &&
            tag(revision, "type") === TYPE &&
            tag(revision, "ar") === "1" &&
            tag(revision, "h") === channel &&
            tag(revision, "d") === d &&
            verifyEvent(revision),
        )
      ) {
        observed.add(channel);
        return true;
      }
    }
    return false;
  }
  async function roster(channel: string, signal: AbortSignal) {
    const value = await membership(channel);
    signal.throwIfAborted();
    if (
      value.id !== channel ||
      value.cached ||
      value.pending ||
      value.archived ||
      !value.creator ||
      !HEX.test(value.creator) ||
      !value.members?.includes(viewer)
    )
      throw new Error(
        "Chat participants could not be verified. Retry before continuing.",
      );
    return { ...value, creator: value.creator };
  }
  async function authority(value: ChannelSummary, signal: AbortSignal) {
    const channel = value.id;
    if (!read || !relayAuthor)
      throw new Error("Chat response settings are unavailable.");
    const events = await read(
      [
        {
          kinds: [39001],
          authors: [relayAuthor],
          "#d": [channel],
          limit: 1,
          consistency: "strong",
        },
      ],
      { signal },
    );
    signal.throwIfAborted();
    const admins = lifecycleRecord(
      events,
      39001,
      channel,
      relayAuthor,
    )?.tags.filter(([name]) => name === "p");
    // Label editors must act for the owner; display-only ownership hints are insufficient.
    const denied = new Error(
      "Primary replies require all channel administrators to be the owner or agents managed by the owner.",
    );
    if (
      !admins?.some(
        (entry) => entry[1] === value.creator && entry[2] === "owner",
      ) ||
      new Set(admins.map((entry) => entry[1])).size !== admins.length ||
      admins.some(
        (entry) =>
          entry.length !== 3 ||
          !HEX.test(entry[1] ?? "") ||
          !["owner", "admin"].includes(entry[2] ?? ""),
      )
    )
      throw denied;
    for (const [, key] of admins) {
      if (!key) throw denied;
      if (key === value.creator) continue;
      const profiles = await read(
        [{ kinds: [0], authors: [key], limit: 1, consistency: "strong" }],
        { signal },
      );
      signal.throwIfAborted();
      const profile = profiles[0];
      if (
        profiles.length !== 1 ||
        !profile ||
        profile.kind !== 0 ||
        profile.pubkey !== key ||
        !verifyEvent(profile) ||
        (await attestedOwner(profile)) !== value.creator
      )
        throw denied;
    }
  }
  async function head(
    channel: string,
    owner: string,
    metadata: ChannelDetails,
    signal: AbortSignal,
  ): Promise<PrimaryState> {
    if (!read) throw new Error("Chat response settings are unavailable.");
    const revision = pinned(metadata.labels);
    if (!revision || !metadata.labels?.includes(PRIMARY_LABEL))
      return { adopted: true };
    signal.throwIfAborted();
    const events = await read(
      [
        {
          kinds: [45010],
          "#h": [channel],
          ids: [revision],
          limit: 1,
          consistency: "strong",
        },
      ],
      { signal },
    );
    signal.throwIfAborted();
    if (!events.length) return { adopted: true, revision };
    const event = events[0];
    if (
      !event ||
      events.length !== 1 ||
      event.kind !== 45010 ||
      event.id !== revision ||
      !tag(event, "d") ||
      tag(event, "h") !== channel ||
      tag(event, "ar") !== "1" ||
      tag(event, "type") !== TYPE ||
      event.pubkey !== owner
    )
      return { adopted: true, revision };
    const op = tag(event, "op"),
      prev = tag(event, "prev");
    if (
      !["create", "update", "restore", "delete"].includes(op ?? "") ||
      (op === "create"
        ? event.tags.some(([name]) => name === "prev")
        : !prev || !HEX.test(prev))
    )
      return { adopted: true, revision };
    if (op === "delete" && event.content === "")
      return { adopted: true, revision: event.id };
    let value: unknown;
    try {
      value = JSON.parse(event.content);
    } catch {
      /* Unreadable state never guesses another primary. */
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { adopted: true, revision };
    const binding = value as Record<string, unknown>;
    if (
      op === "delete" ||
      event.content.length > 1024 ||
      binding.version !== 1 ||
      binding.owner !== owner ||
      binding.defaults !== "harness-default" ||
      typeof binding.identity !== "string" ||
      !HEX.test(binding.identity) ||
      (binding.mode !== "automatic" && binding.mode !== "mention-only") ||
      Object.keys(binding).some(
        (field) =>
          !["version", "owner", "identity", "mode", "defaults"].includes(field),
      )
    )
      return { adopted: true, revision };
    return {
      adopted: true,
      revision: event.id,
      binding: binding as PrimaryBinding,
    };
  }
  async function available(
    identity: string,
    channel: ChannelSummary,
    signal: AbortSignal,
  ) {
    choices.ensure(true, true);
    await choices.refresh();
    signal.throwIfAborted();
    const agents = choices.snapshot();
    if (
      !channel.members?.includes(identity) ||
      !agents.selectable.some((agent) => agent.pubkey === identity) ||
      !["ready", "unavailable"].includes(agents.archives.status)
    )
      throw new Error(
        "The primary agent is unavailable or no longer a member. Choose it again in chat settings.",
      );
  }
  async function context(
    channel: string,
    signal: AbortSignal,
    authorize = false,
  ) {
    const current = await roster(channel, signal);
    if (authorize) await authority(current, signal);
    const metadata = await details.load(channel, signal);
    signal.throwIfAborted();
    return { current, metadata, solo: !!metadata.labels?.includes(SOLO_LABEL) };
  }
  return Object.freeze({
    available: !!read && !!writer && !!relayAuthor && details.available,
    load(channel: string, caller?: AbortSignal) {
      return owned(async (signal) => {
        if (details.snapshot(channel)?.status === "unconfirmed")
          await details.check(channel, signal);
        if (!(await adoption(channel, signal))) return {};
        const { current, metadata } = await context(channel, signal, true);
        return head(channel, current.creator, metadata, signal);
      }, caller);
    },
    save(
      channel: string,
      expected: PrimaryState,
      identity: string,
      mode: PrimaryBinding["mode"],
      caller?: AbortSignal,
    ) {
      return owned(async (signal) => {
        if (!writer)
          throw new Error("Chat response settings cannot be saved here.");
        if (
          !HEX.test(identity) ||
          !["automatic", "mention-only"].includes(mode)
        )
          throw new Error("Choose an agent and response mode.");
        const { current, metadata, solo } = await context(
          channel,
          signal,
          true,
        );
        const state = await head(channel, current.creator, metadata, signal);
        const retainAfterConversion =
          state.binding?.identity === identity && mode === "mention-only";
        if (
          (!solo &&
            (mode !== "mention-only" ||
              !metadata.labels?.includes(PRIMARY_LABEL))) ||
          current.creator !== viewer ||
          !metadata.canEdit
        )
          throw new Error(
            "Only the owner of this Solo chat can choose its primary agent.",
          );
        if (!solo && state.binding && state.binding.identity !== identity)
          throw new Error("A converted channel must retain its primary agent.");
        if (!retainAfterConversion) await available(identity, current, signal);
        if (state.revision !== expected.revision)
          throw new Error(
            "Chat response settings changed. Reload before saving.",
          );
        if (details.snapshot(channel))
          throw new Error(
            "Finish the existing channel details change before continuing.",
          );
        channelLabelTags([
          ...(metadata.labels ?? []).filter((label) => !label.startsWith(PIN)),
          PRIMARY_LABEL,
          primaryPin("0".repeat(64)),
        ]);
        // Persist this veto first so an interrupted create/redacted head cannot look like a legacy chat.
        if (!metadata.labels?.includes(PRIMARY_LABEL)) {
          await details.save(
            metadata,
            {
              ...metadata,
              labels: [...(metadata.labels ?? []), PRIMARY_LABEL],
            },
            signal,
          );
          signal.throwIfAborted();
        }
        const fresh = await context(channel, signal, true);
        if (
          (!fresh.solo &&
            (mode !== "mention-only" ||
              (state.binding && state.binding.identity !== identity))) ||
          fresh.current.creator !== viewer ||
          !fresh.metadata.labels?.includes(PRIMARY_LABEL)
        )
          throw new Error("Chat settings changed. Reload before saving.");
        if (!retainAfterConversion)
          await available(identity, fresh.current, signal);
        const template = {
          kind: 45010,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["ar", "1"],
            ["d", crypto.randomUUID()],
            ["h", channel],
            ["type", TYPE],
            ["title", "Solo primary agent"],
            ["op", "create"],
          ],
          content: JSON.stringify({
            version: 1,
            owner: viewer,
            identity,
            mode,
            defaults: "harness-default",
          } satisfies PrimaryBinding),
        } satisfies EventTemplate;
        const event = await writer.sign(structuredClone(template), signal);
        signal.throwIfAborted();
        if (
          event.pubkey !== viewer ||
          event.kind !== template.kind ||
          event.created_at !== template.created_at ||
          event.content !== template.content ||
          JSON.stringify(event.tags) !== JSON.stringify(template.tags) ||
          getEventHash(event) !== event.id ||
          !verifyEvent(event)
        )
          throw new Error(
            "The chat owner must sign the exact response settings.",
          );
        const delivery = await deliver(writer, event, signal);
        signal.throwIfAborted();
        if (delivery.status !== "accepted")
          throw new Error(
            delivery.status === "uncertain"
              ? "The save may have succeeded. Reload chat settings before retrying."
              : delivery.message,
          );
        const beforePin = await context(channel, signal, true);
        if (
          pinned(beforePin.metadata.labels) !== state.revision ||
          !beforePin.metadata.labels?.includes(PRIMARY_LABEL) ||
          beforePin.current.creator !== viewer ||
          !beforePin.metadata.canEdit ||
          (!beforePin.solo &&
            (mode === "automatic" ||
              (state.binding && state.binding.identity !== identity)))
        )
          throw new Error(
            "Chat response settings changed. Reload before saving.",
          );
        await details.save(
          beforePin.metadata,
          {
            ...beforePin.metadata,
            labels: [
              ...(beforePin.metadata.labels ?? []).filter(
                (label) => !label.startsWith(PIN),
              ),
              primaryPin(event.id),
            ],
          },
          signal,
        );
        const confirmed = await context(channel, signal, true);
        const saved = await head(channel, viewer, confirmed.metadata, signal);
        if (
          saved.revision !== event.id ||
          !saved.binding ||
          pinned((await details.load(channel, signal)).labels) !== event.id
        )
          throw new Error(
            "The save is no longer current. Reload chat settings before continuing.",
          );
        return saved;
      }, caller);
    },
    resolve(
      channel: string,
      explicit: readonly string[],
      sender: PrimarySender,
      caller?: AbortSignal,
    ): Promise<EffectiveRecipients> {
      return owned(async (signal) => {
        const recipients = [...new Set(explicit)];
        try {
          if (!(await adoption(channel, signal)))
            return { recipients, unadopted: true };
          const { current, solo, metadata } = await context(channel, signal);
          if (!current.members?.includes(sender.pubkey))
            throw new Error("The sender is no longer a chat participant.");
          const state = await head(channel, current.creator, metadata, signal);
          choices.ensure(true, true);
          await choices.refresh();
          signal.throwIfAborted();
          const agents = choices.snapshot(),
            known = new Set(agents.identities.map((agent) => agent.pubkey));
          const people = profiles.snapshot();
          const explicitAgent = recipients.some(
            (key) => known.has(key) || people.get(key)?.isAgent,
          );
          if (
            !state.binding ||
            !state.revision ||
            !metadata.labels?.includes(PRIMARY_LABEL)
          )
            throw new Error(
              "The primary binding is missing. Reload chat settings; no replacement will be chosen.",
            );
          const binding = state.binding;
          if (explicitAgent && !recipients.includes(binding.identity))
            return { recipients };
          const explicitPrimary = recipients.includes(binding.identity);
          if (!explicitPrimary) {
            if (
              sender.source === "agent-reply" ||
              (sender.source === "human" && sender.pubkey !== binding.owner)
            )
              return { recipients };
            if (!solo || binding.mode === "mention-only") return { recipients };
            if (
              (recipients.length > 0 && !agents.complete) ||
              recipients.some((key) => !people.has(key))
            )
              throw new Error(
                "Tagged participants are still loading. Retry before sending.",
              );
          }
          if (sender.pubkey !== binding.owner || sender.source !== "human")
            return {
              recipients,
              notice:
                "Only the chat owner can invoke its primary. Guest and cross-session execution is not available.",
            };
          try {
            await authority(current, signal);
            await available(binding.identity, current, signal);
          } catch (reason) {
            signal.throwIfAborted();
            return {
              recipients,
              notice: reason instanceof Error ? reason.message : String(reason),
            };
          }
          return {
            recipients: explicitPrimary
              ? recipients
              : [...recipients, binding.identity],
            primary: {
              identity: binding.identity,
              revision: state.revision,
              targeting: explicitPrimary ? "explicit" : "implicit",
            },
          };
        } catch (reason) {
          signal.throwIfAborted();
          return {
            recipients,
            notice: reason instanceof Error ? reason.message : String(reason),
          };
        }
      }, caller);
    },
    /** A signed recipient is not proof of an explicit mention on older clients. */
    current(event: RelayEvent, identity: string, caller?: AbortSignal) {
      return owned(async (signal) => {
        const channels = event.tags.filter(([name]) => name === "h");
        const channel = channels.length === 1 ? channels[0]?.[1] : undefined;
        const marked = event.tags.some(([name]) => name === "primary");
        if (event.kind !== 9) return false;
        if (!channels.length) return !marked;
        if (channels.length !== 1 || channels[0]?.length !== 2) return false;
        try {
          lifecycleChannelId(channel ?? "");
        } catch {
          return false;
        }
        if (!channel) return false;
        const receipts = event.tags.filter(
          ([name, target]) => name === "primary" && target === identity,
        );
        if (!(await adoption(channel, signal))) return !marked;
        const { current, solo, metadata } = await context(channel, signal);
        const state = await head(channel, current.creator, metadata, signal);
        if (!state.binding || !metadata.labels?.includes(PRIMARY_LABEL))
          throw new Error(
            "The primary binding is missing or unreadable. Ask the owner to restore the primary labels in channel settings, then reload primary.",
          );
        if (state.binding.identity !== identity && !receipts.length) {
          const targets = event.tags.filter(
            ([name, target]) => name === "p" && target === identity,
          );
          if (!targets.length) return false;
          if (
            targets.length !== 1 ||
            targets[0]?.length !== 4 ||
            targets[0][2] !== "" ||
            targets[0][3] !== "mention"
          )
            throw new Error(
              "Agent targeting is ambiguous. Send an explicit @-mention from an updated client, or ask the owner to Set primary or select Mention-only.",
            );
          const fresh = await context(channel, signal);
          return (
            pinned(fresh.metadata.labels) === state.revision &&
            fresh.metadata.labels?.includes(PRIMARY_LABEL) === true &&
            fresh.current.members?.includes(identity) === true
          );
        }
        const receipt = receipts[0];
        if (
          receipts.length !== 1 ||
          receipt?.length !== 4 ||
          receipt[2] !== state.revision ||
          (receipt[3] !== "explicit" && receipt[3] !== "implicit") ||
          state.binding.identity !== identity ||
          !event.tags.some(
            ([name, target]) => name === "p" && target === identity,
          ) ||
          event.pubkey !== state.binding.owner ||
          !current.members?.includes(event.pubkey) ||
          (receipt[3] === "implicit" &&
            (!solo || state.binding.mode !== "automatic"))
        )
          return false;
        await authority(current, signal);
        await available(identity, current, signal);
        const latest = await head(channel, current.creator, metadata, signal);
        const fresh = await context(channel, signal, true);
        return (
          pinned(fresh.metadata.labels) === state.revision &&
          latest.revision === state.revision &&
          latest.binding?.identity === identity &&
          fresh.metadata.labels?.includes(PRIMARY_LABEL) === true &&
          fresh.current.members?.includes(identity) === true &&
          fresh.current.members?.includes(event.pubkey) === true &&
          (receipt[3] === "explicit" ||
            (fresh.solo && latest.binding.mode === "automatic"))
        );
      }, caller);
    },
  });
}
