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
import styles from "./SoloWelcome.module.css";

/** Asks the saved agent for its greeting, a real agent turn that offers the
 * next steps as its own choice. Shows nothing unless the greeting needs the
 * owner to check and retry. */
export function WelcomeGreeting({
  agents,
  session,
  scope,
  receipt,
  signal,
}: {
  agents: Agents;
  session: RelaySession;
  scope: string;
  receipt: WelcomeReceipt;
  signal: AbortSignal;
}) {
  const [busy, setBusy] = useState(false);
  // An owner's retry keeps its button mounted, so focus survives a failure.
  const [retrying, setRetrying] = useState(false);
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
    /** `observe` only looks for a greeting already sent; it asks for none. */
    async (retry = false, observe = false) => {
      if (starting.current || !receipt.agent) return;
      starting.current = true;
      setBusy(true);
      setRetrying(retry && !observe);
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
        if (!greetingId && observe) return;
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
        if (active.current) {
          setBusy(false);
          setRetrying(false);
        }
      }
    },
    [agents, current, receipt.agent, receipt.channelId, scope, session, signal],
  );
  useEffect(() => {
    if (receipt.greeting === "pending" && !receipt.greetingId) void greet();
  }, [greet, receipt.greeting, receipt.greetingId]);
  // A greeting interrupted by a reload may already be in the chat: find it,
  // so setup goes on, before offering a retry.
  const looked = useRef(false);
  useEffect(() => {
    if (looked.current) return;
    looked.current = true;
    if (receipt.greeting === "attempted" && !receipt.greetingId)
      void greet(true, true);
  }, [greet, receipt.greeting, receipt.greetingId]);
  if (
    receipt.greetingId ||
    (!error && !retrying && (busy || receipt.greeting === "pending"))
  )
    return null;
  return (
    <div className={styles.setupControls}>
      <div className={styles.step}>
        <p className="text-body-sm text-subtle" role="status">
          Your agent is saved. Its greeting may still arrive; check before
          trying again.
        </p>
        <Button loading={busy} onClick={() => void greet(true)}>
          Check and retry greeting
        </Button>
        {error && <p role="alert">{error}</p>}
      </div>
    </div>
  );
}
