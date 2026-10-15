import type { Agents } from "../../features/agents/service";
import type { RelayData } from "../../features/relay/service";
import {
  readPending,
  type PendingStart,
} from "../../features/sessions/pending-start";
import { writeSelectedAssistant } from "../../features/sessions/selected-assistant";
import { readView, writeView } from "../../shared/view-state";
import { randomAgentAvatar } from "../../features/agents/avatar-packs";
import { CONCIERGE_PRESET, MESH_TYPE } from "./Concierge";
import { meshAgentConfig } from "./meshAgent";
import prompt from "./BUZZ_CONCIERGE.md?raw";

export const ONBOARDING_COMMUNITY = "https://meshllm.communities.buzz.xyz";
const starts = new WeakMap<
  RelayData,
  Promise<{ scope: string; channelId: string }>
>();

/** Prototype entry using the same receipt, admission and placement owners as
 * NewSessionComposer. The owner seed produces a real signed model welcome. */
export function startConcierge(
  agents: Agents,
  relay: RelayData,
  signal: AbortSignal,
) {
  const pending = starts.get(relay);
  if (pending) return pending;
  const operation = start(agents, relay, signal).finally(() =>
    starts.delete(relay),
  );
  starts.set(relay, operation);
  return operation;
}

async function start(agents: Agents, relay: RelayData, signal: AbortSignal) {
  const snapshot = relay.snapshot();
  if (
    snapshot.status !== "ready" ||
    snapshot.cached ||
    !snapshot.viewer ||
    snapshot.origin !== ONBOARDING_COMMUNITY ||
    !snapshot.scope ||
    agents.snapshot().status !== "ready"
  )
    throw new Error("Connect to MeshLLM and wait for your agents to load.");
  const { session, scope, viewer } = snapshot;
  const check = () => {
    signal.throwIfAborted();
    const next = relay.snapshot();
    if (
      next.status !== "ready" ||
      next.session !== session ||
      next.scope !== scope ||
      next.viewer !== viewer ||
      next.cached
    )
      throw new Error("The community changed. Reopen onboarding to continue.");
  };
  const save = (receipt: PendingStart) => {
    check();
    if (!writeView(scope, "concierge:pending", receipt))
      throw new Error(
        "Onboarding could not be saved on this device. No further steps were sent.",
      );
  };
  check();
  let receipt = readPending(scope, "concierge");
  const identity = readView<{ pending?: boolean; pubkey?: string }>(
    scope,
    "concierge:identity",
    {},
  );
  let concierge = receipt?.agent
    ? agents.find(receipt.agent)
    : identity.pubkey
      ? agents.find(identity.pubkey)
      : agents
          .snapshot()
          .agents.find(
            (agent) =>
              agent.place === "here" &&
              agent.owner === viewer &&
              agent.type === MESH_TYPE &&
              meshAgentConfig(agent.config).preset === CONCIERGE_PRESET,
          );
  if (!concierge) {
    if (receipt || identity.pending || identity.pubkey)
      throw new Error(
        "An earlier Concierge setup is unfinished. Check Agents before starting another.",
      );
    if (!writeView(scope, "concierge:identity", { pending: true }))
      throw new Error("Concierge setup could not be saved. Try again.");
    concierge = await agents.create({
      type: MESH_TYPE,
      name: "Buzz Concierge",
      picture: randomAgentAvatar().url,
      config: {
        mode: "chat",
        scope: "channel",
        preset: CONCIERGE_PRESET,
        prompt,
        workspace: "~/.buzz",
      },
    });
    check();
    if (!writeView(scope, "concierge:identity", { pubkey: concierge.pubkey }))
      throw new Error(
        "Concierge was created but its setup could not be saved. Check Agents before continuing.",
      );
  }
  check();
  const live = agents.find(concierge.pubkey);
  if (
    live?.place !== "here" ||
    live.owner !== viewer ||
    live.type !== MESH_TYPE ||
    agents.relay(live.pubkey)?.snapshot().scope !== scope
  )
    throw new Error("This Concierge is unavailable in your community.");
  // Throwing save verifies persistence even if create returned optimistic config.
  const config = {
    ...meshAgentConfig(live.config),
    mode: "chat" as const,
    scope: "channel" as const,
    preset: CONCIERGE_PRESET,
    prompt,
  };
  await agents.save(live.pubkey, { config, attentionEnabled: false });
  check();
  const saved = meshAgentConfig(agents.find(live.pubkey)?.config);
  if (
    saved.mode !== "chat" ||
    saved.prompt !== prompt ||
    saved.preset !== CONCIERGE_PRESET
  )
    throw new Error(
      "Concierge settings were not saved. Check Agents before continuing.",
    );
  receipt ??= {
    id: crypto.randomUUID(),
    text: "Help me create my first agent.",
    agent: live.pubkey,
  };
  save(receipt);
  if (!receipt.creationId) {
    await session.mePlacement.admit(receipt.id);
    check();
    receipt.creationId = session.workSessions.create(
      receipt.id,
      "Welcome to Buzz",
      undefined,
      true,
    );
    save(receipt);
  }
  await session.workSessions.delivered(receipt.creationId);
  check();
  await session.workSessions.refresh(receipt.id);
  check();
  if (!receipt.placementDone) {
    await session.mePlacement.set(receipt.id, true);
    check();
    receipt.placementDone = true;
    save(receipt);
  } else {
    await session.mePlacement.refresh();
    check();
  }
  if (!session.mePlacement.has(receipt.id))
    throw new Error(
      "This conversation was moved out of Solo. Open it there before continuing.",
    );
  await session.agentChoices.refresh();
  check();
  if (
    !session.agentChoices
      .snapshot()
      .selectable.some((agent) => agent.pubkey === live.pubkey)
  )
    throw new Error("Buzz Concierge is not available in your agent library.");
  await session.workSessions.addAgents(
    receipt.id,
    [live.pubkey],
    () => !signal.aborted && relay.snapshot().session === session,
  );
  check();
  if (!writeSelectedAssistant(scope, receipt.id, live.pubkey))
    throw new Error("Your follow-up assistant could not be saved. Try again.");
  if (!receipt.messageId) {
    receipt.messageId = session.messages.send(receipt.id, receipt.text, [
      live.pubkey,
    ]);
    save(receipt);
  }
  await session.workSessions.delivered(receipt.messageId);
  check();
  return { scope, channelId: receipt.id };
}
