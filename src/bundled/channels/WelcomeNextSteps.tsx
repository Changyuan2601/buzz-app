import { useCallback, useEffect, useRef, useState } from "react";
import type { Agents } from "../../features/agents/service";
import type { RelaySession } from "../../features/relay/session";
import {
  observedWelcome,
  readWelcome,
  saveWelcome,
  type WelcomeReceipt,
} from "../../features/sessions/welcome";
import { Button } from "../../shared/design-system/ui/Button";
import { WelcomeActions } from "./WelcomeActions";
import styles from "./SoloWelcome.module.css";

/** Post-save work is still a real agent turn; the card is app-owned content. */
export function WelcomeNextSteps({
  agents,
  session,
  scope,
  receipt,
  signal,
  openProfile,
  onSend,
}: {
  agents: Agents;
  session: RelaySession;
  scope: string;
  receipt: WelcomeReceipt;
  signal: AbortSignal;
  openProfile?: ((target: string) => boolean) | undefined;
  onSend?: ((id: string) => void) | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false);
  const starting = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const current = useCallback(() => {
    const value = readWelcome(scope);
    if (
      !value?.complete ||
      value.channelId !== receipt.channelId ||
      value.agent !== receipt.agent ||
      value.type !== receipt.type
    )
      throw new Error("Welcome changed. Reopen the current setup to continue.");
    return value;
  }, [scope, receipt.agent, receipt.channelId, receipt.type]);
  const greet = useCallback(
    async (retry = false) => {
      if (starting.current || !receipt.agent) return;
      starting.current = true;
      setBusy(true);
      setError("");
      try {
        signal.throwIfAborted();
        const saved = current();
        if (
          saved.greetingId ||
          !saved.greeting ||
          (saved.greeting === "attempted" && !retry)
        )
          return;
        const attempted: WelcomeReceipt = {
          ...saved,
          greeting: "attempted",
          greetingAt: saved.greetingAt ?? Math.floor(Date.now() / 1000),
        };
        saveWelcome(scope, attempted);
        const observed = await observedWelcome(
          session,
          attempted,
          signal,
          "saved",
        );
        signal.throwIfAborted();
        let greetingId = observed?.id;
        if (!greetingId) {
          current();
          const reply = await agents.welcome(
            receipt.agent,
            receipt.channelId,
            signal,
            "saved",
          );
          greetingId = reply.id;
        }
        signal.throwIfAborted();
        const latest = current();
        saveWelcome(scope, { ...latest, greetingId });
        session.channels.ensure(receipt.channelId);
      } catch (reason) {
        if (active.current && !signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        starting.current = false;
        if (active.current) setBusy(false);
      }
    },
    [agents, current, receipt.agent, receipt.channelId, scope, session, signal],
  );
  useEffect(() => {
    if (receipt.greeting === "pending" && !receipt.greetingId) void greet();
  }, [greet, receipt.greeting, receipt.greetingId]);
  return (
    <div className={styles.setupControls}>
      {!receipt.greetingId ? (
        <div className={styles.step}>
          <p className="text-body-sm text-subtle" role="status">
            {busy
              ? "Your agent is saying hello…"
              : "Your agent is saved. Its greeting may still arrive; check before trying again."}
          </p>
          {!busy && (
            <Button onClick={() => void greet(true)}>
              Check and retry greeting
            </Button>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      ) : (
        <WelcomeActions
          agents={agents}
          session={session}
          scope={scope}
          receipt={receipt}
          signal={signal}
          openProfile={openProfile}
          onSend={onSend}
        />
      )}
    </div>
  );
}
