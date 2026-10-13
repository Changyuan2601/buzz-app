import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
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
import type {} from "../builderlab/service";
import { createRemoteBestie, type RemoteBestie } from "./setup";
import { rhythmsComplete } from "./rhythms";

export const inject = ["pages", "relay", "navigation", "agents"];
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
      return <BestiePage bestie={current} navigation={ctx.navigation} />;
    },
  });
};

export function BestiePage({
  bestie,
  navigation,
}: {
  bestie?: RemoteBestie | undefined;
  navigation: Navigation;
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
          <div className="min-h-0 flex-1 overflow-auto p-6">
            <div className="mx-auto flex max-w-md flex-col items-center gap-4 text-center">
              <img
                src="/bestie.png"
                alt=""
                className="size-20 object-contain"
              />
              <h2 className="text-heading">Meet your Bestie</h2>
              {bestie ? (
                <Setup bestie={bestie} navigation={navigation} />
              ) : (
                <>
                  <p className="m-0 text-body-sm text-muted" role="status">
                    Bestie runs on Builderlab. Turn on the Builderlab plugin in
                    the Buzz desktop app to set it up.
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
                </>
              )}
            </div>
          </div>
        </div>
      </FullPageSurface>
    </div>
  );
}

function Setup({
  bestie,
  navigation,
}: {
  bestie: RemoteBestie;
  navigation: Navigation;
}) {
  const state = useSyncExternalStore(
    bestie.subscribe,
    bestie.snapshot,
    bestie.snapshot,
  );
  const { record, connection } = state;
  const [navigationError, setNavigationError] = useState("");
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
  const openChat = useCallback(async () => {
    const controller = lifetime.current;
    const agent = record?.agent;
    const origin = connection?.origin;
    if (
      !record?.complete ||
      !agent ||
      !connection ||
      !origin ||
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
      const home = await connection.session.workSessions.refreshMembership(
        record.channelId,
      );
      if (!active()) return;
      if (
        details.visibility !== "private" ||
        home.channelType !== "stream" ||
        home.archived ||
        !home.members?.includes(record.owner) ||
        !home.members.includes(agent) ||
        home.members.some(
          (member) => member !== record.owner && member !== agent,
        )
      )
        throw new Error(
          "Bestie's channel must be private and contain only you and Bestie. Review its members before continuing.",
        );
      const result = await navigation.open(
        {
          version: 1,
          kind: "conversation",
          channelId: record.channelId,
          scope: { viewer: record.owner, communityOrigin: origin },
        },
        { replace: true },
      );
      if (active())
        setNavigationError(
          result.status === "failed"
            ? "Could not open Bestie's channel. Try again."
            : "",
        );
    } catch (error) {
      if (active())
        setNavigationError(
          error instanceof Error
            ? error.message
            : "Could not open Bestie's channel. Try again.",
        );
    }
  }, [bestie, navigation, connection, record]);
  // Arriving at a finished setup opens the conversation, as setup itself does.
  useEffect(() => {
    if (state.status === "ready") void openChat();
  }, [openChat, state.status]);
  return (
    <div className="flex flex-col items-center gap-4">
      <p
        className="m-0 text-body-sm text-muted"
        role={state.status === "error" ? "alert" : "status"}
      >
        {state.message}
      </p>
      {complete ? (
        <>
          {navigationError && (
            <p role="alert" className="m-0 text-body-sm text-danger">
              {navigationError}
            </p>
          )}
          <div className="flex flex-wrap justify-center gap-3">
            <Button variant="prominent" onClick={() => void openChat()}>
              Open Bestie conversation
            </Button>
            {!rhythmsComplete(record?.rhythms) && (
              <Button variant="outline" onClick={() => void bestie.setup()}>
                Set up Bestie workflows
              </Button>
            )}
          </div>
          <p className="m-0 text-body-sm text-muted">
            If Bestie doesn't reply, ask your Builderlab workspace admin to
            allow this community to use inference.
          </p>
        </>
      ) : state.status === "unavailable" ? null : (
        <>
          <p className="m-0 text-body-sm text-muted">
            Setup signs you in to Builderlab, creates or reuses your hosted
            agent named Bestie, replaces its instructions, creates a private
            channel and invites it. If you already customized Bestie's
            instructions, save a copy before continuing.
          </p>
          <p className="m-0 text-body-sm text-muted">
            Setup also saves three paused workflows: hourly memory review,
            nightly reflection at 09:00 UTC, and a daily check-in at 17:00 UTC.
            Review them in Workflows. Hosted agents don't answer workflow
            messages yet, so leave them paused.
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
              <Button
                variant="prominent"
                loading={state.status === "busy"}
                onClick={() => void bestie.setup()}
              >
                {state.status === "error"
                  ? "Retry Bestie setup"
                  : "Set up Bestie"}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
