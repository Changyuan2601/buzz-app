import { useEffect, useRef, useState } from "react";
import type {
  AgentControl,
  AgentView,
  CommunityResolution,
} from "../../features/agents/control";
import { communityRequest } from "../../features/communities/api";
import { communityDestination } from "../../features/communities/destination";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";

export function MoveAgentCommunity({
  agent,
  control,
  owner,
  disabled,
  onMoved,
}: {
  agent: AgentView;
  control: AgentControl;
  owner: string;
  disabled: boolean;
  onMoved(): void;
}) {
  const [destination, setDestination] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const stopped =
    !agent.enabled && (agent.status === "stopped" || agent.status === "failed");
  return (
    <div className="space-y-3">
      <p className="text-body-sm text-subtle">
        Keep this identity and its settings. The original setup is replaced;
        channel history stays in its community. The agent stays stopped after
        moving.
      </p>
      {!stopped && (
        <p className="text-body-sm">Stop the agent before moving.</p>
      )}
      <Field label="Destination community">
        <Input
          value={destination}
          placeholder="wss://community.example"
          disabled={disabled || pending}
          onValueChange={setDestination}
        />
      </Field>
      <Button
        type="button"
        disabled={disabled || pending || !stopped || !destination.trim()}
        onClick={async () => {
          if (disabled || pending || !stopped || !control.moveCommunity) return;
          setPending(true);
          setError(null);
          try {
            const relay = communityDestination(destination.trim()).url;
            if (relay === communityDestination(agent.relayUrl).url)
              throw new Error("Choose a different community.");
            const resolution = await communityRequest<CommunityResolution>(
              relay,
              "resolve-agent-community",
              {
                pubkey: agent.pubkey,
                owner,
                confirmed: true,
              },
            );
            if (!active.current) return;
            await control.moveCommunity(agent.id, agent.revision, resolution);
            if (active.current) onMoved();
          } catch (reason) {
            if (active.current)
              setError(
                reason instanceof Error
                  ? reason.message
                  : "Could not move the agent. Refresh status before retrying.",
              );
          } finally {
            if (active.current) setPending(false);
          }
        }}
      >
        {pending ? "Moving…" : "Move to community"}
      </Button>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
