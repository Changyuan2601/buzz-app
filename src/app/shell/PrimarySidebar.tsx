import {
  Component,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { SidebarFrame } from "../../features/channel-navigation/SidebarFrame";
import { SidebarList } from "../../features/channel-navigation/SidebarList";
import { ResizableSidebar } from "../../features/channel-navigation/ResizableSidebar";
import { Button } from "../../shared/design-system/ui/Button";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { ChatsCircleIcon } from "../../shared/design-system/icons";
import type { RelayData } from "../../features/relay/service";
import type { Agents } from "../../features/agents/service";
import type { Navigation } from "../../features/navigation/controller";
import type { OpenTarget } from "../../features/navigation/targets";
import type { ContributionReader } from "../../features/conversation/contracts";
import type { ChatIcon } from "../../features/conversation/service";
import type {
  MessagesNavReader,
  RegisteredMessagesNavView,
} from "../../features/messages-nav/service";
import { useRelayConnection } from "../../features/relay/react";
import { readView, writeView } from "../../shared/view-state";
import { MessagesInventory } from "../../bundled/messages-nav/MessagesInventory";
import channelStyles from "../../bundled/channels/Channels.module.css";
import styles from "./PrimarySidebar.module.css";

type Props = {
  relay: RelayData;
  navigator: Navigation;
  agents?: Agents | undefined;
  chatIcons?: ContributionReader<ChatIcon> | undefined;
  /** Messages navigation views; while none is registered, the built-in Messages view. */
  views?: MessagesNavReader | undefined;
  target: OpenTarget;
  children: ReactNode;
};

const VIEW = "messages-nav";

/**
 * The shell's primary sidebar: page navigation and the messages navigation
 * views listed with it, above the selected view. Selecting a view changes only
 * this pane; the current conversation stays open beside it.
 */
export function PrimarySidebar(props: Props) {
  const connection = useRelayConnection(props.relay);
  const scope = connection.scope ?? "disconnected";
  const latest = useRef(props);
  latest.current = props;
  const [fallback] = useState(() => builtIn(latest));
  const reader = props.views ?? fallback;
  const registered = useSyncExternalStore(reader.subscribe, reader.snapshot);
  // Messages stays usable while its bundle is missing or not yet active.
  const views = registered.length ? registered : fallback.snapshot();
  return (
    <ScopedSidebar
      key={scope}
      scope={scope}
      views={views}
      target={props.target}
    >
      {props.children}
    </ScopedSidebar>
  );
}

function ScopedSidebar({
  scope,
  views,
  target,
  children,
}: {
  scope: string;
  views: readonly RegisteredMessagesNavView[];
  target: OpenTarget;
  children: ReactNode;
}) {
  const [chosen, setChosen] = useState(() => {
    const saved = readView<{ view?: unknown } | null>(scope, VIEW, null);
    return typeof saved?.view === "string" ? saved.view : undefined;
  });
  const active = views.find((view) => view.key === chosen) ?? views[0];
  // Views stay mounted once shown, so switching back keeps their state.
  const [visited, setVisited] = useState<ReadonlySet<string>>(
    () => new Set(active ? [active.key] : []),
  );
  if (active && !visited.has(active.key))
    setVisited(new Set([...visited, active.key]));
  const choose = (key: string) => {
    setChosen(key);
    writeView(scope, VIEW, { view: key });
  };
  // A page in the page navigation shows its own selection instead.
  const reading =
    target.kind === "conversation" ||
    (target.kind === "page" && target.pluginId === "buzz.channels");
  const header = (
    <div className={channelStyles.destinations}>
      <nav aria-label="Messages views" className={styles.views}>
        {views.map((view) => (
          <NavigationItem
            key={view.key}
            variant="row"
            label={view.title}
            title={view.title}
            selected={view.key === active?.key && reading}
            aria-pressed={view.key === active?.key}
            onClick={() => choose(view.key)}
            icon={
              <span className="shell-page-icon">
                {view.icon ?? <ChatsCircleIcon size={16} strokeWidth={2.5} />}
              </span>
            }
          />
        ))}
      </nav>
      {children}
    </div>
  );
  return (
    <ResizableSidebar scope={scope} className="shell-sidebar">
      <SidebarFrame label="Sidebar" header={header}>
        {views
          .filter((view) => visited.has(view.key))
          .map((view) => {
            const View = view.component;
            return (
              <div
                key={view.key}
                className={styles.view}
                hidden={view.key !== active?.key}
                data-messages-nav={view.key}
              >
                <ViewBoundary
                  fallback={
                    view.key === views[0]?.key
                      ? undefined
                      : () => choose(views[0]?.key ?? "")
                  }
                  fallbackTitle={views[0]?.title}
                >
                  <View target={target} />
                </ViewBoundary>
              </div>
            );
          })}
      </SidebarFrame>
    </ResizableSidebar>
  );
}

/** One view's failure leaves the shell and other views usable. */
class ViewBoundary extends Component<
  {
    /** Shows the first view, Messages, instead. */
    fallback?: (() => void) | undefined;
    fallbackTitle?: string | undefined;
    children: ReactNode;
  },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <SidebarList>
        <p role="alert">Conversations couldn’t open.</p>
        <Button onClick={() => this.setState({ failed: false })}>
          Retry sidebar
        </Button>
        {this.props.fallback && (
          <Button variant="ghost" onClick={this.props.fallback}>
            Show {this.props.fallbackTitle}
          </Button>
        )}
      </SidebarList>
    ) : (
      this.props.children
    );
  }
}

/** The bundled Messages view, for shells mounted without the plugin runtime. */
function builtIn(latest: { readonly current: Props }): MessagesNavReader {
  const views: readonly RegisteredMessagesNavView[] = [
    {
      id: "messages",
      key: "buzz.messages-nav/messages",
      pluginId: "buzz.messages-nav",
      revision: "built-in",
      title: "Messages",
      order: -100,
      component: ({ target }) => (
        <MessagesInventory
          relay={latest.current.relay}
          navigator={latest.current.navigator}
          agents={latest.current.agents}
          chatIcons={latest.current.chatIcons}
          target={target}
        />
      ),
    },
  ];
  return { snapshot: () => views, subscribe: () => () => {} };
}
