import { useEffect, useState } from "react";
import { useAgentChoices } from "../../features/agents/use-choices";
import {
  ConversationChannel,
  ConversationComposer,
  ConversationThread,
} from "../../features/conversation/Conversation";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import { messageViewKey } from "../../features/messages/view-key";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { useDefaultAgent } from "../../features/solo/default-agent";
import { SoloColumn } from "../../features/solo/SoloPresentation";
import {
  ArrowsLeftRightIcon,
  RobotIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { ChannelBody } from "../channels/ChannelBody";
import styles from "./Bestie.module.css";
import { BestieChoice, BestiePortrait } from "./BestieChoice";
import { chooseBestie, useBestie } from "./chosen";
import { bestieName, bestieState, type BestieAgent } from "./state";

/** One agent you chose, one continuing chat with them. The page never starts,
 * supervises or reports a runtime: a reply that does not come stays visible as
 * a conversation with no answer in it. */
export function BestiePage({
  relay,
  host,
  extensions,
}: {
  relay: RelayData;
  host: ConversationHostServices;
  extensions?: ConversationExtensions | undefined;
}) {
  const connection = useRelayConnection(relay);
  const { viewer, scope } = connection;
  const joined =
    connection.status === "ready" && viewer && scope?.endsWith(`:${viewer}`);
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Main agent">
        {joined && scope ? (
          <BestieView
            key={`${scope}:${connection.generation}`}
            session={connection.session}
            scope={scope}
            host={host}
            extensions={extensions}
          />
        ) : (
          <Frame>
            <Notice
              title={
                connection.status === "connecting"
                  ? "Connecting…"
                  : connection.status === "error"
                    ? "This community is unavailable"
                    : "No community selected"
              }
              description={
                connection.status === "connecting"
                  ? "Your main agent conversation opens once this community is connected."
                  : (connection.error ??
                    "Choose a community to chat with your main agent.")
              }
              action={
                connection.status === "error" ? (
                  <Button onClick={relay.retry}>Retry connection</Button>
                ) : undefined
              }
            />
          </Frame>
        )}
      </FullPageSurface>
    </div>
  );
}

function BestieView({
  session,
  scope,
  host,
  extensions,
}: {
  session: RelaySession;
  scope: string;
  host: ConversationHostServices;
  extensions?: ConversationExtensions | undefined;
}) {
  const notify = useToastNotification();
  useDefaultAgent(session, scope);
  const chosen = useBestie(scope);
  // The same evidence the composer's agent roster reads, with archive evidence:
  // this page offers agents to choose, so a hidden one must not be offered.
  const choices = useAgentChoices(session, true, true);
  const channels = useChannelList(session.channels);
  const community = scope.slice(0, -(1 + (session.viewer?.length ?? 64)));
  const state = bestieState({
    chosen,
    choices,
    channels,
    viewer: session.viewer,
  });
  const bestie = "bestie" in state ? state.bestie : undefined;
  const agents = "agents" in state ? state.agents : [];
  const choose = (agent: BestieAgent) => {
    if (
      !session.agentChoices
        .snapshot()
        .selectable.some((current) => current.pubkey === agent.pubkey)
    )
      return;
    if (!chooseBestie(scope, agent.pubkey))
      notify("This device couldn’t save your choice. Try again.", "error");
  };
  const header = (
    <PanelHeader
      title={
        <PanelHeaderLabel
          title={bestie ? bestieName(bestie) : "Main agent"}
          icon={
            bestie ? (
              <BestiePortrait agent={bestie} community={community} />
            ) : (
              <RobotIcon size="1rem" />
            )
          }
        />
      }
      actions={
        bestie &&
        agents.some((agent) => agent.pubkey !== bestie.pubkey) && (
          <BestieChoice
            agents={agents}
            current={bestie}
            community={community}
            align="end"
            trigger={
              <IconButton
                aria-label="Change main agent…"
                title="Change main agent…"
                icon={<ArrowsLeftRightIcon size="1rem" aria-hidden="true" />}
              />
            }
            onChoose={choose}
          />
        )
      }
    />
  );
  if (state.kind === "chat" || state.kind === "start")
    return (
      <Frame header={header}>
        <BestieDirectMessage
          key={state.bestie.pubkey}
          session={session}
          scope={scope}
          host={host}
          extensions={extensions}
          bestie={state.bestie}
          channel={state.kind === "chat" ? state.channel : undefined}
        />
      </Frame>
    );
  if (state.kind === "unavailable")
    return (
      <Frame header={header}>
        <Notice
          title={
            state.source === "agents"
              ? "Your agents are unavailable"
              : "Your chats are unavailable"
          }
          description={
            state.error ??
            (state.source === "agents"
              ? "Buzz couldn’t read the agents in this community."
              : "Buzz couldn’t read your chats, so this one can’t be opened.")
          }
          action={
            <Button
              onClick={() => {
                if (state.source === "agents")
                  void session.agentChoices.refresh();
                else if (session.channels.refreshList)
                  session.channels.refreshList();
                else session.channels.ensureList();
              }}
            >
              Try again
            </Button>
          }
        />
      </Frame>
    );
  return (
    <Frame header={header}>
      <LoadingRegion
        pending={state.kind === "loading"}
        label="Loading your agents…"
      >
        {state.kind === "loading" ? (
          <Notice
            title="Choose your main agent"
            description="Loading the agents you can choose from…"
          />
        ) : state.agents.length ? (
          <div className="flex min-h-full flex-col items-center justify-center gap-4 p-6 text-center">
            <RobotIcon size={48} aria-hidden="true" />
            <h3 className="text-heading">
              {state.missing
                ? `${state.missing} is no longer here`
                : "Choose your main agent"}
            </h3>
            <p className="max-w-xs text-body-sm text-muted">
              {state.missing
                ? "Choose another agent to pick up with. Your chat with them stays in your chats."
                : "Your main agent is pinned here and selected by default in new Solo chats. You can change it at any time."}
            </p>
            <BestieChoice
              agents={state.agents}
              community={community}
              trigger={<Button variant="prominent">Choose main agent</Button>}
              onChoose={choose}
            />
            {state.partial && (
              <div className="flex flex-col items-center gap-2">
                <p className="max-w-xs text-body-sm text-subtle" role="status">
                  {state.partial}
                </p>
                <Button onClick={() => void session.agentChoices.refresh()}>
                  Try again
                </Button>
              </div>
            )}
          </div>
        ) : (
          <Notice
            title="No eligible agents in this community"
            description="Add an agent to this community, then choose them here."
          />
        )}
      </LoadingRegion>
    </Frame>
  );
}

/** Opening is idempotent and membership-verified by the shared DM service.
 * A retired selection cannot expose its result or error under another agent. */
function BestieDirectMessage({
  session,
  scope,
  host,
  extensions,
  bestie,
  channel,
}: {
  session: RelaySession;
  scope: string;
  host: ConversationHostServices;
  extensions?: ConversationExtensions | undefined;
  bestie: BestieAgent;
  channel: ChannelSummary | undefined;
}) {
  const [attempt, retry] = useState(0);
  const [error, setError] = useState<string>();
  const ready = !!channel;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry deliberately starts a fresh open attempt.
  useEffect(() => {
    if (ready) return;
    const controller = new AbortController();
    setError(undefined);
    void (async () => {
      try {
        if (
          !session.agentChoices
            .snapshot()
            .selectable.some((agent) => agent.pubkey === bestie.pubkey)
        )
          throw new Error(
            "This agent is no longer available in this community.",
          );
        await session.directMessages.open([bestie.pubkey], controller.signal);
      } catch (reason) {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Buzz couldn’t open this conversation.",
          );
      }
    })();
    return () => controller.abort();
  }, [session, bestie.pubkey, ready, attempt]);
  if (channel)
    return (
      <BestieConversation
        key={messageViewKey(session, scope, channel.id)}
        session={session}
        scope={scope}
        host={host}
        extensions={extensions}
        channel={channel}
        bestie={bestieName(bestie)}
      />
    );
  return error ? (
    <Notice
      title="Couldn’t open this conversation"
      description={error}
      action={
        <Button onClick={() => retry((value) => value + 1)}>Try again</Button>
      }
    />
  ) : (
    <LoadingRegion
      pending
      label={`Opening your conversation with ${bestieName(bestie)}…`}
    >
      <Notice
        title="Opening your conversation…"
        description={`Connecting to your DM with ${bestieName(bestie)}.`}
      />
    </LoadingRegion>
  );
}

/** The chat itself: the shared conversation surface, in chat presentation.
 * Sending, delivery and recovery stay owned by the conversation feature. */
function BestieConversation({
  session,
  scope,
  host,
  extensions,
  channel,
  bestie,
}: {
  session: RelaySession;
  scope: string;
  host: ConversationHostServices;
  extensions?: ConversationExtensions | undefined;
  channel: ChannelSummary;
  bestie: string;
}) {
  const [sent, setSent] = useState<string>();
  const [thread, setThread] = useState<string>();
  const [composerFocus, focusComposer] = useState(0);
  return (
    <ConversationChannel
      session={session}
      scope={scope}
      extensions={extensions}
      host={host}
      channel={channel}
      channelName={channel.name || bestie}
      active
    >
      <section
        data-attachment-drop-zone=""
        className="flex min-h-0 flex-1 flex-col"
        aria-label={`Chat with ${bestie}`}
      >
        {thread ? (
          <ConversationThread
            messageId={thread}
            close={() => {
              setThread(undefined);
              focusComposer((value) => value + 1);
            }}
          />
        ) : (
          <SoloColumn>
            <ChannelBody
              viewer={session.viewer}
              cached={!!channel.cached}
              activityLane={!channel.cached}
              revealMessageId={sent}
              marksRead
              onOpenThread={(messageId) => setThread(messageId)}
            />
            <ConversationComposer
              label={`Message ${bestie}`}
              focusRequest={composerFocus}
              onSend={setSent}
            />
          </SoloColumn>
        )}
      </section>
    </ConversationChannel>
  );
}

function Frame({
  header,
  children,
}: {
  header?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {header ?? (
        <PanelHeader
          title={
            <PanelHeaderLabel
              title="Main agent"
              icon={<RobotIcon size="1rem" />}
            />
          }
        />
      )}
      <div
        className={`${styles.work} flex min-h-0 flex-1 flex-col overflow-auto`}
      >
        {children}
      </div>
    </div>
  );
}

function Notice({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center p-6">
      <EmptyState
        icon={<RobotIcon />}
        title={title}
        description={description}
        action={action}
      />
    </div>
  );
}
