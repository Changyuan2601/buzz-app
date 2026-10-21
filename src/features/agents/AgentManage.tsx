// Owner actions on an agent that every surface showing it offers: the
// Agents Build view and the profile panel.
import { useState, type ReactNode } from "react";
import { TrashIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import type { Agent, Agents } from "./service";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Delete, after a confirmation that says what it does. One that cannot
 * finish keeps the dialog open with what is left; the agent stays listed. */
export function AgentDelete({
  agents,
  agent,
  onRemoved,
  trigger,
}: {
  agents: Agents;
  agent: Agent;
  onRemoved(): void;
  trigger?: (open: () => void) => ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const remove = async () => {
    setRemoving(true);
    setError("");
    try {
      await agents.remove(agent.pubkey);
      setConfirming(false);
      onRemoved();
    } catch (reason) {
      setError(message(reason));
      setRemoving(false);
    }
  };
  return (
    <>
      {trigger ? (
        trigger(() => setConfirming(true))
      ) : (
        <Button
          size="compact"
          variant="ghost"
          onClick={() => setConfirming(true)}
        >
          <TrashIcon size={14} aria-hidden="true" /> Delete agent
        </Button>
      )}
      <Dialog
        size="compact"
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${agent.name}?`}
        description={
          agent.place === "hosted"
            ? "Its provider deletes it and its key, then it leaves every channel and is archived so it no longer appears in member lists or mention suggestions. It can't be undone."
            : "It stops, leaves every channel and is archived so it no longer appears in member lists or mention suggestions, then its key is deleted from this device. It can't be undone."
        }
        preventClose={removing}
        actions={
          <>
            <Button onClick={() => setConfirming(false)} disabled={removing}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={removing}
              onClick={() => void remove()}
            >
              Delete
            </Button>
          </>
        }
      >
        {error ? (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        ) : null}
      </Dialog>
    </>
  );
}

/** Checks again, for an imported agent, that it is not archived in its
 * community, which import could not confirm. */
export function AgentArchiveRetry({
  agents,
  agent,
}: {
  agents: Pick<Agents, "unarchive">;
  agent: Agent;
}) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState("");
  if (!agent.archiveUnchecked && !result) return null;
  const retry = async () => {
    setChecking(true);
    setResult("");
    try {
      setResult((await agents.unarchive(agent.pubkey)) ?? "");
    } catch (reason) {
      setResult(`Couldn't check whether it's archived: ${message(reason)}`);
    } finally {
      setChecking(false);
    }
  };
  return (
    <PreferenceRow
      title="Archive state"
      subtitle={
        result ||
        "Not checked since import, so it may be hidden from member lists and mentions."
      }
      trailing={
        agent.archiveUnchecked ? (
          <Button
            size="compact"
            loading={checking}
            onClick={() => void retry()}
          >
            Retry
          </Button>
        ) : undefined
      }
    />
  );
}
