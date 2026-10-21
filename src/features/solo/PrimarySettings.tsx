import { useCallback, useEffect, useRef, useState } from "react";
import type { ComposerSession } from "../messages/composer-session";
import { Button } from "../../shared/design-system/ui/Button";
import { Select } from "../../shared/design-system/ui/Select";
import {
  PRIMARY_LABEL,
  type PrimaryBinding,
  type PrimaryState,
} from "./primary";

/** Presentation never authorizes a send; the session resolves again at admission. */
export function usePrimarySettings(
  session: ComposerSession,
  channel: string,
  solo: boolean,
) {
  const cap = session.soloPrimary;
  const summary = session.channels
    .list()
    .channels.find((item) => item.id === channel);
  const labels = summary?.labels?.join("\0");
  const [state, setState] = useState<PrimaryState>();
  const [error, setError] = useState<string>();
  // Keep recovery reachable even when a retry confirms the chat was never adopted.
  const [reload, setReload] = useState<"pending" | "done">();
  const relevant =
    solo ||
    summary?.labels?.includes(PRIMARY_LABEL) ||
    state?.adopted ||
    !!error;
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | undefined>(undefined);
  const scope = useRef<AbortController | undefined>(undefined);
  const pending = useRef(false);
  const refresh = useCallback(
    (retry = false) => {
      if (pending.current) return;
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      if (retry) {
        pending.current = true;
        setReload("pending");
      }
      if (cap)
        void cap
          .load(channel, controller.signal)
          .then((next) => {
            if (!controller.signal.aborted) {
              setState(next);
              setError(undefined);
            }
          })
          .catch((reason) => {
            if (!controller.signal.aborted)
              setError(
                reason instanceof Error ? reason.message : String(reason),
              );
          })
          .finally(() => {
            if (retry && !controller.signal.aborted) {
              pending.current = false;
              setReload("done");
            }
          });
    },
    [cap, channel],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: Capability/channel changes retire saves, label refreshes do not.
  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    setState(undefined);
    setError(undefined);
    setBusy(false);
    setReload(undefined);
    pending.current = false;
    return () => {
      controller.abort();
      active.current?.abort();
    };
  }, [cap, channel]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Label changes refresh presentation without retiring saves.
  useEffect(() => {
    refresh();
    const focus = () => refresh();
    window.addEventListener("focus", focus);
    return () => {
      window.removeEventListener("focus", focus);
    };
  }, [refresh, labels]);
  const agents = cap?.available
    ? session.agentChoices
        .snapshot()
        .selectable.filter((agent) => summary?.members?.includes(agent.pubkey))
    : [];
  const automatic = solo && state?.binding?.mode === "automatic";
  async function save(identity: string, mode: PrimaryBinding["mode"]) {
    if (!cap || !state || pending.current) return;
    active.current?.abort();
    const controller = scope.current;
    if (!controller || controller.signal.aborted) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const next = await cap.save(
        channel,
        state,
        identity,
        solo ? mode : "mention-only",
        controller.signal,
      );
      if (!controller.signal.aborted) setState(next);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!controller.signal.aborted) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  return {
    relevant: relevant || !summary?.labels || !!state?.binding,
    state,
    automatic,
    allowUntagged: !!state?.adopted || !!state?.binding || !!error,
    refresh,
    view:
      (relevant || reload) && cap?.available ? (
        <div className="flex flex-wrap items-center gap-2 px-4 py-1">
          {summary?.creator === session.viewer ? (
            <>
              {!state?.binding && solo && (
                <span className="text-metadata text-secondary">
                  Adopting a primary makes its replies owner-only. Other agents
                  still reply when tagged.
                </span>
              )}
              <Select
                label="Primary agent"
                placeholder="Keep existing replies"
                size="sm"
                value={state?.binding?.identity ?? ""}
                disabled={
                  busy ||
                  reload === "pending" ||
                  !state ||
                  (!solo && (!!state.binding || !state.adopted))
                }
                groups={[
                  {
                    label: "Chat agents",
                    options: agents.map((agent) => ({
                      value: agent.pubkey,
                      label: agent.name,
                    })),
                  },
                ]}
                onValueChange={(identity) =>
                  void save(identity, state?.binding?.mode ?? "automatic")
                }
              />
              {state?.binding && solo && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || reload === "pending"}
                  onClick={() => {
                    if (state.binding)
                      void save(
                        state.binding.identity,
                        automatic ? "mention-only" : "automatic",
                      );
                  }}
                >
                  {automatic ? "Use mentions only" : "Enable automatic replies"}
                </Button>
              )}
            </>
          ) : (
            state?.binding && (
              <span className="text-metadata text-secondary">
                Primary agent · {automatic ? "Automatic" : "Mention-only"}
              </span>
            )
          )}
          {state?.adopted && !state.binding && (
            <span role="alert">
              The primary binding is unavailable. Choose an agent again to
              recover.
            </span>
          )}
          {state?.binding && (
            <span className="text-metadata text-secondary">
              {automatic ? "Automatic" : "Mention-only"} · Owner only · Harness
              defaults
            </span>
          )}
          {error && <span role="alert">{error}</span>}
          {(error || reload) && (
            <Button
              size="sm"
              disabled={busy}
              loading={reload === "pending"}
              onClick={() => refresh(true)}
            >
              Reload primary
            </Button>
          )}
        </div>
      ) : null,
  };
}
