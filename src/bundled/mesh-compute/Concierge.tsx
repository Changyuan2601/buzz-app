import { useState, useSyncExternalStore } from "react";
import type { Agents } from "../../features/agents/service";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { RelayData } from "../../features/relay/service";
import { randomAgentAvatar } from "../../features/agents/avatar-packs";
import { canAddMembers } from "../../features/channel-members/members";
import { Button } from "../../shared/design-system/ui/Button";
import { DEFAULT_MESH_AGENT_CONFIG, meshAgentConfig } from "./meshAgent";

export const CONCIERGE_PRESET = "buzz-concierge";
export const MESH_TYPE = "buzz.mesh-compute/mesh";
type Draft = Readonly<{ name: string; instructions: string; test: string }>;

/** Model output is a bounded proposal, never an executable command. */
export function conciergeDraft(content: string): Draft | undefined {
  if (content.length > 12_000) return;
  const blocks = [
    ...content.matchAll(/^```buzz-agent\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm),
  ];
  const json = blocks[0]?.[1];
  if (blocks.length !== 1 || !json) return;
  try {
    const value = JSON.parse(json);
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (Object.keys(value).sort().join() !== "instructions,name,test") return;
    const limits = { name: 60, instructions: 4000, test: 400 };
    for (const key of Object.keys(limits) as (keyof Draft)[]) {
      if (
        typeof value[key] !== "string" ||
        !value[key].trim() ||
        value[key].length > limits[key] ||
        Array.from(value[key] as string).some(
          (character) =>
            character.charCodeAt(0) < 32 && !"\n\r\t".includes(character),
        )
      )
        return;
    }
    return {
      name: value.name.trim(),
      instructions: value.instructions.trim(),
      test: value.test.trim(),
    };
  } catch {
    return;
  }
}

/** One plugin-owned in-flight action per proposal, shared by all mounted copies.
 * Persisted source IDs in Agents config prevent another creation after reload. */
export function conciergeCreation(agents: Agents, relay: RelayData) {
  const pending = new Map<string, Promise<void>>();
  const identities = new Map<string, string>();
  let active = true;
  const source = (message: ChannelMessage) => {
    const snapshot = relay.snapshot();
    const agent = agents.find(message.authorId);
    if (
      !active ||
      snapshot.status !== "ready" ||
      snapshot.cached ||
      !snapshot.viewer ||
      agents.snapshot().status !== "ready" ||
      !agent ||
      agent.place !== "here" ||
      agent.owner !== snapshot.viewer ||
      agent.type !== MESH_TYPE ||
      meshAgentConfig(agent.config).preset !== CONCIERGE_PRESET ||
      agents.relay(agent.pubkey)?.snapshot().scope !== snapshot.scope ||
      (message.signerId && message.signerId !== message.authorId)
    )
      return;
    const channel = snapshot.session.channels
      .list()
      .channels.find((item) => item.id === message.channelId);
    if (
      !channel ||
      channel.archived ||
      channel.cached ||
      channel.readOnly ||
      !canAddMembers(snapshot.session, channel) ||
      !channel.members?.includes(snapshot.viewer)
    )
      return;
    return snapshot;
  };
  const made = (id: string) =>
    agents
      .snapshot()
      .agents.find(
        (agent) =>
          agent.type === MESH_TYPE &&
          (meshAgentConfig(agent.config).onboardingSource === id ||
            agent.pubkey === identities.get(id)),
      );
  const unresolved = (message: ChannelMessage) => {
    const attempt = meshAgentConfig(
      agents.find(message.authorId)?.config,
    ).onboardingAttempt;
    return !!attempt && !made(attempt);
  };
  return {
    dispose: () => {
      active = false;
    },
    available: (message: ChannelMessage) => !!source(message),
    made,
    unresolved,
    create(message: ChannelMessage) {
      const existing = pending.get(message.id);
      if (existing) return existing;
      if (pending.size)
        return Promise.reject(
          new Error("Finish the current draft's setup first."),
        );
      const operation = (async () => {
        const snapshot = source(message);
        const draft = conciergeDraft(message.content);
        if (!snapshot || !draft)
          throw new Error(
            "Reconnect to the original community and reopen this draft.",
          );
        const check = () => {
          const current = source(message);
          if (
            !current ||
            current.session !== snapshot.session ||
            current.scope !== snapshot.scope
          )
            throw new Error(
              "The conversation changed. Reopen the draft to continue.",
            );
        };
        let agent = made(message.id);
        const config = {
          ...DEFAULT_MESH_AGENT_CONFIG,
          mode: "chat" as const,
          prompt: draft.instructions,
          onboardingSource: message.id,
        };
        if (!agent) {
          if (unresolved(message))
            throw new Error(
              "An earlier creation did not finish. Recover the existing agent in Agents before creating another.",
            );
          const concierge = agents.find(message.authorId);
          await agents.save(message.authorId, {
            config: {
              ...meshAgentConfig(concierge?.config),
              onboardingAttempt: message.id,
            },
          });
          check();
          agent = await agents.create({
            type: MESH_TYPE,
            name: draft.name,
            picture: randomAgentAvatar().url,
            config,
          });
          identities.set(message.id, agent.pubkey);
        }
        check();
        const live = agents.find(agent.pubkey);
        if (
          !live ||
          live.owner !== snapshot.viewer ||
          live.place !== "here" ||
          live.type !== MESH_TYPE
        )
          throw new Error(
            "The created agent is unavailable. Check it in Agents before continuing.",
          );
        const saved = meshAgentConfig(live.config);
        // create() can return optimistic config after a storage failure. Inspect
        // the service's actual snapshot and use its throwing save path to recover.
        if (saved.onboardingSource !== message.id)
          await agents.save(live.pubkey, { config });
        check();
        const verified = meshAgentConfig(agents.find(live.pubkey)?.config);
        if (
          verified.mode !== "chat" ||
          verified.prompt !== draft.instructions ||
          verified.onboardingSource !== message.id
        )
          throw new Error(
            "The agent's settings differ from this draft. Review them in Agents before continuing.",
          );
        const concierge = meshAgentConfig(
          agents.find(message.authorId)?.config,
        );
        const { onboardingAttempt: _, ...resolved } = concierge;
        // Once the draft is created, let the new agent answer its own test.
        // Explicit Concierge mentions still work with Attention switched off.
        await agents.save(message.authorId, {
          config: resolved,
          attentionEnabled: false,
        });
        check();
        // The session owns signed membership, confirmation and retries. If this
        // fails, the saved agent is reused when the person chooses Continue.
        await snapshot.session.memberAdditions.add(
          message.channelId,
          agent.pubkey,
        );
        check();
      })().finally(() => pending.delete(message.id));
      pending.set(message.id, operation);
      return operation;
    },
  };
}

export function ConciergeDraft({
  message,
  agents,
  relay,
  creation,
}: {
  message: ChannelMessage;
  agents: Agents;
  relay: RelayData;
  creation: ReturnType<typeof conciergeCreation>;
}) {
  useSyncExternalStore(agents.subscribe, agents.snapshot);
  useSyncExternalStore(relay.subscribe, relay.snapshot);
  const snapshot = relay.snapshot();
  useSyncExternalStore(
    snapshot.session.channels.subscribeList,
    snapshot.session.channels.list,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const draft = conciergeDraft(message.content);
  if (!draft || !creation.available(message))
    return (
      <p className="whitespace-pre-wrap text-body-md">{message.content}</p>
    );
  const made = creation.made(message.id);
  const saved = made && meshAgentConfig(made.config);
  const changed =
    saved?.onboardingSource === message.id &&
    (saved.mode !== "chat" || saved.prompt !== draft.instructions);
  const unresolved = !pending && creation.unresolved(message);
  const joined =
    made &&
    snapshot.session.channels
      .list()
      .channels.find((channel) => channel.id === message.channelId)
      ?.members?.includes(made.pubkey);
  const create = async () => {
    setPending(true);
    setError("");
    try {
      await creation.create(message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <section
      aria-label="Review your first agent"
      className="grid min-w-0 gap-3"
    >
      <p className="m-0 text-label-md">{draft.name}</p>
      <p className="m-0 whitespace-pre-wrap break-words text-body-md">
        {draft.instructions}
      </p>
      <p className="m-0 text-body-sm text-secondary">
        Uses shared compute. Chat only, with no tools. Responds when mentioned.
        Creating it also adds it to this channel so it can read the
        conversation.
      </p>
      <p className="m-0 text-body-sm">First test: {draft.test}</p>
      {changed ? (
        <p role="alert" className="m-0 text-body-sm text-secondary">
          This agent's settings have changed. Review its current setup in
          Agents.
        </p>
      ) : unresolved ? (
        <p role="alert" className="m-0 text-body-sm text-danger">
          A previous setup did not finish. Check Agents for the partly created
          agent. This draft is paused to prevent another copy.
        </p>
      ) : joined ? (
        <p role="status" className="m-0 text-body-sm">
          {made.name} is ready. Mention it here and send the first test. To
          revise its instructions, open Agents → Settings.
        </p>
      ) : (
        <div>
          <Button
            size="sm"
            variant="prominent"
            loading={pending}
            disabled={!creation.available(message)}
            onClick={() => void create()}
          >
            {made ? "Continue setup" : "Create agent"}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}
        </p>
      )}
      <p className="m-0 text-body-sm text-secondary">
        Want changes? Tell Buzz Concierge here before creating the draft.
      </p>
    </section>
  );
}
