import { useEffect, useRef, useState } from "react";
import type { Agents } from "../../features/agents/service";
import {
  welcomeActions,
  type WelcomeAction,
} from "../../features/agents/onboarding";
import type { RelaySession } from "../../features/relay/session";
import { profileTarget } from "../../features/profiles/target";
import {
  readWelcome,
  type WelcomeReceipt,
} from "../../features/sessions/welcome";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import styles from "./SoloWelcome.module.css";

export function WelcomeActions({
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
  const pending = useRef(false);
  const active = useRef(false);
  const attempt = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      attempt.current?.abort();
    };
  }, []);
  const current = () => {
    const value = readWelcome(scope);
    if (
      !value?.complete ||
      !value.greetingId ||
      value.agent !== receipt.agent ||
      value.channelId !== receipt.channelId
    )
      throw new Error("Welcome changed. Reopen the current setup to continue.");
    return value;
  };
  const open = () => {
    const target =
      receipt.agent && profileTarget(receipt.agent, { agent: true });
    if (!target || !openProfile?.(target)) {
      setError(
        "Agent details are unavailable here. Enable Profiles in Settings → Plugins, then try again.",
      );
      return false;
    }
    return true;
  };
  const run = async (key: WelcomeAction) => {
    if (pending.current || !receipt.agent) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const abort = new AbortController();
    attempt.current = abort;
    try {
      current();
      const id = await agents.welcomeAction(
        receipt.agent,
        receipt.channelId,
        key,
        AbortSignal.any([signal, abort.signal]),
      );
      onSend?.(id);
      session.channels.ensure(receipt.channelId);
    } catch (reason) {
      if (active.current && !signal.aborted)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  };
  return (
    <section
      className={`${styles.step} ${styles.stepCard}`}
      aria-label="Get started"
    >
      <div className={styles.cardHeader}>
        <InlineHeader title="Where would you like to start?" level={2} />
      </div>
      <div className={styles.cardBody}>
        <p className="text-body-sm text-subtle">
          Here are a few ideas, or just start chatting.
        </p>
        {welcomeActions.map(([key, label]) => (
          <Button
            key={key}
            disabled={busy}
            onClick={() => {
              if (key === "customize" && !open()) return;
              void run(key);
            }}
          >
            {label}
          </Button>
        ))}
        {error && <p role="alert">{error}</p>}
      </div>
    </section>
  );
}
