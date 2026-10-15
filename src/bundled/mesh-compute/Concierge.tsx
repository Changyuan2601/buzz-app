import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { RelayData } from "../../features/relay/service";
import { randomAgentAvatar } from "../../features/agents/avatar-packs";
import {
  canAddMembers,
  canShareSession,
} from "../../features/channel-members/members";
import { writeSelectedAssistant } from "../../features/sessions/selected-assistant";
import { Select } from "../../shared/design-system/ui/Select";
import { ProviderDialog } from "../agents/ProviderDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { DEFAULT_MESH_AGENT_CONFIG, meshAgentConfig } from "./meshAgent";

export const CONCIERGE_PRESET = "buzz-concierge";
export const MESH_TYPE = "buzz.mesh-compute/mesh";
type Draft = Readonly<{
  name: string;
  instructions: string;
  test: string;
  harness?: string;
}>;

/** Only registered local harnesses that can adopt the conversational brief. */
export const conciergeHarnesses = (agents: Agents) =>
  agents
    .types()
    .filter((type) => !type.remote && (type.key === MESH_TYPE || type.adopt));
export function conciergeConfig(type: RegisteredAgentType, draft: Draft) {
  if (type.key === MESH_TYPE)
    return {
      ...DEFAULT_MESH_AGENT_CONFIG,
      mode: "chat" as const,
      scope: "channel" as const,
      prompt: draft.instructions,
    };
  if (!type.adopt)
    throw new Error("This harness cannot use the agent's instructions.");
  return type.adopt(
    { instructions: draft.instructions },
    type.defaults().config,
  );
}
async function fingerprint(config: unknown) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(config)),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

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
    if (
      !["instructions,name,test", "harness,instructions,name,test"].includes(
        Object.keys(value).sort().join(),
      )
    )
      return;
    if (
      value.harness !== undefined &&
      (typeof value.harness !== "string" ||
        !value.harness.trim() ||
        value.harness.length > 200)
    )
      return;
    const limits = { name: 60, instructions: 4000, test: 400 };
    for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
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
      ...(value.harness ? { harness: value.harness.trim() } : {}),
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
  const configurations = new Map<
    string,
    { type: string; config: unknown; observed: string | undefined }
  >();
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
      !(
        canAddMembers(snapshot.session, channel) ||
        (canShareSession(snapshot.session, channel) && !channel.parentChannelId)
      ) ||
      !channel.members?.includes(snapshot.viewer)
    )
      return;
    return snapshot;
  };
  const receipt = (id: string) =>
    agents
      .snapshot()
      .agents.map((agent) => meshAgentConfig(agent.config).onboardingCreated)
      .find((item) => item?.source === id);
  const made = (id: string) =>
    agents
      .snapshot()
      .agents.find(
        (agent) =>
          (agent.type === MESH_TYPE &&
            meshAgentConfig(agent.config).onboardingSource === id) ||
          agent.pubkey === identities.get(id) ||
          agent.pubkey === receipt(id)?.pubkey,
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
    create(
      message: ChannelMessage,
      choice?: { type: string; config: unknown },
    ) {
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
        const chosen = configurations.get(message.id) ??
          choice ?? {
            type: MESH_TYPE,
            config: {
              ...DEFAULT_MESH_AGENT_CONFIG,
              mode: "chat" as const,
              prompt: draft.instructions,
              onboardingSource: message.id,
            },
          };
        const type = agents
          .types()
          .find((item) => item.key === (agent?.type ?? chosen.type));
        if (!type || type.remote || (type.key !== MESH_TYPE && !type.adopt))
          throw new Error("Choose an available local harness.");
        if (
          !agent &&
          type.provider &&
          (type.provider.snapshot().readiness !== "ready" ||
            type.provider.snapshot().blocking)
        )
          throw new Error(
            `Finish ${type.title} setup before creating this agent.`,
          );
        const config =
          type.key === MESH_TYPE
            ? {
                ...meshAgentConfig(chosen.config),
                onboardingSource: message.id,
              }
            : chosen.config;
        const previous = receipt(message.id);
        if (!agent) {
          if (unresolved(message))
            throw new Error(
              "An earlier creation did not finish. Recover the existing agent in Agents before creating another.",
            );
          const concierge = agents.find(message.authorId);
          if (meshAgentConfig(concierge?.config).onboardingCreated)
            throw new Error(
              "Your first agent is already created. Open Agents to manage it.",
            );
          await agents.save(message.authorId, {
            config: {
              ...meshAgentConfig(concierge?.config),
              onboardingAttempt: message.id,
            },
          });
          check();
          agent = await agents.create({
            type: type.key,
            name: draft.name,
            picture: randomAgentAvatar().url,
            config,
          });
          identities.set(message.id, agent.pubkey);
          configurations.set(message.id, {
            ...chosen,
            observed: JSON.stringify(agents.find(agent.pubkey)?.config),
          });
        }
        check();
        const live = agents.find(agent.pubkey);
        if (
          !live ||
          live.owner !== snapshot.viewer ||
          live.place !== "here" ||
          live.type !== type.key
        )
          throw new Error(
            "The created agent is unavailable. Check it in Agents before continuing.",
          );
        // create() can return optimistic config after a storage failure. Inspect
        // the actual snapshot. Only repair a known failed initial write while
        // its observed fallback remains unchanged; never overwrite later edits.
        if (
          !previous &&
          JSON.stringify(live.config) !== JSON.stringify(config)
        ) {
          const initial = configurations.get(message.id);
          if (
            !initial ||
            initial.observed === JSON.stringify(config) ||
            initial.observed !== JSON.stringify(live.config)
          )
            throw new Error(
              "The agent's settings differ from this draft. Review them in Agents before continuing.",
            );
          await agents.save(live.pubkey, { config });
          configurations.set(message.id, {
            ...initial,
            observed: JSON.stringify(config),
          });
        }
        check();
        const verified = agents.find(live.pubkey)?.config;
        const reviewed = JSON.stringify(verified);
        const checkChild = () => {
          check();
          const current = agents.find(live.pubkey);
          if (
            !current ||
            current.type !== live.type ||
            current.place !== "here" ||
            current.owner !== snapshot.viewer ||
            JSON.stringify(current.config) !== reviewed
          )
            throw new Error(
              "The agent's settings differ from this draft. Review them in Agents before continuing.",
            );
        };
        const hash = await fingerprint(verified);
        checkChild();
        if (
          previous
            ? previous.type !== live.type || previous.hash !== hash
            : JSON.stringify(verified) !== JSON.stringify(config)
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
          config: {
            ...resolved,
            onboardingCreated: {
              source: message.id,
              pubkey: live.pubkey,
              type: live.type,
              hash,
            },
          },
          attentionEnabled: false,
        });
        checkChild();
        // The session owns signed membership, confirmation and retries. If this
        // fails, the saved agent is reused when the person chooses Continue.
        const channel = snapshot.session.channels
          .list()
          .channels.find((item) => item.id === message.channelId);
        if (channel?.channelType === "session") {
          await snapshot.session.agentChoices.refresh();
          checkChild();
          await snapshot.session.workSessions.addAgents(
            message.channelId,
            [agent.pubkey],
            () => {
              try {
                checkChild();
                return true;
              } catch {
                return false;
              }
            },
          );
        } else
          await snapshot.session.memberAdditions.add(
            message.channelId,
            agent.pubkey,
          );
        check();
        if (
          snapshot.session.mePlacement?.has(message.channelId) &&
          !writeSelectedAssistant(
            snapshot.scope ?? "",
            message.channelId,
            agent.pubkey,
          )
        )
          throw new Error(
            "The agent was added, but the follow-up assistant could not be saved. Choose it in the composer.",
          );
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
  return (
    <ConciergeReview
      key={message.id}
      {...{
        message,
        agents,
        relay,
        creation,
        draft,
        pending,
        setPending,
        error,
        setError,
      }}
    />
  );
}

function ConciergeReview({
  message,
  agents,
  relay,
  creation,
  draft,
  pending,
  setPending,
  error,
  setError,
}: {
  message: ChannelMessage;
  agents: Agents;
  relay: RelayData;
  creation: ReturnType<typeof conciergeCreation>;
  draft: Draft;
  pending: boolean;
  setPending(value: boolean): void;
  error: string;
  setError(value: string): void;
}) {
  const snapshot = relay.snapshot();
  const made = creation.made(message.id);
  const types = conciergeHarnesses(agents);
  const proposed = types.find(
    (type) =>
      type.key === draft.harness ||
      type.title.toLowerCase() === draft.harness?.toLowerCase(),
  );
  const [key, setKey] = useState(proposed?.key ?? MESH_TYPE);
  const type = types.find((item) => item.key === (made?.type ?? key));
  const [config, setConfig] = useState(
    () => type && conciergeConfig(type, draft),
  );
  const [setupOpen, setSetupOpen] = useState(false);
  const setupButton = useRef<HTMLButtonElement>(null);
  const providerState = useSyncExternalStore(
    type?.provider?.subscribe ?? (() => () => {}),
    type?.provider?.snapshot ?? (() => undefined),
  );
  useEffect(() => {
    void type?.provider?.check();
  }, [type]);
  const Model = type?.CreateModel;
  const Create = type?.Create;
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
      if (!type) throw new Error("Choose an available harness.");
      await creation.create(message, {
        type: type.key,
        config: made?.config ?? config,
      });
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
      {!made && (
        <>
          <Select
            label="Harness"
            value={key}
            disabled={pending}
            groups={[
              {
                label: "On this computer",
                options: types.map((item) => ({
                  value: item.key,
                  label: item.title,
                })),
              },
            ]}
            onValueChange={(next) => {
              const selected = types.find((item) => item.key === next);
              if (!selected) return;
              setKey(next);
              setConfig(conciergeConfig(selected, draft));
              setError("");
            }}
          />
          {draft.harness && !proposed && (
            <p role="status" className="m-0 text-body-sm text-secondary">
              {draft.harness} is unavailable. Choose one of the harnesses shown
              here.
            </p>
          )}
          {Model && (
            <Model config={config} disabled={pending} onChange={setConfig} />
          )}
          {Create && type?.key !== MESH_TYPE && (
            <Create config={config} disabled={pending} onChange={setConfig} />
          )}
        </>
      )}
      {type?.provider && (
        <div>
          <Button
            ref={setupButton}
            size="sm"
            disabled={pending}
            onClick={() => setSetupOpen(true)}
          >
            {providerState?.readiness === "ready"
              ? `Manage ${type.title}`
              : `Set up ${type.title}`}
          </Button>
        </div>
      )}
      {setupOpen && (
        <ProviderDialog
          type={type}
          finalFocus={setupButton}
          onClose={() => setSetupOpen(false)}
        />
      )}
      <p className="m-0 text-body-sm text-secondary">
        {type?.key === MESH_TYPE
          ? "Uses shared compute. Chat only, with no tools."
          : type?.description}{" "}
        Creating it adds it to this conversation. In Solo, it becomes your
        follow-up assistant. Other harnesses can use their account and tools on
        this computer; review their settings before creating.
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
          {made.name} has been created. Send the first test in Solo, or mention
          it here. If it needs sign-in, use its setup controls above. To revise
          its instructions, open Agents → Settings.
        </p>
      ) : (
        <div>
          <Button
            size="sm"
            variant="prominent"
            loading={pending}
            disabled={
              !creation.available(message) ||
              !type ||
              (!made &&
                !!type.provider &&
                (providerState?.readiness !== "ready" ||
                  !!providerState.blocking))
            }
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
