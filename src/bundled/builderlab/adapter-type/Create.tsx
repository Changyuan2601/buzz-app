import { useSyncExternalStore } from "react";
import type { AgentCreateProps } from "../../../features/agents/service";
import { Button } from "../../../shared/design-system/ui/Button";
import type { OAuthSession } from "../oauth/session";

/** Create agent waits on the browser sign-in; this is the way out of that wait. */
export function createCreatePanel(session: OAuthSession) {
  return function Create(_: AgentCreateProps) {
    const state = useSyncExternalStore(
      session.subscribe,
      session.snapshot,
      session.snapshot,
    );
    return state.status === "pending" ? (
      <div className="flex flex-col items-start gap-3">
        <p role="status" className="m-0 text-body-sm text-secondary">
          Finish sign-in in your browser, then return to Buzz.
        </p>
        <Button onClick={session.cancel}>Cancel sign-in</Button>
      </div>
    ) : (
      <p className="m-0 text-body-sm text-secondary">
        Its provider keeps its key and runs it, whether or not this app is open.
      </p>
    );
  };
}
