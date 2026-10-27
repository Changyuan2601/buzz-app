import { useContext, useSyncExternalStore, type ReactNode } from "react";
import { bestieChat } from "../../bundled/bestie/chat";
import {
  UnreadBadge,
  useUnreadState,
} from "../../bundled/channels/UnreadBadge";
import styles from "./BestieNavigation.module.css";
import channelStyles from "../../bundled/channels/Channels.module.css";
import type { RelaySession } from "../../features/relay/session";
import { useBestieAvatar } from "../../bundled/bestie/BestieChoice";
import { useBestie } from "../../bundled/bestie/chosen";
import { bestieName } from "../../bundled/bestie/state";
import { useAgentChoices } from "../../features/agents/use-choices";
import type { RegisteredPage } from "../../features/pages/service";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import { pagePresentation } from "./presentation";

import {
  BESTIE_PAGE,
  BestieNavigationContext,
  BestieConversationContext,
  type BestieMark,
} from "./bestie-context";

/** Shell decoration only: the legacy contribution key stays stable.
 * Observe the same selection and retained roster as the page without loading chats.
 * Connection/identity changes never remount the shell or its current content. */
export function BestieNavigationProvider({
  pages,
  relay,
  children,
}: {
  pages: readonly RegisteredPage[];
  relay: RelayData;
  children: ReactNode;
}) {
  const connection = useRelayConnection(relay);
  const { viewer, scope, session } = connection;
  const active =
    pages.some((page) => page.key === BESTIE_PAGE) &&
    connection.status === "ready" &&
    !!viewer &&
    !!scope?.endsWith(`:${viewer}`);
  const chosen = useBestie(scope ?? "");
  // A disabled plugin must not demand the lazy library or archive reads.
  const choices = useAgentChoices(session, active, active);
  const agent = active
    ? choices.selectable.find((item) => item.pubkey === chosen)
    : undefined;
  // Observe the existing list, never demand it just to decorate navigation.
  const channels = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  const channel = bestieChat(channels.channels, viewer, agent?.pubkey);
  const src = useBestieAvatar(
    agent,
    connection.origin ?? scope?.slice(0, -(1 + (viewer?.length ?? 64))),
  );
  const mark: BestieMark | undefined = agent
    ? {
        label: bestieName(agent),
        searchLabel: "Main agent",
        avatar: { src, shape: "squircle" },
      }
    : undefined;
  return (
    <BestieNavigationContext value={mark}>
      <BestieConversationContext
        value={channel ? { session, channelId: channel.id } : undefined}
      >
        {children}
      </BestieConversationContext>
    </BestieNavigationContext>
  );
}

/** Label emphasis reads the same DM evidence as the pip, never selection. */
export function BestieUnreadLabel({ label }: { label: string }) {
  const conversation = useContext(BestieConversationContext);
  return conversation ? <UnreadLabel {...conversation} label={label} /> : label;
}
function UnreadLabel({
  session,
  channelId,
  label,
}: {
  session: RelaySession;
  channelId: string;
  label: string;
}) {
  const { ordinary } = useUnreadState(session, channelId, true);
  return (
    <span className={styles.label} data-bestie-unread={ordinary || undefined}>
      {label}
    </span>
  );
}

/** The promoted DM keeps the same accessible unread/thread pip as a DM row. */
export function BestieUnreadBadge({ pageKey }: { pageKey: string }) {
  const conversation = useContext(BestieConversationContext);
  if (pageKey !== BESTIE_PAGE || !conversation) return null;
  return (
    <span className={channelStyles.indicatorStack} data-channel-indicators="">
      <span className={channelStyles.indicatorLayer}>
        <UnreadBadge
          session={conversation.session}
          channelId={conversation.channelId}
          dm
        />
      </span>
    </span>
  );
}

/** One presentation for sidebar and page search, without mutating registration. */
export function usePagePresentation() {
  const bestie = useContext(BestieNavigationContext);
  return (page: RegisteredPage) => ({
    ...pagePresentation(page),
    ...(page.key === BESTIE_PAGE ? bestie : undefined),
  });
}
