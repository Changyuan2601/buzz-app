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
    (!receipt?.messageId && live.type !== MESH_TYPE) ||
    agents.relay(live.pubkey)?.snapshot().scope !== scope
  )
    throw new Error("This Concierge is unavailable in your community.");
  // Reopening an established chat must not replace a chosen harness or role.
  if (receipt?.messageId) {
    const current = meshAgentConfig(live.config);
    if (live.type === MESH_TYPE && current.preset === CONCIERGE_PRESET) {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(current.prompt),
      );
      check();
      const hash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      // Only exact shipped prototype guides: retain owner-written prompts.
      if (
        [
          "387da5697d228b954e19bc6b0d26e32c85b5ab2f09f6a8e491848c6e09cf979b",
          "703092c608d3a95a79e26169f6a117774c2d07eb77c7bd68a384b7e9ecac2d7b",
          "b98c020507363fee2b02889b0e6e5bf990b34dee74901099622cf750c859c963",
          "9daf27f40fed25e56547b13d90d31668d0622b495ce467251c068de2c02690a3",
          "5554662fee08a55d3b78508cb53f817953948496ce613121d8b44027916d0986",
        ].includes(hash)
      ) {
        const latest = agents.find(live.pubkey);
        if (
          latest?.type !== MESH_TYPE ||
          JSON.stringify(latest.config) !== JSON.stringify(live.config)
        )
          throw new Error(
            "The agent changed. Reopen onboarding before continuing.",
          );
        await agents.save(live.pubkey, { config: { ...current, prompt } });
        check();
      }
    }
    if (!receipt.creationId)
      throw new Error(
        "Onboarding delivery is incomplete. Check the existing conversation.",
      );
    await session.workSessions.delivered(receipt.creationId);
    check();
    await session.workSessions.refresh(receipt.id);
    await session.mePlacement.refresh();
    check();
    if (!session.mePlacement.has(receipt.id))
      throw new Error(
        "This conversation was moved out of Solo. Open it there before continuing.",
      );
    await session.workSessions.delivered(receipt.messageId);
    check();
    return { scope, channelId: receipt.id };
  }
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
    text: "Help me name you and connect you to my preferred AI.",
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
