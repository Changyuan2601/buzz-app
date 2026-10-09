import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../relay/session";
import {
  canonicalDetailsName,
  type ChannelDetails,
} from "../relay/channel-details-protocol";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";

/** Existing channel details own authorization, conflict detection and delivery. */
export function RenameSession({
  session,
  id,
  name,
  close,
}: {
  session: RelaySession;
  id: string;
  name: string;
  close(): void;
}) {
  const details = session.channelDetails;
  const attempt = useSyncExternalStore(details.subscribe, () =>
    details.snapshot(id),
  );
  const [value, setValue] = useState(attempt?.draft.name ?? name);
  const [base, setBase] = useState<ChannelDetails>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const pending = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const form = useId();
  const normalized = canonicalDetailsName(value);
  const valid = !!normalized && [...normalized].length <= 120;
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void details
      .load(id, controller.signal)
      .then((next) => {
        if (alive.current) setBase(next);
      })
      .catch((reason) => {
        if (alive.current && !controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, [details, id]);
  const run = async (action: "save" | "reload" | "check") => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (action === "reload") {
        const next = await details.load(id);
        if (alive.current) setBase(next);
      } else {
        if (action === "check") await details.check(id);
        else {
          if (!base?.canEdit || !valid) return;
          await details.save(base, { ...base, name: normalized });
        }
        if (alive.current) close();
      }
    } catch (reason) {
      if (alive.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title="Rename session"
      onOpenChange={(open) => {
        if (!open) close();
      }}
      preventClose={busy}
      initialFocus={input}
      actions={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          {attempt?.status === "unconfirmed" ? (
            <Button disabled={busy} onClick={() => void run("check")}>
              Check saved name
            </Button>
          ) : (
            <Button
              variant="prominent"
              type="submit"
              form={form}
              disabled={busy || !!attempt || !base?.canEdit || !valid}
            >
              Save
            </Button>
          )}
        </>
      }
    >
      <form
        id={form}
        onSubmit={(event) => {
          event.preventDefault();
          if (!attempt) void run("save");
        }}
      >
        <Field
          label="Session name"
          error={!valid ? "Enter a name of 1–120 characters." : undefined}
        >
          <Input
            ref={input}
            value={value}
            disabled={busy || !!attempt}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
        {base && !base.canEdit && (
          <p role="status">You don’t have permission to rename this session.</p>
        )}
        {error && (
          <div role="alert">
            <p>{error}</p>
            {!attempt && (
              <Button disabled={busy} onClick={() => void run("reload")}>
                Reload session details
              </Button>
            )}
          </div>
        )}
      </form>
    </Dialog>
  );
}
