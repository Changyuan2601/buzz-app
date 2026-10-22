import { useState } from "react";
import { useAgentChoices } from "../../features/agents/use-choices";
import {
  ConversationChannel,
  ConversationComposer,
} from "../../features/conversation/Conversation";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import { messageViewKey } from "../../features/messages/view-key";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { SoloDraft } from "../../features/solo/SoloDraft";
import { SoloColumn } from "../../features/solo/SoloPresentation";
import { BestieIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { ChannelBody } from "../channels/ChannelBody";
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
      <FullPageSurface aria-label="Bestie">
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
                  ? "Your Bestie opens once this community is connected."
                  : (connection.error ??
                    "Choose a community to meet your Bestie.")
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
  const chosen = useBestie(scope);
  // The same evidence the composer's agent roster reads, with archive evidence:
  // this page offers agents to choose, so a hidden one must not be offered.
  const choices = useAgentChoices(session, true, true);
  const channels = useChannelList(session.channels);
  // A chat this page just started, until the relay's metadata names its agent.
  const [started, setStarted] = useState<string>();
  const community = scope.slice(0, -(1 + (session.viewer?.length ?? 64)));
  const state = bestieState({
    chosen,
    choices,
    channels,
    viewer: session.viewer,
    started,
  });
  const bestie = "bestie" in state ? state.bestie : undefined;
  const agents = "agents" in state ? state.agents : [];
  const choose = (agent: BestieAgent) => {
    setStarted(undefined);
    if (!chooseBestie(scope, agent.pubkey))
      notify("This device couldn’t save your choice. Try again.", "error");
  };
  const header = (
    <PanelHeader
      title={
        <PanelHeaderLabel
          title={bestie ? bestieName(bestie) : "Bestie"}
          icon={
            bestie ? (
              <BestiePortrait agent={bestie} community={community} />
            ) : (
              <BestieIcon size="1rem" />
            )
          }
        />
      }
      actions={
        bestie && (
          <BestieChoice
            agents={agents}
            current={bestie}
            community={community}
            align="end"
            trigger={<Button>Change</Button>}
            onChoose={choose}
          />
        )
      }
    />
  );
  if (state.kind === "chat")
    return (
      <Frame header={header}>
        <BestieConversation
          key={messageViewKey(session, scope, state.channel.id)}
          session={session}
          scope={scope}
          host={host}
          extensions={extensions}
          channel={state.channel}
          bestie={bestieName(state.bestie)}
        />
      </Frame>
    );
  if (state.kind === "start")
    return (
      <Frame header={header}>
        <SoloColumn>
          <SoloDraft
            session={session}
            scope={scope}
            extensions={extensions}
            agent={state.bestie.pubkey}
            onStarted={setStarted}
            onFailed={(_id, message) => {
              setStarted(undefined);
              notify(message, "error");
            }}
          />
        </SoloColumn>
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
                  session.agentChoices.ensure(true, true);
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
            title="Meet your Bestie"
            description="Loading the agents you can choose from…"
          />
        ) : state.agents.length ? (
          <div className="flex min-h-full flex-col items-center justify-center gap-4 p-6 text-center">
            <img src="/bestie.png" alt="" className="size-20 object-contain" />
            <h3 className="text-heading">
              {state.missing
                ? `${state.missing} is no longer here`
                : "Meet your Bestie"}
            </h3>
            <p className="max-w-xs text-body-sm text-muted">
              {state.missing
                ? "Choose another agent to pick up with. Your chat with them stays in your chats."
                : "Choose one of your agents. They get a place of their own here, and you can ask them about anything in Buzz."}
            </p>
            {state.partial && (
              <p className="max-w-xs text-body-sm text-subtle" role="status">
                {state.partial}
              </p>
            )}
            <BestieChoice
              agents={state.agents}
              community={community}
              trigger={<Button variant="prominent">Choose your Bestie</Button>}
              onChoose={choose}
            />
          </div>
        ) : (
          <Notice
            title="No agents in this community"
            description="Your Bestie is an agent you already have. Add one in Agents, then choose them here."
          />
        )}
      </LoadingRegion>
    </Frame>
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
        <SoloColumn>
          <ChannelBody
            viewer={session.viewer}
            cached={!!channel.cached}
            activityLane={!channel.cached}
            revealMessageId={sent}
            marksRead
          />
          <ConversationComposer onSend={setSent} />
        </SoloColumn>
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
              title="Bestie"
              icon={<BestieIcon size="1rem" />}
            />
          }
        />
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
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
        icon={<BestieIcon />}
        title={title}
        description={description}
        action={action}
      />
    </div>
  );
}
