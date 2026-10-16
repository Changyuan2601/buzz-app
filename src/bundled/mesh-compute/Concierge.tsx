import { conciergeDraft, type Draft } from "./conciergeDraft";
export { conciergeDraft } from "./conciergeDraft";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { RelayData } from "../../features/relay/service";
import { clearView, readView, writeView } from "../../shared/view-state";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import type { conciergeCreation } from "./conciergeCreation";
import { Select } from "../../shared/design-system/ui/Select";
import { ProviderDialog } from "../agents/ProviderDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { DEFAULT_MESH_AGENT_CONFIG, meshAgentConfig } from "./meshAgent";

export const CONCIERGE_PRESET = "buzz-concierge";
export const MESH_TYPE = "buzz.mesh-compute/mesh";
/** Only registered local harnesses that can adopt the conversational brief. */
export const conciergeHarnesses = (agents: Agents) =>
  agents
    .types()
    .filter((type) => !type.remote && (type.key === MESH_TYPE || type.adopt));
export function conciergeConfig(
  type: RegisteredAgentType,
  draft: Extract<Draft, { action: "connect" }>,
) {
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

export type ConciergeActions = {
  dispose(): void;
  available(message: ChannelMessage): boolean;
  completed(message: ChannelMessage): boolean;
  reviewed(
    message: ChannelMessage,
  ): { type: string; config: unknown } | undefined;
  target(message: ChannelMessage): Agent | undefined;
  apply(
    message: ChannelMessage,
    choice?: { type: string; config: unknown },
    name?: string,
  ): Promise<void>;
};

type Attempt = Readonly<{
  action: Draft["action"];
  before: string;
  after: string;
  done: boolean;
}>;
const identityState = (
  agent: { name: string; type: string; config: unknown },
  action: Draft["action"],
) =>
  JSON.stringify(
    action === "rename"
      ? agent.name
      : { type: agent.type, config: agent.config },
  );

/** Reuses Agents.save/retype; no identity creation or channel membership writes.
 * Save the reviewed before/after pair before mutating, so a failed receipt can
 * recover after reload without applying an old draft over subsequent edits. */
export function conciergeSetup(agents: Agents, relay: RelayData) {
  const pending = new Map<string, Promise<void>>();
  let active = true;
  const receiptKey = (message: ChannelMessage) =>
    `concierge:edit:${message.authorId}:${message.id}`;
  const receipt = (message: ChannelMessage) =>
    readView<Attempt | undefined>(
      relay.snapshot().scope ?? "",
      receiptKey(message),
      undefined,
    );
  const source = (message: ChannelMessage) => {
    const snapshot = relay.snapshot();
    const agent = agents.find(message.authorId);
    const channel = snapshot.session.channels
      .list()
      .channels.find((item) => item.id === message.channelId);
    if (
      !active ||
      snapshot.status !== "ready" ||
      snapshot.cached ||
      !snapshot.scope ||
      !snapshot.viewer ||
      agents.snapshot().status !== "ready" ||
      !agent ||
      agent.place !== "here" ||
      agent.owner !== snapshot.viewer ||
      agents.relay(agent.pubkey)?.snapshot().scope !== snapshot.scope ||
      (message.signerId && message.signerId !== message.authorId) ||
      !channel ||
      channel.archived ||
      channel.cached ||
      channel.readOnly ||
      channel.parentChannelId ||
      !channel.members?.includes(snapshot.viewer) ||
      !channel.members.includes(agent.pubkey)
    )
      return;
    if (
      !receipt(message) &&
      !(
        conciergeDraft(message.content)?.action === "start" &&
        receipt({ ...message, id: `${message.id}:self` })
      ) &&
      (agent.type !== MESH_TYPE ||
        meshAgentConfig(agent.config).preset !== CONCIERGE_PRESET)
    )
      return;
    return { snapshot, agent };
  };
  return {
    dispose: () => {
      active = false;
    },
    available: (message: ChannelMessage) => !!source(message),
    target: (message: ChannelMessage) => agents.find(message.authorId),
    completed: (message: ChannelMessage) => receipt(message)?.done === true,
    reviewed: (
      message: ChannelMessage,
    ): { type: string; config: unknown } | undefined => {
      const saved = receipt(message);
      return saved?.action === "connect" ? JSON.parse(saved.after) : undefined;
    },
    apply(message: ChannelMessage, choice?: { type: string; config: unknown }) {
      const existing = pending.get(message.id);
      if (existing) return existing;
      if (pending.size)
        return Promise.reject(
          new Error("Finish the current setup step first."),
        );
      const operation = (async () => {
        const start = source(message),
          draft = conciergeDraft(message.content);
        if (!start || !draft || draft.action === "start")
          throw new Error(
            "Reconnect to the original conversation to continue setup.",
          );
        const check = () => {
          const current = source(message);
          if (
            !current ||
            current.snapshot.session !== start.snapshot.session ||
            current.snapshot.scope !== start.snapshot.scope
          )
            throw new Error(
              "The conversation changed. Reopen setup to continue.",
            );
          return current.agent;
        };
        const scope = start.snapshot.scope;
        if (!scope) throw new Error("Reconnect before setup.");
        const save = (attempt: Attempt) => {
          check();
          if (!writeView(scope, receiptKey(message), attempt))
            throw new Error("Setup progress could not be saved. Try again.");
        };
        let attempt = receipt(message);
        if (attempt?.done) return;
        const savedTarget: { type: string; config: unknown } | undefined =
          attempt?.action === "connect" ? JSON.parse(attempt.after) : undefined;
        const type =
          draft.action === "connect"
            ? conciergeHarnesses(agents).find(
                (item) =>
                  item.key ===
                  (savedTarget?.type ?? choice?.type ?? draft.harness),
              )
            : undefined;
        if (draft.action === "connect" && !type)
          throw new Error("Choose an available local harness.");
        if (
          type?.provider &&
          (type.provider.snapshot().readiness !== "ready" ||
            type.provider.snapshot().blocking)
        )
          throw new Error(
            `Finish ${type.title} setup before connecting this agent.`,
          );
        if (!attempt) {
          let after: string;
          if (draft.action === "rename") after = JSON.stringify(draft.name);
          else {
            if (!type) throw new Error("Choose an available local harness.");
            after = JSON.stringify({
              type: type.key,
              config: choice?.config ?? conciergeConfig(type, draft),
            });
          }
          attempt = {
            action: draft.action,
            before: identityState(start.agent, draft.action),
            after,
            done: false,
          };
          save(attempt);
        }
        const live = check();
        const state = identityState(live, attempt.action);
        if (state !== attempt.after) {
          if (state !== attempt.before)
            throw new Error(
              "This agent's settings changed. Review them in Agents instead of applying this older step.",
            );
          if (attempt.action === "rename")
            await agents.save(live.pubkey, { name: JSON.parse(attempt.after) });
          else {
            const target = JSON.parse(attempt.after) as {
              type: string;
              config: unknown;
            };
            // Refused mid-turn and durably rolled back by the existing service.
            if (target.type === live.type)
              await agents.save(live.pubkey, { config: target.config });
            else
              await agents.retype(live.pubkey, target.type, {
                config: target.config,
              });
          }
        }
        if (identityState(check(), attempt.action) !== attempt.after)
          throw new Error(
            "The settings were not saved. Review the agent in Agents before continuing.",
          );
        save({ ...attempt, done: true });
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
  setup,
  creation,
  onOpenDm,
}: {
  message: ChannelMessage;
  agents: Agents;
  relay: RelayData;
  setup: ConciergeActions;
  creation?: ReturnType<typeof conciergeCreation>;
  onOpenDm?: ((channelId: string) => void) | undefined;
}) {
  useSyncExternalStore(agents.subscribe, agents.snapshot);
  useSyncExternalStore(relay.subscribe, relay.snapshot);
  const session = relay.snapshot().session;
  useSyncExternalStore(session.channels.subscribeList, session.channels.list);
  const draft = conciergeDraft(message.content);
  if (!draft || !setup.available(message))
    return (
      <p className="whitespace-pre-wrap text-body-md">{message.content}</p>
    );
  if (draft.action === "start")
    return creation ? (
      <ConciergeStart
        key={message.id}
        {...{ message, agents, relay, setup, creation, onOpenDm }}
      />
    ) : null;
  return (
    <ConciergeReview key={message.id} {...{ message, agents, setup, draft }} />
  );
}

function ConciergeReview({
  message,
  agents,
  setup,
  draft,
  startSetup = false,
  newAgentName,
}: {
  message: ChannelMessage;
  agents: Agents;
  setup: ConciergeActions;
  draft: Exclude<Draft, { action: "start" }>;
  startSetup?: boolean;
  newAgentName?: string | undefined;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [setupOpen, setSetupOpen] = useState(startSetup);
  const setupButton = useRef<HTMLButtonElement>(null);
  const done = setup.completed(message);
  const agent = setup.target(message);
  const types = conciergeHarnesses(agents);
  const proposed =
    draft.action === "connect"
      ? types.find((type) => type.key === draft.harness)
      : undefined;
  const reviewed = setup.reviewed(message);
  const [key, setKey] = useState(reviewed?.type ?? proposed?.key ?? "");
  const type = types.find((item) => item.key === (done ? agent?.type : key));
  const [config, setConfig] = useState(
    () =>
      reviewed?.config ??
      (type && draft.action === "connect"
        ? conciergeConfig(type, draft)
        : undefined),
  );
  const providerState = useSyncExternalStore(
    type?.provider?.subscribe ?? (() => () => {}),
    type?.provider?.snapshot ?? (() => undefined),
  );
  useEffect(() => {
    void type?.provider?.check();
  }, [type]);
  const apply = async () => {
    setPending(true);
    setError("");
    try {
      await setup.apply(
        message,
        draft.action === "connect" && type
          ? { type: type.key, config }
          : undefined,
        newAgentName,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  const Model = type?.CreateModel,
    Create = type?.Create;
  return (
    <section aria-label="Set up this agent" className="grid min-w-0 gap-3">
      <p className="m-0 text-label-md">
        {draft.action === "rename"
          ? `Call me ${draft.name}`
          : `${newAgentName ? "Create" : "Connect"} ${agent?.name ?? newAgentName ?? "your agent"}`}
      </p>
      {draft.action === "connect" && (
        <>
          <p className="m-0 whitespace-pre-wrap break-words text-body-md">
            {draft.instructions}
          </p>
          {!done && (
            <>
              {!startSetup && (
                <Select
                  label="Harness"
                  value={key}
                  disabled={pending || !!reviewed}
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
              )}
              {!proposed && (
                <p role="status" className="m-0 text-body-sm text-secondary">
                  That harness is unavailable. Choose one listed here.
                </p>
              )}
              {Model && (
                <Model
                  config={config}
                  disabled={pending || !!reviewed}
                  onChange={setConfig}
                />
              )}
              {Create && type?.key !== MESH_TYPE && (
                <Create
                  config={config}
                  disabled={pending || !!reviewed}
                  onChange={setConfig}
                />
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
              onClose={() => {
                setSetupOpen(false);
              }}
              onComplete={
                done
                  ? undefined
                  : () => {
                      setSetupOpen(false);
                      void apply();
                    }
              }
            />
          )}
          <p className="m-0 text-body-sm text-secondary">
            {newAgentName
              ? "This creates a separate agent and sends its welcome in a private DM with you."
              : "This changes this agent's harness and instructions, keeping its name, identity and conversation."}{" "}
            {type?.key === MESH_TYPE
              ? "Shared Compute is chat only, with no tools."
              : type?.description}{" "}
            Review the account, workspace and tool access before connecting.
          </p>
          <p className="m-0 text-body-sm">First test: {draft.test}</p>
        </>
      )}
      {done ? (
        <p role="status" className="m-0 text-body-sm">
          {draft.action === "rename"
            ? `Name saved: ${agent?.name ?? "your agent"}.`
            : newAgentName
              ? `${agent?.name ?? newAgentName} is created. Its welcome DM has been sent.`
              : `${agent?.name ?? "your agent"} is connected. Send the first test in this conversation. If sign-in needs attention, use the setup controls above.`}
        </p>
      ) : (
        <div>
          <Button
            size="sm"
            variant="prominent"
            loading={pending}
            disabled={
              draft.action === "connect" &&
              (!type ||
                (!!type.provider &&
                  (providerState?.readiness !== "ready" ||
                    !!providerState.blocking)))
            }
            onClick={() => void apply()}
          >
            {draft.action === "rename"
              ? "Use this name"
              : newAgentName
                ? `Create ${newAgentName}`
                : "Connect this agent"}
          </Button>
        </div>
      )}
      {done && draft.action === "rename" && (
        <ConciergeHarnessChoices
          message={message}
          agents={agents}
          setup={setup}
        />
      )}
      {error && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}
        </p>
      )}
      {!done && (
        <p className="m-0 text-body-sm text-secondary">
          Want a change? Tell me here before applying this step.
        </p>
      )}
    </section>
  );
}

/** A completed naming step offers the actual registered choices immediately.
 * The derived connection proposal is local UI state, not a fabricated message
 * sent to the channel. Its receipt is separate from the naming receipt. */
export function conciergeConnection(
  message: ChannelMessage,
  harness: string,
): ChannelMessage {
  return {
    ...message,
    id: `${message.id}:connect`,
    content:
      "```buzz-agent\n" +
      JSON.stringify({
        action: "connect",
        harness,
        instructions:
          "Be a helpful personal assistant. Answer directly and concisely. Ask what the person wants help with if their goal is unclear. Use only available tools when the request needs them. Never invent facts or claim actions you have not taken.",
        test: "Hi! Help me get started with my assistant.",
      }) +
      "\n```",
  };
}
function ConciergeHarnessChoices({
  message,
  agents,
  setup,
  newAgentName,
}: {
  message: ChannelMessage;
  agents: Agents;
  setup: ConciergeActions;
  newAgentName?: string | undefined;
}) {
  const agent = agents.find(message.authorId);
  const [selected, setSelected] = useState<{ key: string; opening: number }>();
  if (!agent) return null;
  const target = conciergeConnection(message, selected?.key ?? "");
  const reviewed = setup.reviewed(target);
  if (
    !reviewed &&
    (agent.type !== MESH_TYPE ||
      meshAgentConfig(agent.config).preset !== CONCIERGE_PRESET)
  )
    return (
      <p role="status" className="m-0 text-body-sm">
        Connected to{" "}
        {agents.types().find((type) => type.key === agent.type)?.title ??
          "your chosen AI"}
        . Continue with {agent.name} in this conversation.
      </p>
    );
  const key = reviewed?.type ?? selected?.key;
  const connection = conciergeConnection(message, key ?? "");
  const draft = conciergeDraft(connection.content);
  return (
    <div className="grid gap-3">
      {!reviewed && (
        <>
          <p className="m-0 text-body-md">
            Choose the AI for {newAgentName ?? "this agent"}. I'll open its
            setup and bring you back here when it's ready.
          </p>
          <p className="m-0 text-body-sm text-secondary">
            Claude, Codex and Goose can use your account and tools on this
            computer. Review the setup before connecting. Shared Compute stays
            chat only.
          </p>
          <div className="flex flex-wrap gap-2">
            {conciergeHarnesses(agents).map((type) => (
              <Button
                key={type.key}
                size="sm"
                onClick={() =>
                  setSelected((previous) => ({
                    key: type.key,
                    opening: (previous?.opening ?? 0) + 1,
                  }))
                }
              >
                {type.title}
              </Button>
            ))}
          </div>
        </>
      )}
      {key && draft?.action === "connect" && (
        <ConciergeReview
          key={`${key}:${selected?.opening ?? 0}`}
          message={connection}
          agents={agents}
          setup={setup}
          draft={draft}
          newAgentName={newAgentName}
          startSetup={!setup.completed(connection)}
        />
      )}
    </div>
  );
}

/** The chosen path and name belong to the owner, not model interpretation. */
function ConciergeStart({
  message,
  agents,
  relay,
  setup,
  creation,
  onOpenDm,
}: {
  message: ChannelMessage;
  agents: Agents;
  relay: RelayData;
  setup: ConciergeActions;
  creation: ReturnType<typeof conciergeCreation>;
  onOpenDm?: ((channelId: string) => void) | undefined;
}) {
  type Route = { mode: "self" | "new"; name: string; confirmed: boolean };
  const scope = relay.snapshot().scope ?? "",
    key = `concierge:route:${message.authorId}:${message.id}`;
  const [route, setRoute] = useState<Route | undefined>(() =>
    readView<Route | undefined>(scope, key, undefined),
  );
  const [error, setError] = useState("");
  const [, refresh] = useState(0);
  const create: ConciergeActions = {
    ...creation,
    apply: async (...args) => {
      try {
        await creation.apply(...args);
      } finally {
        refresh((value) => value + 1);
      }
    },
  };
  const save = (next: Route) => {
    if (!setup.available(message) || !writeView(scope, key, next)) {
      setError("Reconnect before continuing setup.");
      return;
    }
    setRoute(next);
    setError("");
  };
  const rename = {
    ...message,
    id: `${message.id}:self`,
    content:
      "```buzz-agent\n" +
      JSON.stringify({ action: "rename", name: route?.name ?? "" }) +
      "\n```",
  };
  const child = { ...message, id: `${message.id}:new` };
  const dm = creation.dm(conciergeConnection(child, ""));
  return (
    <section aria-label="Get started" className="grid min-w-0 gap-3">
      <p className="m-0 text-body-md">
        Hi there! I'm your concierge agent. Would you like to make me your
        assistant, or create a new agent?
      </p>
      {!route ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => save({ mode: "self", name: "", confirmed: false })}
          >
            Use this agent
          </Button>
          <Button
            size="sm"
            onClick={() => save({ mode: "new", name: "", confirmed: false })}
          >
            Create a new agent
          </Button>
        </div>
      ) : !route.confirmed ? (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (route.name.trim())
              save({ ...route, name: route.name.trim(), confirmed: true });
          }}
        >
          <Field
            label={
              route.mode === "self"
                ? "What would you like to name me?"
                : "What would you like to name your new agent?"
            }
          >
            <Input
              value={route.name}
              maxLength={60}
              required
              onValueChange={(name) => save({ ...route, name })}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={!route.name.trim()}>
              Continue
            </Button>
            <Button
              size="sm"
              onClick={() => {
                try {
                  clearView(scope, key);
                  setRoute(undefined);
                } catch {
                  setError("Could not return to the choices. Try again.");
                }
              }}
            >
              Back
            </Button>
          </div>
        </form>
      ) : route.mode === "self" ? (
        <ConciergeReview
          message={rename}
          agents={agents}
          setup={setup}
          draft={{ action: "rename", name: route.name }}
        />
      ) : (
        <>
          <ConciergeHarnessChoices
            message={child}
            agents={agents}
            setup={create}
            newAgentName={route.name}
          />
          {dm && (
            <Button size="sm" onClick={() => onOpenDm?.(dm)}>
              Open DM
            </Button>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
