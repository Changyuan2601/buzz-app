import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Agents } from "../../features/agents/service";
import { Button } from "../../shared/design-system/ui/Button";
import { useToastNotification } from "../../shared/design-system/ui/Toast";

const PENDING = {
  archiving: "Deleting… it stays stopped and keeps trying while connected.",
  recovering: "Recovering… it starts once its config channel is active again.",
} as const;

/** Agents Delete archived (plan §8.1): same key, row and settings, so
 * Recover brings each back with its config history. */
export function DeletedAgentsSettings({
  agents,
  active,
}: {
  agents: Pick<Agents, "snapshot" | "subscribe" | "recover">;
  active(): boolean;
}) {
  const state = useSyncExternalStore(
    agents.subscribe,
    agents.snapshot,
    agents.snapshot,
  );
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const notify = useToastNotification();
  const heading = useRef<HTMLHeadingElement>(null);
  /** The agent last asked to recover: owns `error` until its row leaves. */
  const recovering = useRef("");
  /** Agents this card asked to recover, announced once running as active:
   * a row also leaves while its community is disconnected. */
  const requested = useRef(new Set<string>());
  /** The row holding keyboard focus, kept when its removal drops it. */
  const owner = useRef("");
  const deleted = state.running.filter((agent) => agent.lifecycle);
  const shown = useRef(deleted);
  useEffect(() => {
    const left = shown.current.filter(
      (row) => !deleted.some((agent) => agent.pubkey === row.pubkey),
    );
    shown.current = deleted;
    for (const agent of state.running)
      if (!agent.lifecycle && requested.current.delete(agent.pubkey))
        notify(`Recovered ${agent.name}.`, "success");
    if (!left.length) return;
    // Recovered, now or on a later reconnect: its row, with Recover, is gone.
    const pubkeys = new Set(left.map((row) => row.pubkey));
    if (pubkeys.has(recovering.current)) {
      recovering.current = "";
      setError("");
    }
    if (pubkeys.has(owner.current)) {
      owner.current = "";
      if (document.activeElement === document.body) heading.current?.focus();
    }
  });
  const recover = async (pubkey: string) => {
    if (!active() || busy) return;
    setBusy(pubkey);
    setError("");
    recovering.current = pubkey;
    requested.current.add(pubkey);
    try {
      await agents.recover(pubkey);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy("");
    }
  };
  return (
    <div data-buzz-ui="" className="flex flex-col items-start gap-4">
      <div>
        <h2 ref={heading} tabIndex={-1} className="text-heading text-primary">
          Deleted agents
        </h2>
        <p className="mt-2 text-body-sm text-secondary">
          Deleting an agent archives its config channel and stops it. Its key
          and config history are kept, so it can be recovered here.
        </p>
      </div>
      {deleted.length === 0 ? (
        <p role="status" className="text-body-sm text-secondary">
          No deleted agents.
        </p>
      ) : (
        <ul className="m-0 flex w-full list-none flex-col gap-2 p-0">
          {deleted.map((agent) => (
            <li
              key={agent.pubkey}
              className="flex items-center gap-3"
              onFocus={() => {
                owner.current = agent.pubkey;
              }}
              onBlur={(event) => {
                // A removed row's blur keeps it the owner of the lost focus.
                if (event.target.isConnected) owner.current = "";
              }}
            >
              <span className="flex-1 text-body">
                {agent.name}
                {agent.lifecycle !== "archived" && (
                  <span className="block text-body-sm text-secondary">
                    {PENDING[agent.lifecycle ?? "archiving"]}
                  </span>
                )}
              </span>
              {/* Kept while it recovers, so a refusal leaves focus on it. */}
              {agent.lifecycle !== "archiving" && (
                <Button
                  size="compact"
                  loading={
                    busy === agent.pubkey || agent.lifecycle === "recovering"
                  }
                  disabled={!!busy && busy !== agent.pubkey}
                  onClick={() => void recover(agent.pubkey)}
                >
                  Recover
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
