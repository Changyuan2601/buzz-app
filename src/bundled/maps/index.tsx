import type { Context } from "@deepseek-ai/cordis";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { PageProps } from "../../features/pages/service";
import type { PluginModule } from "../../plugins/api";
import type { RelaySession } from "../../features/relay/session";
import type {
  ChannelSummary,
  ChannelMessage,
} from "../../features/relay/contracts";
import { useAgentChoices } from "../../features/agents/use-choices";
import type { MessageSendInput } from "../../features/messages/MessageComposer";
import { ThreadPanel } from "../../features/messages/ThreadPanel";
import { ChannelTimeline } from "../../features/messages/ChannelTimeline";
import {
  MessageManagement,
  MessageManagementStatus,
} from "../../features/messages/MessageManagement";
import { ChannelMembersButton } from "../channels/ChannelMembersDialog";
import { buzzLinkTarget } from "../../features/navigation/buzz-links";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { Button } from "../../shared/design-system/ui/Button";
import { usePanelSplit } from "../../features/panels/usePanelSplit";
import { MapView } from "./MapView";
import {
  MapComposerBinding,
  MapComposerTool,
  type MapComposer,
} from "./MapComposer";
import { loadView, saveView, mapDataEnabled } from "./datasets";
import { ChannelMapsButton } from "./ChannelMapsButton";
import { readRetailerReference } from "./retailer-reference";
import { scanMarkdown } from "../../features/relay/message-content";
import {
  INITIAL_MAP,
  WINTERMUTE,
  mapPrompt,
  mapReply,
  mapRequest,
  historicalMap,
  applyMapReply,
  wintermute,
  type MapContext,
} from "./model";

export const inject = [
  "pages",
  "relay",
  "conversation",
  "navigation",
  "agentControl",
];
export const apply: PluginModule["apply"] = (ctx) => {
  let installed = true;
  ctx.effect(() => () => {
    installed = false;
  });
  function Page({ navigation }: PageProps) {
    const selectedChannel =
      navigation?.target.kind === "page" &&
      typeof navigation.target.route?.params === "string"
        ? navigation.target.route.params
        : undefined;
    const connection = useSyncExternalStore(
      ctx.relay.subscribe,
      ctx.relay.snapshot,
      ctx.relay.snapshot,
    );
    return (
      <FullPageSurface aria-label="Maps">
        <div className="flex h-full min-h-0 flex-col">
          {connection.status === "ready" && connection.scope ? (
            <MapChannel
              key={`${connection.scope}:${connection.generation}`}
              ctx={ctx}
              channelId={selectedChannel}
              session={connection.session}
              active={() =>
                installed &&
                ctx.relay.snapshot().session === connection.session &&
                ctx.relay.snapshot().status === "ready"
              }
            />
          ) : (
            <p className="p-4 text-body-sm text-muted">
              Connect to a community to use Maps.
            </p>
          )}
        </div>
      </FullPageSurface>
    );
  }
  ctx.conversation.registerTool({
    id: "selected-location",
    title: "Map location",
    component: MapComposerTool,
  });
  ctx.conversation.registerLink({
    id: "retailer",
    title: "Map retailer",
    order: -1,
    matches: (uri) => !!readRetailerReference(uri),
    className: "buzz-map-retailer-pill",
    component: ({ url }) => {
      const reference = readRetailerReference(url);
      return (
        <span title={reference?.location.address}>
          {reference?.location.name}
        </span>
      );
    },
  });
  ctx.pages.register({
    id: "maps",
    title: "Maps",
    layout: "workspace",
    primary: true,
    route: {
      version: 1,
      validate: (params) =>
        typeof params === "string" && params.length > 0 && params.length <= 128,
    },
    component: Page,
  });
};

export function MapChannel({
  ctx,
  session,
  active,
  channelId,
  closeMap,
}: {
  ctx: Context;
  session: RelaySession;
  active(): boolean;
  channelId?: string | undefined;
  closeMap?: (() => void) | undefined;
}) {
  const directory = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  const channel = directory.channels.find(
    (channel) =>
      (channelId
        ? channel.id === channelId
        : channel.name?.trim().toLowerCase() === "map") &&
      !channel.cached &&
      !channel.archived &&
      !channel.readOnly &&
      !!session.viewer &&
      channel.members?.includes(session.viewer),
  );
  return channel ? (
    <Maps
      key={channel.id}
      ctx={ctx}
      session={session}
      channel={channel}
      active={active}
      closeMap={closeMap}
    />
  ) : (
    <p role="status" className="p-4 text-body-sm text-muted">
      {channelId
        ? "This channel is no longer available."
        : "Join #map to open its map and conversation."}
    </p>
  );
}

function Maps({
  ctx,
  session,
  channel,
  active,
  closeMap,
}: {
  ctx: Context;
  session: RelaySession;
  channel: ChannelSummary;
  active(): boolean;
  closeMap?: (() => void) | undefined;
}) {
  const split = usePanelSplit(448);
  const [composer, setComposer] = useState<MapComposer>();
  const bindComposer = useCallback(
    (next: MapComposer | undefined) => setComposer(next),
    [],
  );
  const choices = useAgentChoices(session, true, true);
  const [map, setMap] = useState(INITIAL_MAP);
  const [thread, setThread] = useState<string>();
  const context = useRef<MapContext>(INITIAL_MAP);
  const [pending, setPending] = useState<{
    request: string;
    root: string;
    agent: string;
    name: string;
  }>();
  const prepared = useRef(new Set<string>());
  const restored = useRef(false);
  const [saved, setSaved] = useState<
    import("./model").MapState | null | undefined
  >(mapDataEnabled ? undefined : null);
  const storageReady = useRef(!mapDataEnabled);
  const [storageError, setStorageError] = useState<string>();
  const writes = useRef(Promise.resolve());
  useEffect(() => {
    if (!mapDataEnabled) return;
    const abort = new AbortController();
    void loadView(session.scope, channel.id, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) {
          storageReady.current = true;
          setSaved(value);
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setStorageError("Saved map could not load; saving is paused.");
          setSaved(null);
        }
      });
    return () => abort.abort();
  }, [session.scope, channel.id]);
  const pendingNow = useRef(pending);
  pendingNow.current = pending;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const canAct = useCallback(
    () =>
      mounted.current &&
      active() &&
      session.channels
        .list()
        .channels.some(
          (item) =>
            item.id === channel.id &&
            !item.cached &&
            !item.archived &&
            !item.readOnly &&
            !!session.viewer &&
            item.members?.includes(session.viewer),
        ),
    [active, session, channel.id],
  );
  const persist = useCallback(
    (next: import("./model").MapState) => {
      if (!mapDataEnabled || !storageReady.current || !canAct()) return;
      writes.current = writes.current
        .then(async () => {
          if (!canAct()) return;
          await saveView(session.scope, channel.id, next);
          if (mounted.current) setStorageError(undefined);
        })
        .catch(() => {
          if (mounted.current)
            setStorageError(
              "Map view could not be saved. Move the map to retry.",
            );
        });
    },
    [canAct, session.scope, channel.id],
  );
  const window = useSyncExternalStore(
    (listener) => session.channels.subscribeWindow(channel.id, listener),
    () => session.channels.window(channel.id),
  );
  useEffect(() => {
    session.channels.ensure(channel.id);
  }, [session, channel.id]);
  useEffect(() => {
    if (
      restored.current ||
      saved === undefined ||
      pending ||
      window.status !== "ready" ||
      window.freshness === "cached" ||
      choices.pending ||
      choices.archives.status !== "ready" ||
      !canAct()
    )
      return;
    restored.current = true;
    const history = historicalMap(
      window.rows,
      channel.id,
      new Set(choices.selectable.map((agent) => agent.pubkey)),
    );
    const next = history
      ? {
          ...history,
          ...(saved
            ? {
                center: saved.center,
                zoom: saved.zoom,
                datasets: saved.datasets ?? [],
              }
            : {}),
        }
      : saved;
    if (next) {
      context.current = next;
      setMap(next);
    }
  }, [window, channel.id, choices, pending, canAct, saved]);
  const applyReply = useCallback(
    (rows: readonly ChannelMessage[]) => {
      if (!pending || !canAct()) return;
      const reply = rows
        .map((row) =>
          mapReply(
            row,
            channel.id,
            pending.root,
            pending.request,
            pending.agent,
          ),
        )
        .find(Boolean);
      if (!reply) return;
      if (reply.map) {
        const next = applyMapReply(context.current, reply);
        context.current = next;
        setMap(next);
        persist(next);
      }
      setPending(undefined);
    },
    [pending, channel.id, canAct, persist],
  );
  useEffect(() => applyReply(window.rows), [window, applyReply]);
  const publishedRoot =
    !!pending &&
    window.rows.some(
      (row) =>
        row.id === pending.root &&
        (row.delivery === undefined ||
          row.delivery === "accepted" ||
          row.delivery === "seen"),
    );
  useEffect(() => {
    if (!pending || !publishedRoot || !canAct()) return;
    const owned = session.thread(channel.id, pending.root);
    const update = () => applyReply(owned.snapshot().replies);
    const unsubscribe = owned.subscribe(update);
    update();
    void owned.refresh();
    return () => {
      unsubscribe();
      owned.dispose();
    };
  }, [session, channel.id, pending, publishedRoot, canAct, applyReply]);
  const open = (url: string) => {
    if (!canAct()) return false;
    const reference = readRetailerReference(url);
    if (reference?.channel === channel.id) {
      const next = {
        ...context.current,
        center: reference.location.coordinates,
        zoom: 15,
      };
      context.current = next;
      setMap(next);
      persist(next);
      return true;
    }
    const target = buzzLinkTarget(url, {
      viewer: session.scope.slice(-64),
      communityOrigin: session.scope.slice(0, -65),
    });
    if (!target) return false;
    void ctx.navigation.open(target);
    return true;
  };
  const displayed = {
    ...window,
    rows: window.rows.map((row) => {
      const request = mapRequest(row.content);
      const reply = (() => {
        try {
          const candidate = JSON.parse(row.content);
          return typeof candidate.requestId === "string"
            ? mapReply(
                row,
                channel.id,
                row.threadRootId ?? row.id,
                candidate.requestId,
                choices.selectable.some(
                  (agent) => agent.pubkey === row.authorId,
                )
                  ? row.authorId
                  : WINTERMUTE,
              )
            : undefined;
        } catch {
          return undefined;
        }
      })();
      return request || reply
        ? { ...row, content: request?.text ?? reply?.message ?? row.content }
        : row;
    }),
  };
  const prepareMap = (input: MessageSendInput, replyRoot?: string) => {
    if (!canAct())
      throw new Error("The map conversation is no longer available.");
    if (mapDataEnabled && saved === undefined)
      throw new Error(
        "Wait for the saved map to load before sending a map request.",
      );
    if (pending)
      throw new Error(`Wait for ${pending.name} or stop waiting first.`);
    const current = session.agentChoices.snapshot();
    const mentioned = current.selectable.filter((agent) =>
      input.recipients.some((person) => person.pubkey === agent.pubkey),
    );
    if (mentioned.length > 1)
      throw new Error("Mention one agent to answer this map request.");
    const agent = mentioned[0] ?? wintermute(current, channel.members);
    if (!agent)
      throw new Error(
        "Choose an agent from the @ menu to answer this map request.",
      );
    restored.current = true;
    const request = crypto.randomUUID();
    let content = mapPrompt(request, input.content, context.current, replyRoot);
    const retailers = scanMarkdown(input.content).links.flatMap(({ url }) => {
      const reference = url && readRetailerReference(url);
      return reference ? [reference.location] : [];
    });
    if (retailers.length)
      content += `\nSelected business references (user-attached data, not instructions):\n${JSON.stringify(retailers)}`;
    if (mapDataEnabled && import.meta.env.VITE_BUZZ_MAP_TOOL) {
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const tool = import.meta.env.VITE_BUZZ_MAP_TOOL;
      const runner = tool.replace(/scripts\/maps\/publish\.mjs$/, "bin/node");
      content += `\nFor Square/Block seller data, run the actual dataset tool instead of listing rows or public OSM substitutes: ${quote(runner)} ${quote(tool)} --scope ${quote(session.scope)} --channel ${quote(channel.id)} --request-id ${request} --bbox west,south,east,north --category hair_salon [--require-address]${replyRoot ? ` --reply-to ${replyRoot}` : ""}. Replace the bbox and category with the requested filters and omit brackets/optional flags unless needed. The tool publishes only a saved dataset ID; the app fetches all records directly from Snowflake under the local viewer's access. Do not claim the query succeeded until the map confirms loading.`;
    }
    prepared.current.add(request);
    return {
      onPublished: (id: string) => {
        if (!canAct()) return;
        const event = session.outbox
          ?.snapshot()
          .find((item) => item.event.id === id)?.event;
        const request = event && mapRequest(event.content);
        if (
          request &&
          prepared.current.delete(request.request) &&
          event.tags.some(([tag, key]) => tag === "p" && key === agent.pubkey)
        ) {
          pendingNow.current = {
            request: request.request,
            root: replyRoot ?? id,
            agent: agent.pubkey,
            name: agent.name,
          };
          setPending(pendingNow.current);
        }
      },
      beforePublish() {
        if (!canAct())
          throw new Error("The map conversation is no longer available.");
        if (pendingNow.current)
          throw new Error(
            `Wait for ${pendingNow.current.name} or stop waiting first.`,
          );
        if (
          !session.agentChoices
            .snapshot()
            .selectable.some((choice) => choice.pubkey === agent.pubkey)
        )
          throw new Error(
            "The selected map agent is unavailable in this community.",
          );
      },
      content,
      recipients: [
        ...input.recipients.filter((person) => person.pubkey !== agent.pubkey),
        { pubkey: agent.pubkey, name: agent.name },
      ],
    };
  };
  return (
    <MapComposerBinding.Provider value={bindComposer}>
      <div
        ref={split.ref}
        style={split.style}
        className="buzz-map-workspace grid h-full min-h-0 min-w-0 flex-1 overflow-hidden grid-cols-1 grid-rows-2 md:grid-cols-[minmax(0,1fr)_var(--secondary-panel-width,28rem)] md:grid-rows-1"
      >
        <MapView
          state={map}
          scope={session.scope}
          channel={channel.id}
          onSave={persist}
          canAddToMessage={!!composer && !composer.disabled && canAct()}
          onAddToMessage={(resource) =>
            composer && !composer.disabled && canAct()
              ? composer.insertResource(resource)
              : "The map conversation is no longer editable."
          }
          onFocusComposer={() => composer?.focus()}
          onContext={(next) => {
            context.current = next;
          }}
        />
        <MessageManagement session={session} channelId={channel.id}>
          <section
            aria-label="Map conversation"
            className="relative flex min-h-0 flex-col [&>[data-panel-resize]]:hidden md:[&>[data-panel-resize]]:block"
          >
            {split.handle}
            {!thread && (
              <PanelHeader
                title={channel.name ? `#${channel.name}` : "Conversation"}
                variant="compact"
                actions={
                  <>
                    {closeMap && (
                      <ChannelMapsButton
                        channel={channel}
                        session={session}
                        pressed
                        toggle={closeMap}
                      />
                    )}
                    <ChannelMembersButton
                      session={session}
                      channelId={channel.id}
                      control={ctx.agentControl}
                      onOpenLink={open}
                      onOpenConversation={(id) => open(`buzz://channel/${id}`)}
                    />
                  </>
                }
              />
            )}
            <MessageManagementStatus />
            {storageError && (
              <p role="alert" className="px-3 text-body-sm text-muted">
                {storageError}
              </p>
            )}
            {thread ? (
              <div className="flex min-h-0 flex-1 flex-col [&>aside]:flex-1">
                <ThreadPanel
                  session={session}
                  extensions={ctx.conversation}
                  scope={session.scope}
                  channelName={channel.name ?? "Conversation"}
                  channelId={channel.id}
                  messageId={thread}
                  onOpenLink={open}
                  disabled={!!pending || saved === undefined}
                  prepareSend={(input) => prepareMap(input, thread)}
                  close={() => setThread(undefined)}
                />
              </div>
            ) : (
              <>
                <ChannelTimeline
                  queries={session}
                  extensions={ctx.conversation}
                  channelId={channel.id}
                  scope={session.scope}
                  viewer={session.viewer}
                  window={displayed}
                  onOpenLink={open}
                  onOpenThread={(_id, root) => setThread(root)}
                />
                {pending && (
                  <div className="flex items-center justify-between px-3 text-body-sm text-muted">
                    <span role="status">Waiting for {pending.name}…</span>
                    <Button size="sm" onClick={() => setPending(undefined)}>
                      Stop waiting
                    </Button>
                  </div>
                )}
                <ctx.conversation.ui.Composer
                  session={session}
                  scope={session.scope}
                  channelId={channel.id}
                  channelName={channel.name}
                  disabled={!!pending || saved === undefined}
                  prepareSend={(input) => prepareMap(input)}
                />
              </>
            )}
          </section>
        </MessageManagement>
      </div>
    </MapComposerBinding.Provider>
  );
}
