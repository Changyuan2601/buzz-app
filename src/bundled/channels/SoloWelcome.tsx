import { publicKeyLabels } from "../../shared/identity/public-key";
import {
  useContext,
  useCallback,
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
import { agentAvatars } from "../../features/agents/avatar-packs";
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
import { setDefaultAgent } from "../../features/solo/default-agent";
import { followupDraft } from "../../features/messages/mention-draft";
import { ProviderDialog } from "../agents/ProviderDialog";
import { SoloTitle } from "../../features/solo/SoloPresentation";
import {
  ContributionBoundary,
  contributionKey,
} from "../../features/conversation/ContributionBoundary";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Select } from "../../shared/design-system/ui/Select";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { WelcomeNextSteps } from "./WelcomeNextSteps";
import { WelcomeIntro, WelcomeComposer } from "./WelcomeIntro";
import { SurfaceButton } from "../../shared/design-system/ui/SurfaceButton";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
  PopoverTitle,
} from "../../shared/design-system/ui/Popover";
import {
  GearIcon,
  PencilSimpleIcon,
  ArrowsClockwiseIcon,
  CircleNotchIcon,
} from "../../shared/design-system/icons";
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
export function WelcomeControls({
  agents,
  session,
  scope,
  signal,
  receipt,
  onSaved,
  openProfile,
  onSend,
}: {
  agents: Agents;
  session: RelaySession;
  scope: string;
  signal: AbortSignal;
  receipt: WelcomeReceipt;
  onSaved(): void;
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
      ) : (
        <CustomizeAgent
          key={found.agent.pubkey}
          agent={found.agent}
          agents={agents}
          suggestNames={found.type?.suggestNames}
          scope={scope}
          receipt={receipt}
          signal={signal}
          onSaved={onSaved}
        />
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

function CustomizeAgent({
  agent,
  agents,
  suggestNames,
  scope,
  receipt,
  signal,
  onSaved,
}: {
  agent: NonNullable<ReturnType<Agents["find"]>>;
  agents: Agents;
  suggestNames: RegisteredAgentType["suggestNames"];
  scope: string;
  receipt: WelcomeReceipt;
  signal: AbortSignal;
  onSaved(): void;
}) {
  const [name, setName] = useState("");
  const validName =
    !!name.trim() && name.trim().toLocaleLowerCase() !== "welcome";
  const [picture, setPicture] = useState(
    () =>
      agent.picture ||
      agentAvatars[Math.floor(Math.random() * agentAvatars.length)]?.url ||
      "",
  );
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);
  const active = useRef(false);
  const generation = useRef(0);
  const request = useRef<AbortController | undefined>(undefined);
  const ideas = useRef<string[]>([]);
  const used = useRef(new Set<string>());
  const { snapshot } = useAgents(agents);
  const exclude = useRef<readonly string[]>([]);
  exclude.current = snapshot.agents.map((item) => item.name);
  const draft = useRef({ name, picture });
  draft.current = { name, picture };
  const shuffle = useCallback(
    async (initial = false) => {
      if (!suggestNames) return;
      const originalPicture = draft.current.picture;
      const version = ++generation.current;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      const lifetime = AbortSignal.any([signal, controller.signal]);
      setSuggesting(true);
      setError("");
      try {
        lifetime.throwIfAborted();
        const blocked = new Set(
          [...exclude.current, ...used.current, draft.current.name].map(
            (value) => value.trim().toLocaleLowerCase(),
          ),
        );
        let next = ideas.current.shift();
        while (next && blocked.has(next.toLocaleLowerCase()))
          next = ideas.current.shift();
        if (!next) {
          const names = await suggestNames(
            agent.config,
            [...blocked],
            lifetime,
          );
          lifetime.throwIfAborted();
          if (!active.current || version !== generation.current) return;
          ideas.current = names.filter(
            (value) => !blocked.has(value.toLocaleLowerCase()),
          );
          next = ideas.current.shift();
        }
        const currentNames = new Set(
          exclude.current.map((value) => value.trim().toLocaleLowerCase()),
        );
        while (next && currentNames.has(next.toLocaleLowerCase()))
          next = ideas.current.shift();
        if (!next)
          throw new Error(
            "No new name ideas came back. Try Shuffle again or enter your own.",
          );
        if (!active.current || version !== generation.current) return;
        if (initial && draft.current.name) return;
        used.current.add(next);
        const avatars = agentAvatars.filter(
          (item) => item.url !== draft.current.picture,
        );
        const avatar = avatars[Math.floor(Math.random() * avatars.length)];
        setName(next);
        if (avatar && draft.current.picture === originalPicture)
          setPicture(avatar.url);
      } catch (reason) {
        if (
          active.current &&
          version === generation.current &&
          !signal.aborted &&
          !controller.signal.aborted
        )
          setError(
            `Couldn't suggest a name. ${errorText(reason)} You can enter your own or try Shuffle again.`,
          );
      } finally {
        if (active.current && version === generation.current)
          setSuggesting(false);
      }
    },
    [agent.config, suggestNames, signal],
  );
  const initialShuffle = useRef(shuffle);
  useEffect(() => {
    active.current = true;
    nameField.current?.focus();
    void initialShuffle.current(true);
    return () => {
      active.current = false;
      generation.current++;
      request.current?.abort();
    };
  }, []);
  const selectedAvatar = agentAvatars.find((item) => item.url === picture);
  return (
    <form
      className={`${styles.customize} ${styles.stepCard}`}
      aria-label="Make this agent yours"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || !validName) return;
        generation.current++;
        request.current?.abort();
        setSuggesting(false);
        setBusy(true);
        setError("");
        try {
          signal.throwIfAborted();
          await agents.save(agent.pubkey, { name: name.trim(), picture });
          signal.throwIfAborted();
          if (!setDefaultAgent(scope, agent.pubkey))
            throw new Error(
              "The default agent could not be saved on this device.",
            );
          // Solo turns start from mentions: the chat's composer tags this agent.
          writeView(
            scope,
            `draft:${receipt.channelId}`,
            followupDraft([{ pubkey: agent.pubkey, name: name.trim() }]),
          );
          saveWelcome(scope, {
            ...receipt,
            complete: true,
            greeting: "pending",
          });
          onSaved();
        } catch (reason) {
          if (active.current && !signal.aborted) {
            setError(errorText(reason));
            setBusy(false);
          }
        }
      }}
    >
      <div className={styles.cardHeader}>
        <InlineHeader title="Make this agent yours" level={2} />
      </div>
      <div className={styles.cardBody}>
        <div className={styles.identity}>
          <PopoverRoot open={avatarOpen} onOpenChange={setAvatarOpen}>
            <PopoverTrigger
              render={
                <SurfaceButton
                  className={styles.avatar}
                  aria-label="Change avatar"
                  disabled={busy}
                />
              }
            >
              <Avatar
                size="fill"
                shape="squircle"
                src={selectedAvatar?.preview ?? picture}
                alt=""
                fallback={name || agent.name}
              />
              <span className={styles.editBadge}>
                <PencilSimpleIcon size={16} aria-hidden="true" />
              </span>
            </PopoverTrigger>
            <PopoverPopup size="wide">
              <PopoverTitle>Choose an avatar</PopoverTitle>
              <div className={styles.avatarGrid}>
                {agentAvatars.map((item) => (
                  <SurfaceButton
                    key={item.id}
                    aria-label={item.label}
                    aria-pressed={picture === item.url}
                    onClick={() => {
                      draft.current = { ...draft.current, picture: item.url };
                      setPicture(item.url);
                      setAvatarOpen(false);
                    }}
                  >
                    <Avatar
                      size="large"
                      shape="squircle"
                      src={item.preview}
                      alt=""
                      fallback={item.label}
                    />
                  </SurfaceButton>
                ))}
              </div>
            </PopoverPopup>
          </PopoverRoot>
          <Field
            label="Name"
            labelVisibility="hidden"
            error={
              name.trim().toLocaleLowerCase() === "welcome"
                ? "Choose a name other than Welcome."
                : undefined
            }
          >
            <Input
              ref={nameField}
              appearance="title"
              value={name}
              onChange={(event) => {
                generation.current++;
                request.current?.abort();
                setSuggesting(false);
                draft.current = { ...draft.current, name: event.target.value };
                setName(event.target.value);
              }}
              disabled={busy}
              required
              maxLength={64}
              placeholder={suggesting ? "Thinking of a name…" : "Choose a name"}
            />
          </Field>
        </div>
        <p className="text-body-sm text-subtle text-center">
          You can change this any time.
        </p>
      </div>
      <div className={styles.cardFooter}>
        <div className={styles.actions}>
          <Button
            disabled={busy || !suggestNames}
            loading={suggesting}
            variant="ghost"
            onClick={() => void shuffle()}
          >
            <ArrowsClockwiseIcon size={16} aria-hidden="true" />
            Shuffle
          </Button>
          <Button
            loading={busy}
            disabled={!validName}
            variant="prominent"
            type="submit"
          >
            Looks good
          </Button>
        </div>
        {error && <p role="alert">{error}</p>}
      </div>
    </form>
  );
}
