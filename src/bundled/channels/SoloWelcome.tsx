import { publicKeyLabels } from "../../shared/identity/public-key";
import {
  useContext,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  AgentsContext,
  useAgents,
  useAgent,
} from "../../features/agents/react";
import type {
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import type { RelaySession } from "../../features/relay/session";
import {
  observedWelcome,
  prepareWelcome,
  readWelcome,
  saveWelcome,
  useWelcomeReceipt,
  type WelcomeReceipt,
} from "../../features/sessions/welcome";
import { writeView } from "../../shared/view-state";
import type { InlineUiHostValue } from "../../features/inline-ui/host";
import { setDefaultAgent } from "../../features/solo/default-agent";
import { followupDraft } from "../../features/messages/mention-draft";
import { ProviderDialog } from "../agents/ProviderDialog";
import { SoloTitle } from "../../features/solo/SoloPresentation";
import {
  ContributionBoundary,
  contributionKey,
} from "../../features/conversation/ContributionBoundary";
import { Button } from "../../shared/design-system/ui/Button";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Select } from "../../shared/design-system/ui/Select";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { WelcomeNextSteps } from "./WelcomeNextSteps";
import { WelcomeIntro, WelcomeComposer } from "./WelcomeIntro";
import { GearIcon, CircleNotchIcon } from "../../shared/design-system/icons";
import soloStyles from "../../features/solo/Solo.module.css";
import styles from "./SoloWelcome.module.css";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
/** Prepared app content inside real Solo. It never impersonates an agent turn. */
export function SoloWelcome({
  session,
  scope,
  signal,
  onCreated,
}: {
  session: RelaySession;
  scope: string;
  signal: AbortSignal;
  onCreated(id: string): void;
}) {
  const agents = useContext(AgentsContext);
  return (
    <section className={soloStyles.work} aria-label="Welcome">
      <SoloTitle channel={{ name: "Welcome" }} />
      <div className={styles.welcome}>
        <WelcomeIntro>
          {agents ? (
            <WelcomeSetup
              agents={agents}
              session={session}
              scope={scope}
              signal={signal}
              onCreated={onCreated}
            />
          ) : (
            <p role="status">
              Enable Agents in Settings to set up your assistant.
            </p>
          )}
        </WelcomeIntro>
      </div>
      <WelcomeComposer phase="connect" />
    </section>
  );
}

function WelcomeSetup({
  agents,
  session,
  scope,
  signal,
  onCreated,
}: {
  agents: Agents;
  session: RelaySession;
  scope: string;
  signal: AbortSignal;
  onCreated(id: string): void;
}) {
  const { types, snapshot } = useAgents(agents);
  // Only a type that can deliver the app-authored introduction can finish
  // Welcome. The rest stay out of onboarding rather than offering dead
  // controls; they remain available in Agents.
  const eligible = types.filter(
    (type) => type.startConversation && type.provider,
  );
  const later = types
    .filter((entry) => !eligible.includes(entry))
    .map((entry) => entry.title);

  const { receipt, error: storedError } = useWelcomeReceipt(scope);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recoveredAgent, setRecoveredAgent] = useState("");
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function start(selected: RegisteredAgentType) {
    if (!selected || busy || storedError) return;
    if (receipt && receipt.type !== selected.key) return;
    setBusy(true);
    setError("");
    try {
      signal.throwIfAborted();
      const ready = await prepareWelcome(
        session,
        agents,
        scope,
        selected.key,
        selected.defaults().config,
        signal,
      );
      if (active.current && !signal.aborted) onCreated(ready.channelId);
    } catch (reason) {
      if (active.current && !signal.aborted) setError(errorText(reason));
    } finally {
      if (active.current) setBusy(false);
    }
  }
  if (storedError) return <p role="alert">{storedError}</p>;
  if (snapshot.status === "loading")
    return <p role="status">Loading your agents…</p>;
  return (
    <div className={`${styles.setup} ${styles.stepCard}`}>
      <div className={styles.cardHeader}>
        <InlineHeader title="Connect your AI provider" level={2} />
      </div>
      {!eligible.length && (
        <p className={styles.cardNotice} role="status">
          No AI provider on this device can set up your agent yet. Turn on an
          agent plugin in Settings → Plugins to continue.
        </p>
      )}
      <div className={styles.providerChoices}>
        {eligible.map((entry) => {
          const provider = entry.provider;
          if (!provider) return null;
          const Icon = entry.icon;
          return (
            <ContributionBoundary
              key={contributionKey(entry)}
              fallback={
                <PreferenceRow
                  icon={Icon ? <Icon size={24} /> : undefined}
                  title={entry.title}
                  subtitle="Its setup controls are unavailable."
                />
              }
            >
              <ReadyProvider
                type={entry}
                provider={provider}
                busy={busy}
                disabled={!!receipt && receipt.type !== entry.key}
                resume={!!receipt}
                onContinue={() => void start(entry)}
              />
            </ContributionBoundary>
          );
        })}
      </div>
      {receipt?.creatingAgent && !receipt.agent && (
        <div className={styles.recovery}>
          <p role="alert">
            Setup was interrupted while creating the agent. Choose the exact
            agent from Agents to resume without making a duplicate.
          </p>
          <Select
            label="Resume with agent"
            value={recoveredAgent}
            onValueChange={setRecoveredAgent}
            groups={[
              {
                label: "Your agents",
                options: snapshot.agents
                  .filter(
                    (item) =>
                      item.place === "here" &&
                      item.owner === session.viewer &&
                      item.type === receipt.type,
                  )
                  .map((item) => ({
                    value: item.pubkey,
                    label: `${item.name} · ${publicKeyLabels(snapshot.agents.map((entry) => entry.pubkey)).get(item.pubkey)}`,
                  })),
              },
            ]}
          />
          <Button
            disabled={!recoveredAgent || busy}
            onClick={() =>
              saveWelcome(scope, { ...receipt, agent: recoveredAgent })
            }
          >
            Use this agent
          </Button>
        </div>
      )}
      {error && (
        <p className={styles.cardNotice} role="alert">
          {error}
        </p>
      )}
      {snapshot.status === "error" && (
        <p className={styles.cardNotice} role="alert">
          {snapshot.error}
        </p>
      )}
      {!!later.length && (
        <p className={`${styles.cardNotice} text-body-sm text-subtle`}>
          {`${new Intl.ListFormat(undefined, { type: "conjunction" }).format(later)} agents can be added in Agents later.`}
        </p>
      )}
    </div>
  );
}

function ReadyProvider({
  type,
  provider,
  busy,
  disabled,
  resume,
  onContinue,
}: {
  type: RegisteredAgentType;
  provider: NonNullable<RegisteredAgentType["provider"]>;
  busy: boolean;
  disabled: boolean;
  resume: boolean;
  onContinue(): void;
}) {
  const health = useSyncExternalStore(
    provider.subscribe,
    provider.snapshot,
    provider.snapshot,
  );
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    try {
      void Promise.resolve(provider.check()).catch((reason) =>
        setError(errorText(reason)),
      );
    } catch (reason) {
      setError(errorText(reason));
    }
  }, [provider]);
  const Icon = type.icon;
  const ready = health.readiness === "ready";
  const checking = health.readiness === "checking";
  const working = !!health.blocking;
  // The provider owns its own recovery copy; onboarding states the next step
  // in its words rather than inventing one.
  const setupLabel = working
    ? `Show ${type.title} setup`
    : (health.attentionLabel ?? `Set up ${type.title}`);
  const setUp = () => {
    if (!working && provider.attentionAction) {
      try {
        provider.attentionAction();
        return;
      } catch {
        // Fall back to the provider's own recovery controls.
      }
    }
    setOpen(true);
  };
  return (
    <>
      <PreferenceRow
        icon={Icon ? <Icon size={24} /> : undefined}
        title={type.title}
        subtitle={
          error ||
          (working
            ? "Setting up…"
            : ready
              ? "Connected"
              : checking
                ? "Checking…"
                : undefined)
        }
        trailing={
          <>
            {ready && (
              <IconButton
                aria-label={`Configure ${type.title}`}
                disabled={busy || disabled}
                onClick={() => setOpen(true)}
                icon={<GearIcon size={18} />}
              />
            )}
            <Button
              ref={trigger}
              disabled={busy || disabled || checking}
              loading={busy && !disabled}
              variant="prominent"
              aria-busy={checking || undefined}
              onClick={() => (ready ? onContinue() : setUp())}
            >
              {checking && (
                <CircleNotchIcon
                  size={17}
                  aria-hidden="true"
                  className="motion-safe:animate-spin"
                />
              )}
              {checking
                ? "Checking…"
                : ready
                  ? resume
                    ? "Resume welcome"
                    : "Continue"
                  : setupLabel}
            </Button>
          </>
        }
      />
      {open && (
        <ProviderDialog
          type={type}
          finalFocus={trigger}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** Only a real saved Welcome chat mounts this. Actual history uses ChannelTimeline. */
/** Saves the name and avatar the owner submits on the Welcome agent's
 * profile pattern, then hands the chat to the saved-welcome greeting.
 * Outside an unfinished Welcome chat, patterns get no profile save. */
export function useWelcomeProfile({
  agents,
  scope,
  receipt,
  signal,
  onSaved,
}: {
  agents: Agents | undefined;
  scope: string;
  receipt: WelcomeReceipt | undefined;
  signal: AbortSignal | undefined;
  onSaved(): void;
}): InlineUiHostValue {
  return useMemo(
    () =>
      !agents || !receipt || receipt.complete
        ? {}
        : {
            async saveProfile(agent, { name, picture }) {
              if (agent !== receipt.agent)
                throw new Error("Welcome changed. Reopen the current setup.");
              if (name.toLocaleLowerCase() === "welcome")
                throw new Error("Choose a name other than Welcome.");
              signal?.throwIfAborted();
              await agents.save(agent, { name, picture });
              signal?.throwIfAborted();
              if (!setDefaultAgent(scope, agent))
                throw new Error(
                  "The default agent could not be saved on this device.",
                );
              // Solo turns start from mentions: the chat's composer tags this agent.
              writeView(
                scope,
                `draft:${receipt.channelId}`,
                followupDraft([{ pubkey: agent, name }]),
              );
              saveWelcome(scope, {
                ...receipt,
                complete: true,
                greeting: "pending",
              });
              onSaved();
            },
          },
    [agents, scope, receipt, signal, onSaved],
  );
}

export function WelcomeControls({
  agents,
  session,
  scope,
  signal,
  receipt,
  openProfile,
  onSend,
}: {
  agents: Agents;
  session: RelaySession;
  scope: string;
  signal: AbortSignal;
  receipt: WelcomeReceipt;
  openProfile?: ((target: string) => boolean) | undefined;
  onSend?: ((id: string) => void) | undefined;
}) {
  const found = useAgent(agents, receipt.agent ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const starting = useRef(false);
  const window = useSyncExternalStore(
    (notify) => session.channels.subscribeWindow(receipt.channelId, notify),
    () => session.channels.window(receipt.channelId),
  );
  useEffect(() => {
    if (receipt.replyId || !receipt.agent) return;
    const reply = window.rows.find(
      (row) =>
        receipt.kickoffAt !== undefined &&
        row.createdAt >= receipt.kickoffAt &&
        !row.membership &&
        !row.threadRootId &&
        row.authorId === receipt.agent,
    );
    if (reply)
      saveWelcome(scope, {
        ...receipt,
        kickoff: "observed",
        replyId: reply.id,
      });
  }, [window, receipt, scope]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const kickoff = useCallback(
    async (retry = false) => {
      if (!receipt.agent || starting.current || (receipt.kickoff && !retry))
        return;
      const current = readWelcome(scope);
      if (current?.kickoff && !retry) return;
      starting.current = true;
      setBusy(true);
      setError("");
      try {
        signal.throwIfAborted();
        const attempted = {
          ...receipt,
          kickoff: "attempted" as const,
          kickoffAt: receipt.kickoffAt ?? Math.floor(Date.now() / 1000),
        };
        saveWelcome(scope, attempted);
        const observed = await observedWelcome(session, attempted, signal);
        if (observed)
          saveWelcome(scope, {
            ...attempted,
            kickoff: "observed",
            replyId: observed.id,
          });
        else {
          saveWelcome(scope, attempted);
          const reply = await agents.welcome(
            receipt.agent,
            receipt.channelId,
            signal,
          );
          signal.throwIfAborted();
          saveWelcome(scope, {
            ...attempted,
            kickoff: "observed",
            replyId: reply.id,
          });
        }
        session.channels.ensure(receipt.channelId);
      } catch (reason) {
        if (mounted.current && !signal.aborted) setError(errorText(reason));
      } finally {
        starting.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [agents, session, scope, signal, receipt],
  );
  // Continue created this exact saved chat. The durable attempted marker is
  // written before any await; remount/reconnect never automatically asks twice.
  useEffect(() => {
    if (!receipt.kickoff) void kickoff();
  }, [receipt.kickoff, kickoff]);
  if (!found)
    return (
      <p role="status">
        The Welcome agent is unavailable. Open Agents to check it.
      </p>
    );
  if (receipt.complete && receipt.greeting)
    return (
      <WelcomeNextSteps
        agents={agents}
        session={session}
        scope={scope}
        receipt={receipt}
        signal={signal}
        openProfile={openProfile}
        onSend={onSend}
      />
    );
  if (receipt.complete)
    return (
      <div className={styles.setupControls} role="status">
        <div className={`${styles.step} ${styles.savedAgent}`}>
          <PreferenceRow
            icon={
              <Avatar
                src={found.agent.picture}
                shape="squircle"
                alt=""
                fallback={found.agent.name}
              />
            }
            title={found.agent.name}
            subtitle="Your default agent for new Solo chats"
          />
        </div>
      </div>
    );
  return (
    <div className={styles.setupControls}>
      {!receipt.replyId || busy ? (
        <div className={styles.step}>
          <p className="text-message" role="status">
            {busy
              ? "Getting things ready…"
              : "Your welcome may still arrive. Check for it before trying again."}
          </p>
          {!busy && (
            <Button
              disabled={!found.type?.startConversation}
              onClick={() => void kickoff(true)}
            >
              Check and retry introduction
            </Button>
          )}
        </div>
      ) : null}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
