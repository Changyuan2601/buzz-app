import type { Agent, Agents } from "../../features/agents/service";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { RelayData } from "../../features/relay/service";
import { readView, writeView } from "../../shared/view-state";
import { randomAgentAvatar } from "../../features/agents/avatar-packs";
import {
  conciergeHarnesses,
  CONCIERGE_PRESET,
  MESH_TYPE,
  type ConciergeActions,
} from "./Concierge";
import { meshAgentConfig } from "./meshAgent";

type Receipt = {
  name: string;
  type: string;
  config: unknown;
  pubkey?: string;
  channelId?: string;
  welcomeAttempted?: boolean;
  done?: boolean;
};
/** One bounded creation from a chosen onboarding card. No access to the guide's
 * channel is granted. Uncertain identity or message outcomes never resend. */
export function conciergeCreation(
  agents: Agents,
  relay: RelayData,
): ConciergeActions & { dm(message: ChannelMessage): string | undefined } {
  const pending = new Map<string, Promise<void>>();
  let active = true;
  const controller = new AbortController();
  const key = (message: ChannelMessage) =>
    `concierge:new:${message.authorId}:${message.id}`;
  const receipt = (message: ChannelMessage) =>
    readView<Receipt | undefined>(
      relay.snapshot().scope ?? "",
      key(message),
      undefined,
    );
  const source = (message: ChannelMessage) => {
    const snapshot = relay.snapshot(),
      author = agents.find(message.authorId);
    const channel = snapshot.session.channels
      .list()
      .channels.find((item) => item.id === message.channelId);
    if (
      !active ||
      snapshot.status !== "ready" ||
      snapshot.cached ||
      !snapshot.viewer ||
      !snapshot.scope ||
      agents.snapshot().status !== "ready" ||
      author?.place !== "here" ||
      author.owner !== snapshot.viewer ||
      author.type !== MESH_TYPE ||
      meshAgentConfig(author.config).preset !== CONCIERGE_PRESET ||
      agents.relay(author.pubkey)?.snapshot().scope !== snapshot.scope ||
      (message.signerId && message.signerId !== message.authorId) ||
      !channel ||
      channel.archived ||
      channel.cached ||
      channel.readOnly ||
      channel.parentChannelId ||
      !channel.members?.includes(snapshot.viewer) ||
      !channel.members.includes(author.pubkey)
    )
      return;
    return snapshot;
  };
  return {
    dispose: () => {
      active = false;
      controller.abort();
    },
    available: (message) => !!source(message),
    completed: (message) => receipt(message)?.done === true,
    target: (message) => {
      const saved = receipt(message);
      return saved?.pubkey ? agents.find(saved.pubkey) : undefined;
    },
    reviewed: (message) => {
      const saved = receipt(message);
      return saved ? { type: saved.type, config: saved.config } : undefined;
    },
    dm: (message) =>
      source(message) ? receipt(message)?.channelId : undefined,
    apply(message, choice, name) {
      const existing = pending.get(message.id);
      if (existing) return existing;
      if (pending.size)
        return Promise.reject(
          new Error("Finish the current agent's setup first."),
        );
      const operation = (async () => {
        const start = source(message);
        if (!start || !choice || !name?.trim() || name.length > 60)
          throw new Error("Name the new agent and choose an available AI.");
        const check = () => {
          const current = source(message);
          if (
            !current ||
            current.session !== start.session ||
            current.scope !== start.scope
          )
            throw new Error(
              "The conversation changed. Reopen this setup to continue.",
            );
        };
        const save = (value: Receipt) => {
          check();
          if (!writeView(start.scope ?? "", key(message), value))
            throw new Error("Setup progress could not be saved. Try again.");
        };
        let saved = receipt(message);
        const type = conciergeHarnesses(agents).find(
          (item) => item.key === (saved?.type ?? choice.type),
        );
        if (!type) throw new Error("Choose an available local AI.");
        if (saved?.done) return;
        if (
          type.provider &&
          (type.provider.snapshot().readiness !== "ready" ||
            type.provider.snapshot().blocking)
        )
          throw new Error(`Finish ${type.title} setup first.`);
        if (!saved) {
          saved = { name: name.trim(), type: type.key, config: choice.config };
          save(saved);
          const created = await agents.create({
            name: saved.name,
            type: saved.type,
            config: saved.config,
            picture: randomAgentAvatar().url,
          });
          check();
          saved = { ...saved, pubkey: created.pubkey };
          save(saved);
        }
        if (!saved.pubkey)
          throw new Error(
            "An earlier creation has an uncertain outcome. Recover the existing agent in Agents before continuing.",
          );
        const agent = agents.find(saved.pubkey);
        const checkAgent = (current: Agent | undefined) => {
          check();
          if (
            current?.place !== "here" ||
            current.owner !== start.viewer ||
            current.type !== saved?.type ||
            JSON.stringify(current.config) !== JSON.stringify(saved.config)
          )
            throw new Error(
              "The new agent's settings were not saved or have changed. Review it in Agents before continuing.",
            );
        };
        checkAgent(agent);
        if (!saved.channelId) {
          await start.session.agentChoices.refresh();
          checkAgent(agents.find(saved.pubkey));
          if (
            !start.session.agentChoices
              .snapshot()
              .identities.some(
                (item) => item.managed && item.pubkey === saved?.pubkey,
              )
          )
            throw new Error(
              "The new agent is not ready to message in this community.",
            );
          const channelId = await start.session.directMessages.open(
            [saved.pubkey],
            controller.signal,
          );
          checkAgent(agents.find(saved.pubkey));
          saved = { ...saved, channelId };
          save(saved);
        }
        const { pubkey, channelId } = saved;
        if (!pubkey || !channelId)
          throw new Error("The new agent DM is not ready.");
        const confirmOnly = saved.welcomeAttempted === true;
        saved = { ...saved, welcomeAttempted: true };
        save(saved);
        await agents.welcome(
          pubkey,
          channelId,
          message.id.split(":")[0] ?? "",
          confirmOnly,
        );
        checkAgent(agents.find(pubkey));
        save({ ...saved, done: true });
      })().finally(() => pending.delete(message.id));
      pending.set(message.id, operation);
      return operation;
    },
  };
}
