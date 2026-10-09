import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "../../../shared/design-system/ui/Button";
import { Field } from "../../../shared/design-system/ui/Field";
import { Input } from "../../../shared/design-system/ui/Input";
import { Textarea } from "../../../shared/design-system/ui/Textarea";
import { AlertDialog } from "../../../shared/design-system/ui/AlertDialog";
import type { LoginSnapshot, OAuthSession } from "../oauth/session";
import {
  MAX_INSTRUCTIONS_LENGTH,
  type AgentClient,
  type RemoteAgent,
  validInstructions,
} from "./client";
import type { AgentEnrollment } from "./enrollment";

export function RemoteAgents({
  client,
  session,
  active,
  enrollment,
}: {
  client: AgentClient;
  session: OAuthSession;
  active(): boolean;
  enrollment: AgentEnrollment;
}) {
  const login = useSyncExternalStore(session.subscribe, session.snapshot);
  return login.status === "signed-in" ? (
    <AgentList
      key={login.account?.subject}
      client={client}
      account={login.account}
      active={active}
      enrollment={enrollment}
    />
  ) : null;
}

function AgentList({
  client,
  account,
  active,
  enrollment,
}: {
  client: AgentClient;
  account: LoginSnapshot["account"];
  active(): boolean;
  enrollment: AgentEnrollment;
}) {
  const connection = useSyncExternalStore(
    enrollment.subscribe,
    enrollment.snapshot,
  );
  const [revision, setRevision] = useState(0);
  const [agents, setAgents] = useState<readonly RemoteAgent[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  // Drafts stay local across refresh/setup retries, never in persisted enrollment.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<readonly string[]>([]);
  const [confirmed, setConfirmed] = useState<readonly string[]>([]);
  const [deleting, setDeleting] = useState<RemoteAgent>();
  const [removing, setRemoving] = useState<readonly string[]>([]);
  const operation = useRef<AbortController | null>(null);
  const focusRequested = useRef<string | null>(null);
  const focusTargets = useRef(new Map<string, HTMLElement>());
  const focusTarget = (pubkey: string, node: HTMLElement | null) => {
    if (node) focusTargets.current.set(pubkey, node);
    else focusTargets.current.delete(pubkey);
  };
  // Each row's target is its textarea while editing, otherwise its Edit button.
  // Wait for saving to finish so the target is enabled before handing off focus.
  useLayoutEffect(() => {
    if (focusRequested.current && !busy && !loading) {
      if (active()) focusTargets.current.get(focusRequested.current)?.focus();
      focusRequested.current = null;
    }
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: Account changes and explicit refreshes must restart the read.
  useEffect(() => {
    focusRequested.current = null;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(false);
    setName("");
    setLoading(true);
    setAgents(undefined);
    setError(undefined);
    setPending([]);
    setConfirmed([]);
    setDeleting(undefined);
    setRemoving([]);
    const current = () => !controller.signal.aborted && active();
    void (async () => {
      try {
        const rows = await client.list(controller.signal);
        if (!current()) return;
        setAgents(rows);
        setRemoving(
          rows
            .filter((row) => enrollment.deleting(row))
            .map((row) => row.pubkey),
        );
        const intended = enrollment.pending(rows);
        setPending(intended);
        setLoading(false);
        setBusy(true);
        try {
          await enrollment.recover(rows, controller.signal, active);
        } finally {
          if (current()) {
            const remaining = enrollment.pending(rows);
            setPending(remaining);
            setConfirmed(intended.filter((key) => !remaining.includes(key)));
          }
        }
      } catch (reason) {
        if (current()) {
          setError(
            reason instanceof Error ? reason.message : "Could not load agents.",
          );
          setLoading(false);
        }
      } finally {
        if (current()) setBusy(false);
      }
    })();
    return () => controller.abort();
  }, [client, account, revision, connection, enrollment]);
  const run = async (
    work: (signal: AbortSignal, current: () => boolean) => Promise<void>,
    failure: string,
  ) => {
    const signal = operation.current?.signal;
    if (!signal || signal.aborted || busy || loading || !active()) return;
    const current = () => !signal.aborted && active();
    setBusy(true);
    setError(undefined);
    try {
      await work(signal, current);
    } catch (reason) {
      if (current())
        setError(reason instanceof Error ? reason.message : failure);
    } finally {
      if (current()) setBusy(false);
    }
  };
  const setDraft = (pubkey: string, value: string) =>
    setDrafts((rows) => ({ ...rows, [pubkey]: value }));
  const discardDraft = (pubkey: string) =>
    setDrafts((rows) => {
      const next = { ...rows };
      delete next[pubkey];
      return next;
    });
  const saveInstructions = async (
    agent: RemoteAgent,
    value: string,
    signal: AbortSignal,
    current: () => boolean,
  ) => {
    if (!current()) return;
    if (enrollment.deleting(agent))
      throw new Error("Agent deletion has started. Refresh agents.");
    await client.updateInstructions(agent, value, signal);
    if (!current()) return;
    if (enrollment.deleting(agent))
      throw new Error("Agent deletion has started. Refresh agents.");
    setAgents((rows) =>
      rows?.map((row) =>
        row.id === agent.id ? { ...row, instructions: value } : row,
      ),
    );
    discardDraft(agent.pubkey);
  };
  const saveDraft = (agent: RemoteAgent) => {
    const value = drafts[agent.pubkey];
    if (value !== undefined) {
      focusRequested.current = agent.pubkey;
      return run(
        (signal, current) => saveInstructions(agent, value, signal, current),
        "Could not save agent instructions.",
      );
    }
  };
  const change = (agent?: RemoteAgent) =>
    run(async (signal, current) => {
      const show = (row: RemoteAgent) =>
        setAgents((rows) => [
          ...(rows ?? []).filter((item) => item.id !== row.id),
          row,
        ]);
      const value = agent
        ? drafts[agent.pubkey]
        : instructions.trim()
          ? instructions
          : undefined;
      const context = enrollment.capture();
      if (agent?.status === "Active") {
        const id = agent.id;
        const rows = await client.list(signal);
        if (!current() || !enrollment.current(context)) return;
        setAgents(rows);
        agent = rows.find((row) => row.id === id);
        if (agent?.status !== "Active")
          throw new Error("Agent is no longer Active. Refresh agents.");
        if (!enrollment.pending(rows).includes(agent.pubkey)) return;
      }
      const registered = agent ?? (await client.register(name, signal));
      if (!current() || !enrollment.current(context)) return;
      show(registered);
      if (!agent) {
        setName("");
        setInstructions("");
        if (value !== undefined) setDraft(registered.pubkey, value);
      }
      enrollment.remember(context, registered);
      if (context)
        setPending((rows) => [...new Set([...rows, registered.pubkey])]);
      const ready =
        registered.status === "Active"
          ? registered
          : await client.attest(
              registered,
              signal,
              () =>
                active() &&
                enrollment.current(context) &&
                !enrollment.deleting(registered),
              context?.viewer,
            );
      if (!current() || !enrollment.current(context)) return;
      show(ready);
      await enrollment.publish(context, ready, signal, active);
      if (current()) {
        setPending((rows) => rows.filter((key) => key !== ready.pubkey));
        if (context) setConfirmed((rows) => [...rows, ready.pubkey]);
      }
      // Community retries must not submit an open instruction edit.
      if (
        agent?.status !== "Active" &&
        enrollment.current(context) &&
        value !== undefined
      )
        await saveInstructions(ready, value, signal, current);
    }, "Could not create the agent. Retry the same name.");
  const remove = (agent: RemoteAgent) => {
    setDeleting(undefined);
    return run(async (signal, current) => {
      setRemoving((rows) => [...new Set([...rows, agent.pubkey])]);
      try {
        await enrollment.remove(agent, client, signal, active);
      } finally {
        if (current()) {
          if (enrollment.deleting(agent))
            setConfirmed((rows) => rows.filter((key) => key !== agent.pubkey));
          else
            setRemoving((rows) => rows.filter((key) => key !== agent.pubkey));
        }
      }
      if (current()) {
        discardDraft(agent.pubkey);
        setRevision((value) => value + 1);
      }
    }, "Could not delete the agent. Retry Delete.");
  };
  return (
    <section
      data-buzz-ui=""
      className="mt-6 flex flex-col gap-3"
      aria-label="Remote agents"
    >
      <h3 className="text-heading-sm text-primary">Remote agents</h3>
      <form
        className="flex flex-col items-start gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void change();
        }}
      >
        <Field
          label="Agent name"
          description="Up to 64 letters, numbers, spaces, dots, hyphens or underscores."
        >
          <Input
            value={name}
            onValueChange={setName}
            maxLength={64}
            required
            disabled={busy || loading}
          />
        </Field>
        <Field label="Agent instructions (optional)" style={{ width: "100%" }}>
          <Textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            maxLength={MAX_INSTRUCTIONS_LENGTH}
            rows={4}
            disabled={busy || loading}
          />
        </Field>
        <Button
          type="submit"
          variant="prominent"
          loading={busy}
          disabled={loading || !name.trim()}
        >
          Create agent
        </Button>
      </form>
      {loading && (
        <p role="status" className="text-body-sm text-secondary">
          Loading remote agents…
        </p>
      )}
      {error && (
        <p role="alert" className="text-body-sm text-danger">
          {error}
        </p>
      )}
      {agents?.length === 0 && (
        <p className="text-body-sm text-secondary">No remote agents yet.</p>
      )}
      {agents && agents.length > 0 && (
        <ul className="flex flex-col gap-3">
          {agents.map((agent) => (
            <li key={agent.id} className="flex flex-col gap-1">
              <div className="text-body-sm text-primary">
                {agent.name} · {agent.status}
              </div>
              <span className="break-all text-mono text-secondary">
                {agent.pubkey}
              </span>
              {pending.includes(agent.pubkey) &&
                !removing.includes(agent.pubkey) && (
                  <p className="text-body-sm text-secondary">
                    Community registration pending.
                  </p>
                )}
              {removing.includes(agent.pubkey) && (
                <p className="text-body-sm text-secondary">
                  Deletion pending. Retry Delete.
                </p>
              )}
              {confirmed.includes(agent.pubkey) && (
                <p className="text-body-sm text-secondary">
                  Registration confirmed in this community.
                </p>
              )}
              {agent.status === "Active" &&
                pending.includes(agent.pubkey) &&
                !removing.includes(agent.pubkey) && (
                  <Button
                    variant="outline"
                    disabled={busy || loading}
                    onClick={() => void change(agent)}
                  >
                    Retry community setup
                  </Button>
                )}
              {agent.status === "Unattested" &&
                !removing.includes(agent.pubkey) && (
                  <div>
                    <Button
                      variant="outline"
                      disabled={busy || loading}
                      onClick={() => void change(agent)}
                    >
                      Finish setup
                    </Button>
                  </div>
                )}
              {agent.status === "Active" &&
                !removing.includes(agent.pubkey) &&
                drafts[agent.pubkey] !== undefined && (
                  <div className="flex flex-col items-start gap-2">
                    <Field
                      label={`Agent instructions for ${agent.name}`}
                      style={{ width: "100%" }}
                    >
                      <Textarea
                        ref={(node) => focusTarget(agent.pubkey, node)}
                        value={drafts[agent.pubkey]}
                        onChange={(event) =>
                          setDraft(agent.pubkey, event.target.value)
                        }
                        maxLength={MAX_INSTRUCTIONS_LENGTH}
                        rows={4}
                        disabled={busy || loading}
                      />
                    </Field>
                    <div className="flex gap-2">
                      <Button
                        disabled={
                          busy ||
                          loading ||
                          !validInstructions(drafts[agent.pubkey]) ||
                          drafts[agent.pubkey] === (agent.instructions ?? "")
                        }
                        onClick={() => void saveDraft(agent)}
                      >
                        Save instructions
                      </Button>
                      <Button
                        disabled={busy || loading}
                        onClick={() => {
                          focusRequested.current = agent.pubkey;
                          discardDraft(agent.pubkey);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              <div className="flex gap-2">
                {agent.status === "Active" &&
                  !removing.includes(agent.pubkey) &&
                  drafts[agent.pubkey] === undefined && (
                    <Button
                      ref={(node) => focusTarget(agent.pubkey, node)}
                      variant="outline"
                      disabled={busy || loading}
                      onClick={() => {
                        focusRequested.current = agent.pubkey;
                        setDraft(agent.pubkey, agent.instructions ?? "");
                      }}
                    >
                      Edit
                    </Button>
                  )}
                <Button
                  variant="destructive"
                  disabled={busy || loading}
                  onClick={() => setDeleting(agent)}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button
          variant="outline"
          loading={loading}
          disabled={busy}
          onClick={() => {
            if (active()) setRevision((value) => value + 1);
          }}
        >
          {error ? "Retry" : "Refresh agents"}
        </Button>
      </div>
      {deleting && (
        <AlertDialog
          title={`Delete ${deleting.name}?`}
          description="This permanently deletes the remote agent"
          onClose={() => setDeleting(undefined)}
          actions={
            <>
              <Button onClick={() => setDeleting(undefined)}>Cancel</Button>
              <Button
                variant="destructive"
                disabled={busy || loading}
                onClick={() => void remove(deleting)}
              >
                Delete
              </Button>
            </>
          }
        />
      )}
    </section>
  );
}
