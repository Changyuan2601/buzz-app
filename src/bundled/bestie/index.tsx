import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { BestieIcon } from "../../shared/design-system/icons";
import type { PluginModule } from "../../plugins/api";
import type { Navigation } from "../../features/navigation/controller";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { Button } from "../../shared/design-system/ui/Button";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import type {} from "../builderlab/service";
import { ChannelPreview } from "../inbox/ChannelPreview";
import { createRemoteBestie, type RemoteBestie } from "./setup";

export const inject = [
  "pages",
  "relay",
  "navigation",
  "agents",
  "conversation",
];
export const apply: PluginModule["apply"] = (ctx) => {
  let bestie: RemoteBestie | undefined;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const source = {
    snapshot: () => bestie,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  // Keep the page available while Builderlab is off or unconfigured. Cordis
  // owns the consumer's lifetime as the hosted type appears or disappears.
  ctx.inject(["builderlab"], (child) => {
    const current = createRemoteBestie(child.builderlab, ctx.agents, ctx.relay);
    bestie = current;
    notify();
    child.effect(() => () => {
      current.dispose();
      bestie = undefined;
      notify();
    });
  });
  ctx.effect(() => () => listeners.clear());
  ctx.pages.register({
    id: "bestie",
    title: "Bestie",
    layout: "workspace",
    primary: true,
    component: () => {
      const current = useSyncExternalStore(
        source.subscribe,
        source.snapshot,
        source.snapshot,
      );
      return (
        <BestiePage
          bestie={current}
          navigation={ctx.navigation}
          extensions={ctx.conversation}
        />
      );
    },
  });
};

export function BestiePage({
  bestie,
  navigation,
  extensions,
}: {
  bestie?: RemoteBestie | undefined;
  navigation: Navigation;
  extensions?: ConversationExtensions | undefined;
}) {
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Bestie">
        <div className="flex h-full min-h-0 flex-col">
          <PanelHeader
            title={
              <PanelHeaderLabel
                title="Bestie"
                icon={<BestieIcon size="1rem" />}
              />
            }
          />
          {bestie ? (
            <Setup bestie={bestie} extensions={extensions} />
          ) : (
            <Intro>
              <p className="m-0 text-body-sm text-muted" role="status">
                Bestie runs on Builderlab. Turn on the Builderlab plugin in the
                Buzz desktop app to set it up.
              </p>
              <Button
                variant="outline"
                onClick={() =>
                  void navigation.open({
                    version: 1,
                    kind: "settings",
                    section: "plugins",
                  })
                }
              >
                Plugin settings
              </Button>
            </Intro>
          )}
        </div>
      </FullPageSurface>
    </div>
  );
}

function Intro({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto p-6">
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 text-center">
        <img src="/bestie.png" alt="" className="size-20 object-contain" />
        <h2 className="text-heading">Meet your Bestie</h2>
        {children}
      </div>
    </div>
  );
}

function Setup({
  bestie,
  extensions,
}: {
  bestie: RemoteBestie;
  extensions?: ConversationExtensions | undefined;
}) {
  const state = useSyncExternalStore(
    bestie.subscribe,
    bestie.snapshot,
    bestie.snapshot,
  );
  const { record, connection } = state;
  const [home, setHome] = useState<string>();
  const [homeError, setHomeError] = useState("");
  const lifetime = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const complete =
    !!record?.complete &&
    !!record.agent &&
    ["ready", "idle", "error"].includes(state.status);
  // Show the conversation here only after its roster is still just you and Bestie.
  const checkHome = useCallback(async () => {
    const controller = lifetime.current;
    const agent = record?.agent;
    if (
      !record?.complete ||
      !agent ||
      !connection ||
      !controller ||
      controller.signal.aborted
    )
      return;
    const active = () =>
      !controller.signal.aborted &&
      bestie.snapshot().connection === connection &&
      bestie.snapshot().record === record;
    try {
      const details = await connection.session.channelDetails.load(
        record.channelId,
        controller.signal,
      );
      if (!active()) return;
      const channel = await connection.session.workSessions.refreshMembership(
        record.channelId,
      );
      if (!active()) return;
      if (
        details.visibility !== "private" ||
        channel.channelType !== "stream" ||
        channel.archived ||
        !channel.members?.includes(record.owner) ||
        !channel.members.includes(agent) ||
        channel.members.some(
          (member) => member !== record.owner && member !== agent,
        )
      )
        throw new Error(
          "Bestie's channel must be private and contain only you and Bestie. Review its members before continuing.",
        );
      setHomeError("");
      setHome(record.channelId);
    } catch (error) {
      if (!active()) return;
      setHome(undefined);
      setHomeError(
        error instanceof Error
          ? error.message
          : "Could not open Bestie's channel. Try again.",
      );
    }
  }, [bestie, connection, record]);
  useEffect(() => {
    if (complete) void checkHome();
  }, [checkHome, complete]);
  if (complete && connection && home === record.channelId)
    return (
      <>
        <div className="flex flex-wrap items-center gap-3 px-6 py-3">
          <p
            className="m-0 text-body-sm text-muted"
            role={state.status === "error" ? "alert" : "status"}
          >
            {state.status === "error"
              ? state.message
              : "If Bestie doesn't reply, ask your Builderlab workspace admin to allow this community to use inference."}
          </p>
        </div>
        <ChannelPreview
          session={connection.session}
          channelId={home}
          channelName="Bestie"
          extensions={extensions}
          label="Bestie conversation"
        />
      </>
    );
  return (
    <Intro>
      <p
        className="m-0 text-body-sm text-muted"
        role={state.status === "error" ? "alert" : "status"}
      >
        {state.message}
      </p>
      {complete ? (
        <>
          {homeError && (
            <p role="alert" className="m-0 text-body-sm text-danger">
              {homeError}
            </p>
          )}
          <Button variant="prominent" onClick={() => void checkHome()}>
            Open Bestie conversation
          </Button>
        </>
      ) : state.status === "unavailable" ? null : (
        <>
          <p className="m-0 text-body-sm text-muted">
            Setup signs you in to Builderlab, creates or reuses your hosted
            agent named Bestie, replaces its instructions, creates a private
            channel and invites it. If you already customized Bestie's
            instructions, save a copy before continuing.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            {state.status === "choose-agent" ? (
              state.candidates?.map((agent) => (
                <Button
                  key={agent.pubkey}
                  variant="outline"
                  onClick={() => void bestie.setup(agent.pubkey)}
                >
                  Use {agent.name} · {agent.pubkey.slice(0, 12)}
                </Button>
              ))
            ) : (
              <>
                <Button
                  variant="prominent"
                  loading={state.status === "busy"}
                  onClick={() => void bestie.setup()}
                >
                  {state.status === "error"
                    ? "Retry Bestie setup"
                    : "Set up Bestie"}
                </Button>
                {state.status === "error" && state.canCreateNew && (
                  <Button
                    variant="outline"
                    onClick={() =>
                      void bestie.setup(undefined, { createNew: true })
                    }
                  >
                    Create a new Bestie
                  </Button>
                )}
              </>
            )}
          </div>
        </>
      )}
    </Intro>
  );
}
