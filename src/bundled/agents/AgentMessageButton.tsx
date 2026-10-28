import { useEffect, useRef, useState } from "react";
import type { Navigation } from "../../features/navigation/controller";
import type { PageNavigation } from "../../features/navigation/service";
import { settingsOf } from "../../features/navigation/targets";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import { Button } from "../../shared/design-system/ui/Button";

/** Open the existing direct conversation without sending a message. */
export function AgentMessageButton({
  pubkey,
  relay,
  navigator,
  navigation,
  variant = "subtle",
}: {
  variant?: "glass" | "subtle";
  pubkey: string;
  relay: RelayData;
  navigator: Navigation | undefined;
  navigation: PageNavigation | undefined;
}) {
  const connection = useRelayConnection(relay);
  const attempt = useRef<AbortController | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: Changing identity or session retires the outstanding open attempt.
  useEffect(() => {
    setOpening(false);
    setError("");
    return () => {
      attempt.current?.abort();
      attempt.current = null;
    };
  }, [pubkey, connection.session, connection.generation, navigation?.signal]);
  const available =
    connection.status === "ready" &&
    connection.session.directMessages.available &&
    !!navigator &&
    !!connection.viewer &&
    !!connection.origin &&
    connection.viewer !== pubkey;
  const open = async () => {
    const { viewer, origin } = connection;
    if (
      !available ||
      !viewer ||
      !origin ||
      !navigator ||
      attempt.current ||
      navigation?.signal.aborted
    )
      return;
    if (
      !connection.session.agentChoices
        .snapshot()
        .identities.some((agent) => agent.managed && agent.pubkey === pubkey)
    ) {
      setError("This agent is not ready to message in this community.");
      return;
    }
    const controller = new AbortController();
    attempt.current = controller;
    const abort = () => controller.abort();
    navigation?.signal.addEventListener("abort", abort, { once: true });
    setOpening(true);
    setError("");
    try {
      const channelId = await connection.session.directMessages.open(
        [pubkey],
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        relay.snapshot().session !== connection.session ||
        // An open that finishes behind the Settings modal must not navigate
        // away from Settings, which would discard its unsaved edits.
        settingsOf(navigator.snapshot().entry.target) !== undefined
      )
        return;
      await navigator.open({
        version: 1,
        kind: "conversation",
        channelId,
        scope: { viewer, communityOrigin: origin },
      });
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not open the conversation. Try again.",
        );
    } finally {
      navigation?.signal.removeEventListener("abort", abort);
      if (attempt.current === controller) attempt.current = null;
      if (!controller.signal.aborted) setOpening(false);
    }
  };
  return (
    <>
      <Button
        size="sm"
        shape="control"
        variant={variant}
        disabled={!available || opening}
        loading={opening}
        onClick={() => void open()}
      >
        Message
      </Button>
      {error && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}
        </p>
      )}
    </>
  );
}
