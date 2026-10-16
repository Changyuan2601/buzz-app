// One device's explicitly requested Welcome setup, scoped like Solo's drafts.
// The existing outbox owns signed channel operations; this receipt owns sequence.
import type { Agents } from "../agents/service";
import type { RelaySession } from "../relay/session";
import type { EventData } from "../relay/events";
import { readView, viewRevision, writeView } from "../../shared/view-state";
import { writeSelectedAssistant } from "./selected-assistant";

export const WELCOME_KEY = "me:welcome";
const DEFAULT_KEY = "me:default-agent";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const pubkey = /^[0-9a-f]{64}$/;
export type WelcomeReceipt = {
  channelId: string;
  type: string;
  creatingAgent?: boolean;
  agent?: string;
  creationId?: string;
  creatingChannel?: boolean;
  invitationId?: string;
  kickoff?: "attempted" | "observed";
  replyId?: string;
  kickoffAt?: number;
  complete?: boolean;
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
    [value.creationId, value.invitationId, value.replyId].some(
      (id) => id !== undefined && !pubkey.test(id),
    ) ||
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
export function saveWelcome(scope: string, receipt: WelcomeReceipt) {
  if (!writeView(scope, WELCOME_KEY, receipt))
    throw new Error(
      "Welcome setup could not be saved on this device. No further setup was started.",
    );
}
export function defaultAssistant(scope: string) {
  const value = readView<unknown>(scope, DEFAULT_KEY, "");
  return typeof value === "string" && pubkey.test(value) ? value : "";
}
export function saveDefaultAssistant(scope: string, key: string) {
  if (!pubkey.test(key) || !writeView(scope, DEFAULT_KEY, key))
    throw new Error("The default assistant could not be saved on this device.");
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
    receipt = { ...receipt, creatingAgent: true };
    save();
    const agent = await agents.create({
      type: receipt.type,
      name: "Welcome",
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
    await session.mePlacement.admit(receipt.channelId);
    check();
    receipt = { ...receipt, creatingChannel: true };
    save();
    receipt = {
      ...receipt,
      creationId: session.workSessions.create(
        receipt.channelId,
        "Welcome",
        undefined,
        true,
      ),
    };
    save();
  }
  if (!receipt.creationId)
    throw new Error("Welcome creation was not recorded.");
  await session.workSessions.delivered(receipt.creationId);
  check();
  await session.workSessions.refresh(receipt.channelId);
  check();
  await session.mePlacement.set(receipt.channelId, true);
  check();
  await session.agentChoices.refresh();
  check();
  if (
    !session.agentChoices
      .snapshot()
      .selectable.some((choice) => choice.pubkey === key)
  )
    throw new Error("The Welcome agent is no longer available to select.");
  if (!receipt.invitationId) {
    receipt = {
      ...receipt,
      invitationId: session.workSessions.invite(receipt.channelId, key),
    };
    save();
  }
  if (!receipt.invitationId)
    throw new Error("Welcome invitation was not recorded.");
  await session.workSessions.delivered(receipt.invitationId);
  check();
  await session.workSessions.refresh(receipt.channelId, { member: key });
  check();
  if (!writeSelectedAssistant(scope, receipt.channelId, key))
    throw new Error(
      "The selected assistant could not be saved. Retry Welcome.",
    );
  return receipt;
}

/** Read actual agent-authored history before an explicit retry. A successful
 * provider turn is not evidence that it published anything; the event is. */
export async function observedWelcome(
  session: RelaySession,
  receipt: WelcomeReceipt,
  signal: AbortSignal,
): Promise<EventData | undefined> {
  if (!receipt.agent || !receipt.kickoffAt) return undefined;
  const since = receipt.kickoffAt;
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
