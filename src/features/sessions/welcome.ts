import { savedWelcomeClientId } from "../agents/conversation-start";
// One device's explicitly requested Welcome setup, scoped like Solo's drafts.
// The existing outbox owns signed channel operations; this receipt owns sequence.
import type { Agents } from "../agents/service";
import type { RelaySession } from "../relay/session";
import type { EventData } from "../relay/events";
import { useCallback, useSyncExternalStore } from "react";
import {
  subscribeView,
  viewRevision,
  writeView,
} from "../../shared/view-state";

export const WELCOME_KEY = "me:welcome";
/** The first agent speaks as the app until its owner names it. */
export const BUZZ_AGENT_NAME = "Buzz";
export const WELCOME_CHAT_NAME = "Get started";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const pubkey = /^[0-9a-f]{64}$/;
export type WelcomeReceipt = {
  channelId: string;
  type: string;
  creatingAgent?: boolean;
  agent?: string;
  creationId?: string;
  creatingChannel?: boolean;
  invited?: boolean;
  kickoff?: "attempted" | "observed";
  replyId?: string;
  kickoffAt?: number;
  complete?: boolean;
  greeting?: "pending" | "attempted";
  greetingId?: string;
  greetingAt?: number;
  /** The agent saved instructions from its setup answers. */
  instructions?: "saved";
};
export function readWelcome(scope: string): WelcomeReceipt | undefined {
  const revision = viewRevision(scope, WELCOME_KEY);
  if (revision === undefined)
    throw new Error("Welcome setup could not be read from this device.");
  if (!revision || revision === "null") return undefined;
  const value = JSON.parse(revision) as WelcomeReceipt;
  if (
    !value ||
    !uuid.test(value.channelId) ||
    typeof value.type !== "string" ||
    (value.agent !== undefined && !pubkey.test(value.agent)) ||
    [value.creationId, value.replyId, value.greetingId].some(
      (id) => id !== undefined && !pubkey.test(id),
    ) ||
    (value.greetingAt !== undefined &&
      (!Number.isSafeInteger(value.greetingAt) || value.greetingAt < 0)) ||
    (value.greeting !== undefined &&
      value.greeting !== "pending" &&
      value.greeting !== "attempted") ||
    (value.kickoffAt !== undefined &&
      (!Number.isSafeInteger(value.kickoffAt) || value.kickoffAt < 0)) ||
    (value.kickoff !== undefined &&
      value.kickoff !== "attempted" &&
      value.kickoff !== "observed")
  )
    throw new Error(
      "Saved Welcome setup is invalid. Open Agents and Solo to inspect it; nothing was restarted.",
    );
  return value;
}
/** This device's Welcome setup for the scope, kept current as it changes. */
export function useWelcomeReceipt(scope: string) {
  useSyncExternalStore(
    useCallback((notify) => subscribeView(scope, notify), [scope]),
    () => viewRevision(scope, WELCOME_KEY) ?? "unavailable",
  );
  try {
    return { receipt: readWelcome(scope), error: "" };
  } catch (error) {
    return {
      receipt: undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
export function saveWelcome(scope: string, receipt: WelcomeReceipt) {
  if (!writeView(scope, WELCOME_KEY, receipt))
    throw new Error(
      "Welcome setup could not be saved on this device. No further setup was started.",
    );
}
/** Existing protocol operations only. No viewer message, made-up reply, or
 * name-based lookup. A failed step resumes from the exact ids already submitted. */
export async function prepareWelcome(
  session: RelaySession,
  agents: Agents,
  scope: string,
  type: string,
  config: unknown,
  signal: AbortSignal,
) {
  const check = () => {
    signal.throwIfAborted();
  };
  let receipt = readWelcome(scope) ?? { channelId: crypto.randomUUID(), type };
  const save = () => {
    saveWelcome(scope, receipt);
  };
  save();
  check();
  if (!receipt.agent) {
    if (receipt.creatingAgent)
      throw new Error(
        "An agent may have been created before setup was interrupted. Choose its exact identity below to resume; no second agent was created.",
      );
    const picture = await buzzPicture(session, signal);
    check();
    receipt = { ...receipt, creatingAgent: true };
    save();
    const agent = await agents.create({
      type: receipt.type,
      name: BUZZ_AGENT_NAME,
      ...(picture ? { picture } : {}),
      config,
    });
    // Record the exact key even if this view retired while native was writing it.
    receipt = { ...receipt, agent: agent.pubkey };
    save();
    check();
  }
  const key = receipt.agent;
  if (!key) throw new Error("The Welcome agent has not been created.");
  const agent = agents.find(key);
  if (!agent || agent.type !== receipt.type || agent.owner !== session.viewer)
    throw new Error(
      "This Welcome agent is not available in the current community. Open Agents to check it.",
    );
  if (!receipt.creationId) {
    if (receipt.creatingChannel)
      throw new Error(
        "The channel may have been created before setup was interrupted. Open Solo or Outbox to inspect it; no second channel was created.",
      );
    receipt = { ...receipt, creatingChannel: true };
    save();
    receipt = {
      ...receipt,
      creationId: session.channelWrites.create(
        receipt.channelId,
        WELCOME_CHAT_NAME,
        undefined,
        true,
      ),
    };
    save();
  }
  if (!receipt.creationId)
    throw new Error("Welcome creation was not recorded.");
  await session.channelWrites.delivered(receipt.creationId);
  check();
  await session.channelWrites.refresh(receipt.channelId);
  check();
  await session.agentChoices.refresh();
  check();
  if (
    !session.agentChoices
      .snapshot()
      .selectable.some((choice) => choice.pubkey === key)
  )
    throw new Error("The Welcome agent is no longer available to select.");
  if (!receipt.invited) {
    await session.channelWrites.addAgents(
      receipt.channelId,
      [key],
      () => !signal.aborted,
    );
    receipt = { ...receipt, invited: true };
    save();
  }
  check();
  return receipt;
}

/** The Buzz mark as a community-hosted picture other clients can load.
 * Media is content-addressed, so every owner's upload shares one file. The
 * agent falls back to its initial when uploads are unavailable. */
async function buzzPicture(session: RelaySession, signal: AbortSignal) {
  const upload = session.attachments?.uploadForNewChat;
  if (!upload) return undefined;
  try {
    const response = await fetch("/app-icon.png", { signal });
    if (!response.ok) return undefined;
    const file = new File([await response.blob()], "buzz.png", {
      type: "image/png",
    });
    return (await upload(file, signal)).url;
  } catch {
    signal.throwIfAborted();
    return undefined;
  }
}

/** Read actual agent-authored history before an explicit retry. A successful
 * provider turn is not evidence that it published anything; the event is. */
export async function observedWelcome(
  session: RelaySession,
  receipt: WelcomeReceipt,
  signal: AbortSignal,
  phase: "connected" | "saved" = "connected",
): Promise<EventData | undefined> {
  if (!receipt.agent || (phase === "connected" && !receipt.kickoffAt))
    return undefined;
  const since =
    phase === "saved"
      ? (receipt.greetingAt ?? receipt.kickoffAt ?? 0)
      : (receipt.kickoffAt ?? 0);
  const marker =
    phase === "saved" ? savedWelcomeClientId(receipt.channelId) : undefined;
  // Use an ordinary author-filtered query, not NIP-CW's channel window:
  // that path requires a composite cursor and does not apply author/since
  // predicates. It also owns cancellation of live timeline head reads.
  const until = Math.max(since, Math.floor(Date.now() / 1000));
  const events = await session.read(
    [
      {
        kinds: [9],
        authors: [receipt.agent],
        "#h": [receipt.channelId],
        limit: 20,
        consistency: "strong",
        since,
        until,
      },
    ],
    { signal },
  );
  signal.throwIfAborted();
  const introduction = events.find(
    (event) =>
      event.kind === 9 &&
      event.pubkey === receipt.agent &&
      event.created_at >= since &&
      (!marker ||
        event.tags.some(
          ([key, value]) => key === "client-id" && value === marker,
        )) &&
      !event.tags.some(([key]) => key === "e") &&
      event.tags.some(
        ([key, value]) => key === "h" && value === receipt.channelId,
      ),
  );
  // Ordinary queries include thread replies. A full page cannot establish
  // absence of an older introduction; do not start a duplicate in that case.
  if (!introduction && events.length >= 20)
    throw new Error(
      "The introduction check reached its history limit. Inspect this Welcome chat before trying another introduction.",
    );
  return introduction;
}
